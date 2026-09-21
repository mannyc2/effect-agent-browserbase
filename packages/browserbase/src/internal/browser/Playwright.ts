import { Schema } from "effect";
import type {
  Browser,
  BrowserContext,
  CDPSession,
  Dialog,
  Disposable,
  Frame,
  Page,
} from "playwright-core";

import type { PageInfo, PageSuspension } from "../../BrowserData.ts";
import { BrowserError, InitializationError } from "../../Errors.ts";
import { Identifier } from "../../References.ts";
import { makeActions } from "./Actions.ts";
import type { CompiledBootstrap } from "./Bootstrap.ts";
import { CallbackTasks } from "./CallbackTasks.ts";
import type {
  CaptureBinding,
  CaptureInvalidation,
  CaptureSource,
  CaptureTarget,
  Driver,
  DriverEvents,
  DriverOptions,
  NativeFrame,
  ReadinessState,
} from "./Driver.ts";
import { makeNativeBindings } from "./NativeBindings.ts";
import { closeWithin, failure, safeDecode, sanitize } from "./NativeCalls.ts";
import { makeObservation } from "./Observation.ts";
import type { Ticket } from "./Owner.ts";
import { PageExecution } from "./PageExecution.ts";
import { type Entry, makeTargets } from "./Targets.ts";

const NativeWindow = Schema.Struct({ windowId: Schema.Natural });

interface CaptureWatcher {
  readonly frameId: string;
  readonly invalidate: (reason: CaptureInvalidation) => void;
}

/**
 * The provider-issued address is accepted only as a credential-free Browserbase WSS URL. Every
 * binding applies this first, including one a host routes elsewhere, so routing can never be
 * reached with an address the provider did not plausibly issue.
 */
export const validateConnection = (connection: unknown): string => {
  if (typeof connection !== "string" || connection.length > 16384)
    throw failure("connect", "malformed");
  let url: URL;

  try {
    url = new URL(connection);
  } catch {
    throw failure("connect", "malformed");
  }
  if (
    url.protocol !== "wss:" ||
    url.username ||
    url.password ||
    url.port ||
    !url.hostname.endsWith(".browserbase.com")
  )
    throw failure("connect", "unsafe-url");

  return connection;
};

/**
 * Connects to an already validated or host-resolved CDP endpoint and builds the one driver. The
 * import is lazy, so constructing any Layer cannot load Playwright or allocate a browser. A
 * trusted observer sees the engine's browser before the driver exists and never replaces it.
 */
export const connectPlaywrightEndpoint = async (
  endpoint: string,
  signal: AbortSignal,
  options: DriverOptions,
  events: DriverEvents,
  observe?: (browser: Browser) => void,
): Promise<Driver> => {
  if (signal.aborted) throw failure("connect", "interrupted");
  const { chromium } = await import("playwright-core");

  const browser = await sanitize("connect", () =>
    chromium.connectOverCDP(endpoint, {
      timeout: 15000,
      ...(options.pageControl ? { noDefaults: true } : {}),
    }),
  );

  if (signal.aborted) {
    await closeWithin(() => browser.close()).catch(() => {});
    throw failure("connect", "interrupted");
  }
  try {
    observe?.(browser);
    const driver = await makePlaywrightDriver(browser, options, events);

    if (signal.aborted) {
      await driver.disconnect().catch(() => {});
      throw failure("connect", "interrupted");
    }

    return driver;
  } catch (error) {
    await closeWithin(() => browser.close()).catch(() => {});
    throw Schema.is(BrowserError)(error) || Schema.is(InitializationError)(error)
      ? error
      : failure("connect", "provider");
  }
};

/** Tests may supply a real already-connected browser. This is deliberately not an exported subpath. */
export const makePlaywrightDriver = async (
  browser: Browser,
  options: DriverOptions,
  events: DriverEvents,
): Promise<Driver> => {
  const contexts = browser.contexts();

  if (contexts.length !== 1) throw failure("context", "ambiguous");
  const context: BrowserContext = contexts[0];
  const registeredEpochs = new WeakMap<Frame, number>();
  const readyDocuments = new WeakMap<Frame, number>();
  const dialogs = new Set<Dialog>();
  const callbacks = new CallbackTasks(32, () => events.fault());
  const captureWatchers = new Map<string, Set<CaptureWatcher>>();

  let closing = false;
  let initialized = false;
  let browserCdp: CDPSession | undefined;
  const registrations: Disposable[] = [];
  let initializationClosed = false;
  let initializationDisposal: Promise<void> | undefined;

  const initializationFault = (error: InitializationError) => {
    if (closing || initializationClosed) return;
    if (options.onBindingFault === undefined) events.fault();
    else options.onBindingFault(error);
  };

  const bindingTask = (action: () => Promise<void>) => {
    const admitted = callbacks.submit(async () => {
      try {
        await action();
      } catch (cause) {
        initializationFault(
          Schema.is(InitializationError)(cause)
            ? cause
            : InitializationError.make({
                operation: "register",
                step: "bindings",
                reason: "native",
              }),
        );
      }
    }, "reject-call");

    if (!admitted)
      initializationFault(
        InitializationError.make({ operation: "register", step: "bindings", reason: "busy" }),
      );
  };

  const bindings =
    options.bindings === undefined || options.bindings.length === 0
      ? undefined
      : makeNativeBindings(context, options.bindings, () =>
          initializationFault(
            InitializationError.make({ operation: "register", step: "bindings", reason: "busy" }),
          ),
        );

  const attachBindings = async (page: Page) => {
    if (bindings === undefined) return;
    await bindings.attach(page, page);
    for (const frame of page.frames())
      if (frame !== page.mainFrame()) await bindings.attach(frame, page);
  };

  const fenceInitialization = () => {
    initializationClosed = true;
    bindings?.close();
  };

  const disposeInitialization = (): Promise<void> => {
    fenceInitialization();
    initializationDisposal ??= (async () => {
      const outcomes = await Promise.allSettled([
        ...registrations.splice(0).map((registration) => registration.dispose()),
        ...(bindings === undefined ? [] : [bindings.dispose()]),
      ]);

      if (outcomes.some((result) => result.status === "rejected"))
        throw failure("dispose-initialization", "provider");
    })();

    return initializationDisposal;
  };

  const invalidateCaptures = (entry: Entry, reason: CaptureInvalidation, frame?: Frame): void => {
    const watchers = captureWatchers.get(entry.id);

    if (watchers === undefined) return;
    const changedFrameId = frame === undefined ? undefined : frameId(frame);
    const mainFrameId = frameId(entry.page.mainFrame());

    for (const watcher of [...watchers]) {
      if (
        frame === undefined ||
        changedFrameId === mainFrameId ||
        changedFrameId === watcher.frameId
      )
        watcher.invalidate(reason);
    }
  };

  const targets = makeTargets(browser, context, options, callbacks, events, () => closing, {
    opened: (entry, created) => {
      if (initialized && options.pageControl)
        callbacks.submit(async () => {
          await executionFor(entry);
        });
      if (initialized && bindings !== undefined) bindingTask(() => attachBindings(entry.page));
      if (initialized && !created) {
        if (options.popupPolicy === "close")
          callbacks.submit(() => closeWithin(() => entry.page.close()));
        else if (options.popupPolicy === "pause") events.pause();
      }
    },
    closed: (entry) => {
      entry.executionValue?.invalidate();
      if (entry.execution !== undefined)
        callbacks.submit(async () => {
          await (await entry.execution)?.dispose();
        });
      invalidateCaptures(entry, "target-changed");
      captureWatchers.delete(entry.id);
    },
    navigating: (entry, frame) => {
      if (frame === entry.page.mainFrame() && entry.executionValue?.invalidate()) events.fault();
    },
    navigated: (entry, frame) => {
      if (initialized && bindings !== undefined)
        bindingTask(() => bindings.attach(frame, entry.page));
    },
    frameChanged: (entry, frame) => {
      invalidateCaptures(entry, "target-changed", frame);
    },
    dialog: (dialog) => {
      if (options.dialogPolicy === "dismiss")
        callbacks.submit(() => closeWithin(() => dialog.dismiss()));
      else if (dialogs.size >= 8) {
        events.fault();
        callbacks.submit(() => closeWithin(() => dialog.dismiss()));
      } else {
        dialogs.add(dialog);
        observation.invalidate();
        events.pause();
      }
    },
    release: () => observation.dispose(),
    changed: (reason) => observation.changed(reason),
  });

  const { current, entries, epochOf, frameId, register } = targets;
  const observation = makeObservation(targets, events);
  const actions = makeActions(context, targets, observation);

  const onPage = (page: Page) => {
    register(page);
  };

  const onDisconnected = () => {
    if (!closing) {
      observation.invalidate();
      events.disconnected();
    }
  };

  context.on("page", onPage);
  browser.on("disconnected", onDisconnected);

  const sizeNativeContents = async (entry: Entry): Promise<void> => {
    if (browserCdp === undefined) throw failure("viewport", "closed", "undispatched");
    const targetId = await targets.targetId(entry);
    const current: unknown = await browserCdp.send("Browser.getWindowForTarget", { targetId });
    const native = safeDecode(NativeWindow, current, "viewport");

    await browserCdp.send("Browser.setContentsSize", {
      windowId: native.windowId,
      width: options.viewport.width,
      height: options.viewport.height,
    });
  };

  /**
   * Registrations are installed once per connection and before this connection creates any
   * document. Documents that were already running keep their recorded epoch, so the readiness
   * policy can tell them apart from documents that actually ran the bundle.
   */
  const installBootstrap = async (bootstrap: CompiledBootstrap | undefined) => {
    for (const entry of entries.values())
      for (const frame of entry.page.frames()) registeredEpochs.set(frame, epochOf(frame));
    // Host capabilities precede the bundle: a step may depend on a granted capability.
    for (const grant of bootstrap?.permissions ?? [])
      await context.grantPermissions([...grant.permissions], { origin: grant.origin });

    // One bundle guarantees callable wrappers exist before dependent init steps. Ordering
    // between two Playwright addInitScript registrations is intentionally not assumed.
    const content = [bindings?.bundle, bootstrap?.bundle]
      .filter((part) => part !== undefined)
      .join("\n");

    if (content.length > 0) {
      const registration = await context.addInitScript({ content });

      if (initializationClosed) await registration.dispose();
      else registrations.push(registration);
    }
  };

  const documentOrigin = (frame: Frame): string => {
    try {
      const url = new URL(frame.url());

      return ["http:", "https:"].includes(url.protocol) ? url.origin : "";
    } catch {
      return "";
    }
  };

  /** A finite wait for a page promise. Native work continues; only this wait is bounded. */
  const evaluateWithin = async (
    frame: Frame,
    expression: string,
    milliseconds: number,
  ): Promise<unknown> => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      return await Promise.race([
        frame.evaluate(expression),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(failure("ready", "timeout")), milliseconds);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  const readiness = async (
    bootstrap: CompiledBootstrap,
    ticket: Ticket,
  ): Promise<ReadinessState> => {
    const { frame } = current();
    const epoch = epochOf(frame);

    if (readyDocuments.get(frame) === epoch) return { _tag: "Ready" };
    ticket.check();
    // A document that predates registration never ran the bundle; saying so is the contract.
    if (epoch <= (registeredEpochs.get(frame) ?? -1)) {
      if (bootstrap.existingDocuments === "RequireFreshNavigation")
        return { _tag: "RequiresNavigation" };
    }
    const origin = documentOrigin(frame);

    const applicable = bootstrap.readiness.filter(
      (requirement) => requirement.origins === undefined || requirement.origins.includes(origin),
    );

    if (applicable.length === 0) {
      readyDocuments.set(frame, epoch);

      return { _tag: "NotApplicable" };
    }

    for (const requirement of applicable) {
      const budget = Math.max(1, Math.min(requirement.timeoutMillis, ticket.remainingMillis()));
      let value: unknown;

      try {
        value = await evaluateWithin(frame, requirement.expression, budget);
      } catch (error) {
        if (epochOf(frame) !== epoch || frame.isDetached())
          return { _tag: "NotReady", step: requirement.step, reason: "stale" };

        return {
          _tag: "NotReady",
          step: requirement.step,
          reason:
            Schema.is(BrowserError)(error) && error.reason === "timeout" ? "timeout" : "failed",
        };
      }
      ticket.check();
      // A completed wait cannot ready a document that replaced the one it observed.
      if (epochOf(frame) !== epoch)
        return { _tag: "NotReady", step: requirement.step, reason: "stale" };
      if (value !== true) return { _tag: "NotReady", step: requirement.step, reason: "failed" };
    }
    readyDocuments.set(frame, epoch);

    return { _tag: "Ready" };
  };

  const executionFor = (entry: Entry): Promise<PageExecution> => {
    if (!options.pageControl)
      return Promise.reject(failure("page-control", "unsupported", "undispatched"));
    entry.execution ??= sanitize("page-control", async () => {
      const cdp = await context.newCDPSession(entry.page);

      try {
        const targetId = await targets.targetId(entry);

        if (closing || entry.page.isClosed()) throw failure("page-control", "closed");
        await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
        if (closing || entry.page.isClosed()) throw failure("page-control", "closed");

        const control = new PageExecution(entry.id, targetId, {
          readRate: async () =>
            safeDecode(
              Schema.Struct({ playbackRate: Schema.Finite }),
              await cdp.send("Animation.getPlaybackRate"),
              "page-rate",
            ).playbackRate,
          rate: async (playbackRate) => {
            await cdp.send("Animation.setPlaybackRate", { playbackRate });
          },
          focus: async (enabled) => {
            await cdp.send("Emulation.setFocusEmulationEnabled", { enabled });
          },
          lifecycle: async (state) => {
            await cdp.send("Page.setWebLifecycleState", { state });
          },
          activate: async () => {
            await cdp.send("Page.bringToFront");
          },
          closed: () => closing || !browser.isConnected() || entry.page.isClosed(),
          detach: async () => {
            if (entry.page.isClosed() || !browser.isConnected()) return;
            try {
              await closeWithin(() => cdp.detach());
            } catch (error) {
              if (!entry.page.isClosed() && browser.isConnected()) throw error;
            }
          },
          frameBarrier: async (ticket) => {
            ticket.check();

            const tree = safeDecode(
              Schema.Struct({
                frameTree: Schema.Struct({ frame: Schema.Struct({ id: Identifier }) }),
              }),
              await cdp.send("Page.getFrameTree"),
              "page-frame",
            );

            ticket.check();

            const world = await cdp.send("Page.createIsolatedWorld", {
              frameId: tree.frameTree.frame.id,
              worldName: "effect-agent-browserbase-page-control",
            });

            ticket.check();

            const result = await cdp.send("Runtime.evaluate", {
              expression: "new Promise(resolve => requestAnimationFrame(() => resolve(true)))",
              contextId: safeDecode(
                Schema.Int.check(Schema.isGreaterThan(0)),
                world.executionContextId,
                "page-world",
              ),
              awaitPromise: true,
              returnByValue: true,
              userGesture: false,
              timeout: Math.min(2000, ticket.remainingMillis()),
            });

            ticket.check();
            if (result.exceptionDetails !== undefined || result.result.value !== true)
              throw failure("page-resume", "malformed");
          },
        });

        entry.executionValue = control;

        return control;
      } catch (error) {
        await closeWithin(() => cdp.detach()).catch(() => {});
        throw error;
      }
    });

    return entry.execution;
  };

  const explicitExecution = async (
    target: { readonly pageId: string; readonly targetId: string },
    ticket: Ticket,
  ) => {
    ticket.check();
    const entry = entries.get(target.pageId);

    if (entry === undefined || entry.page.isClosed())
      throw failure("page-control", "closed", "undispatched");
    const control = await executionFor(entry);

    ticket.check();
    if (control.targetId !== target.targetId)
      throw failure("page-control", "stale", "undispatched");

    return control;
  };

  const driver: Driver = {
    ...(options.pageControl
      ? {
          pageControl: {
            state: (page: PageInfo, ticket: Ticket) =>
              sanitize("page-state", async () => (await explicitExecution(page, ticket)).state()),
            suspend: (page: PageInfo, ticket: Ticket) =>
              sanitize("page-suspend", async () =>
                (await explicitExecution(page, ticket)).suspend(ticket),
              ),
            resume: (receipt: PageSuspension, ticket: Ticket) =>
              sanitize("page-resume", async () =>
                (await explicitExecution(receipt, ticket)).resume(receipt, ticket),
              ),
            checkSelected: (ticket: Ticket) =>
              sanitize("page-control", async () => {
                ticket.check();
                const control = await executionFor(current().entry);

                ticket.check();
                control.assertRunning();
              }),
          },
        }
      : {}),
    selected: targets.selected,
    selectedTargetId: targets.selectedTargetId,
    listPages: targets.listPages,
    selectPage: targets.selectPage,
    newPage: targets.newPage,
    closePage: targets.closePage,
    listFrames: targets.listFrames,
    selectFrame: targets.selectFrame,
    navigate: actions.navigate,
    readText: (selector, maximumBytes, ticket) =>
      observation.readText(selector, maximumBytes, ticket),
    observe: (maximumBytes, controlLimit, ticket) =>
      observation.observe(maximumBytes, controlLimit, ticket),
    click: actions.click,
    fill: actions.fill,
    scroll: actions.scroll,
    screenshot: (fullPage, maximumBytes, ticket) =>
      observation.screenshot(fullPage, maximumBytes, ticket),
    resize: (viewport, ticket) =>
      sanitize("resize", async () => {
        const page = current().entry.page;
        const entry = current().entry;

        ticket.dispatch();
        invalidateCaptures(entry, "resized");
        observation.changed("resized");
        await page.setViewportSize(viewport);
        ticket.check();
      }),
    waitFor: actions.waitFor,
    clickAndWait: actions.clickAndWait,
    clickForDownload: actions.clickForDownload,
    selectFiles: actions.selectFiles,
    clickForFileSelection: actions.clickForFileSelection,
    documentReadiness: (ticket) =>
      sanitize("ready", async () => {
        const bootstrap = options.bootstrap;

        return bootstrap === undefined || bootstrap.readiness.length === 0
          ? { _tag: "Ready" as const }
          : readiness(bootstrap, ticket);
      }),
    dismissDialogs: (ticket) =>
      sanitize("dismiss-dialogs", async () => {
        for (const dialog of [...dialogs]) {
          ticket.dispatch();
          await dialog.dismiss();
          dialogs.delete(dialog);
        }
      }),
    capture: (target?: CaptureTarget): Promise<CaptureBinding> =>
      sanitize("capture", async () => {
        let entry: Entry;
        let captureFrame: Frame;

        if (target === undefined) {
          const selectedTarget = current();

          entry = selectedTarget.entry;
          captureFrame = selectedTarget.frame;
        } else {
          const requested = entries.get(target.pageId);

          if (requested === undefined || requested.page.isClosed())
            throw failure("capture", "not-found", "undispatched");
          if ((await targets.targetId(requested)) !== target.targetId)
            throw failure("capture", "stale", "undispatched");
          entry = requested;
          captureFrame = entry.page.mainFrame();
        }
        const page = entry.page;
        const targetId = await targets.targetId(entry);
        const watchedFrameId = frameId(captureFrame);

        // The maintained API is required; older Playwright versions fail explicitly, never silently emulate it.
        if (page.screencast === undefined) throw failure("capture", "unsupported");
        let watcherSet: Set<CaptureWatcher> | undefined;
        let watcher: CaptureWatcher | undefined;

        const source: CaptureSource = {
          start: (callback, quality, invalidate, size) =>
            sanitize("capture-start", async () => {
              watcherSet = captureWatchers.get(entry.id) ?? new Set<CaptureWatcher>();
              captureWatchers.set(entry.id, watcherSet);
              watcher = { frameId: watchedFrameId, invalidate };
              watcherSet.add(watcher);
              try {
                await page.screencast.start({
                  quality,
                  ...(size === undefined ? {} : { size }),
                  onFrame: (frame: NativeFrame) => {
                    callback(frame);
                  },
                });
              } catch (error) {
                watcherSet.delete(watcher);
                watcher = undefined;
                if (watcherSet.size === 0) captureWatchers.delete(entry.id);
                throw error;
              }
            }),
          stop: () =>
            sanitize("capture-stop", async () => {
              if (watcher !== undefined && watcherSet !== undefined) {
                watcherSet.delete(watcher);
                watcher = undefined;
                if (watcherSet.size === 0) captureWatchers.delete(entry.id);
              }
              // A closed target cannot produce more frames; its page channel rejects stop.
              if (page.isClosed()) return;
              try {
                await page.screencast.stop();
              } catch (error) {
                // Closure can race the stop request. A live target still requires quarantine.
                if (!page.isClosed()) throw error;
              }
            }),
        };

        return { pageId: entry.id, targetId, frameId: watchedFrameId, source };
      }),
    invalidateObservation: observation.invalidate,
    fenceInitialization,
    disposeInitialization,
    disconnect: () =>
      sanitize("disconnect", async () => {
        closing = true;
        fenceInitialization();
        callbacks.stop();
        observation.invalidate();
        context.off("page", onPage);
        browser.off("disconnected", onDisconnected);
        for (const entry of entries.values()) for (const off of entry.off.splice(0)) off();
        captureWatchers.clear();
        await closeWithin(disposeInitialization).catch(() => {});
        await observation.dispose().catch(() => {});
        await closeWithin(() =>
          Promise.allSettled([...dialogs].map((dialog) => dialog.dismiss())),
        ).catch(() => {});
        dialogs.clear();
        await closeWithin(() => callbacks.settle()).catch(() => {});
        await closeWithin(() =>
          Promise.allSettled(
            [...entries.values()].map(async (entry) => {
              if (entry.execution !== undefined) await (await entry.execution).dispose();
            }),
          ),
        ).catch(() => {});
        await closeWithin(() => browserCdp?.detach() ?? Promise.resolve()).catch(() => {});
        await closeWithin(() => browser.close());
        targets.clear();
      }),
  };

  try {
    for (const page of context.pages()) register(page);
    browserCdp = await browser.newBrowserCDPSession();
    await browserCdp.send("Browser.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: "downloads",
      eventsEnabled: true,
    });
    // Registrations precede the first document this connection creates, and precede any
    // navigation the caller makes, without this setup navigating anything itself.
    if (options.bootstrap !== undefined || bindings !== undefined)
      await installBootstrap(options.bootstrap);
    for (const entry of entries.values()) await attachBindings(entry.page);
    await targets.selectInitial();
    const { selection } = targets;

    if (selection.entry === undefined) throw failure("initial-page", "not-found");
    await attachBindings(selection.entry.page);
    selection.frame = selection.entry.page.mainFrame();
    if (!options.preserveViewport) {
      await sizeNativeContents(selection.entry);
      await selection.entry.page.setViewportSize(options.viewport);
    }
    await targets.targetId(selection.entry);
    if (options.pageControl) for (const entry of entries.values()) await executionFor(entry);
    initialized = true;

    return driver;
  } catch (error) {
    await driver.disconnect().catch(() => {});
    throw error;
  }
};
