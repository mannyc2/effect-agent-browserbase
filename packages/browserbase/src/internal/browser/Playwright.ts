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

import { BrowserError, InitializationError } from "../../Errors.ts";
import { makeActions } from "./Actions.ts";
import type { CompiledBootstrap } from "./Bootstrap.ts";
import { CallbackTasks } from "./CallbackTasks.ts";
import { makeCaptureSources } from "./CaptureSource.ts";
import type { Driver, DriverEvents, DriverOptions, ReadinessState } from "./Driver.ts";
import { makeNativeBindings } from "./NativeBindings.ts";
import { closeWithin, failure, safeDecode, sanitize } from "./NativeCalls.ts";
import { makePageControl } from "./NativePageControl.ts";
import { makeObservation } from "./Observation.ts";
import type { Ticket } from "./Owner.ts";
import { type Entry, makeTargets } from "./Targets.ts";

const NativeWindow = Schema.Struct({ windowId: Schema.Natural });

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

  const targets = makeTargets(browser, context, options, callbacks, events, () => closing, {
    opened: (entry, created) => {
      if (initialized && options.pageControl)
        callbacks.submit(async () => {
          await pageControl.execution(entry);
        });
      if (initialized && bindings !== undefined) bindingTask(() => attachBindings(entry.page));
      if (initialized && !created) {
        if (options.popupPolicy === "close")
          callbacks.submit(() => closeWithin(() => entry.page.close()));
        else if (options.popupPolicy === "pause") events.pause();
      }
    },
    closed: (entry) => {
      pageControl.closed(entry);
      captures.invalidate(entry, "target-changed");
      captures.forget(entry);
    },
    navigating: (entry, frame) => pageControl.navigating(entry, frame),
    navigated: (entry, frame) => {
      if (initialized && bindings !== undefined)
        bindingTask(() => bindings.attach(frame, entry.page));
    },
    frameChanged: (entry, frame) => {
      captures.invalidate(entry, "target-changed", frame);
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

  const { current, entries, epochOf, register } = targets;
  const observation = makeObservation(targets, events);
  const actions = makeActions(context, targets, observation);
  const captures = makeCaptureSources(targets);

  const pageControl = makePageControl(
    browser,
    context,
    options,
    targets,
    callbacks,
    events,
    () => closing,
  );

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

  const driver: Driver = {
    ...(options.pageControl
      ? {
          pageControl: pageControl.operations,
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
        captures.invalidate(entry, "resized");
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
    capture: captures.capture,
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
        captures.clear();
        await closeWithin(disposeInitialization).catch(() => {});
        await observation.dispose().catch(() => {});
        await closeWithin(() =>
          Promise.allSettled([...dialogs].map((dialog) => dialog.dismiss())),
        ).catch(() => {});
        dialogs.clear();
        await closeWithin(() => callbacks.settle()).catch(() => {});
        await closeWithin(() => pageControl.dispose()).catch(() => {});
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
    if (options.pageControl)
      for (const entry of entries.values()) await pageControl.execution(entry);
    initialized = true;

    return driver;
  } catch (error) {
    await driver.disconnect().catch(() => {});
    throw error;
  }
};
