import { Schema } from "effect";
import type {
  Browser,
  BrowserContext,
  CDPSession,
  Dialog,
  Disposable,
  Download,
  ElementHandle,
  FileChooser,
  Frame,
  JSHandle,
  Page,
} from "playwright-core";

import {
  FrameInfo,
  ObservedControl,
  type ObservedElement,
  PageInfo,
  type PageSuspension,
} from "../../BrowserData.ts";
import { BrowserError, InitializationError } from "../../Errors.ts";
import { Identifier } from "../../References.ts";
import { SafeFilename } from "../../Transfers.ts";
import { pngGeometry } from "../capture/Images.ts";
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
  NativeFileSelection,
  NativeFrame,
  NativeObservation,
  ReadinessState,
} from "./Driver.ts";
import { makeNativeBindings } from "./NativeBindings.ts";
import type { Ticket } from "./Owner.ts";
import { PageExecution } from "./PageExecution.ts";

const failure = (
  operation: string,
  reason: BrowserError["reason"],
  outcome?: BrowserError["outcome"],
) => BrowserError.make({ operation, reason, ...(outcome === undefined ? {} : { outcome }) });

const safeDecode = <A>(
  codec: Schema.Codec<A, unknown, never, never>,
  raw: unknown,
  operation: string,
): A => {
  try {
    return Schema.decodeUnknownSync(codec)(raw);
  } catch {
    throw failure(operation, "malformed");
  }
};

const TextResult = Schema.Struct({
  text: Schema.String,
  missing: Schema.Boolean,
  overLimit: Schema.Boolean,
});

const ObservationData = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(131072)),
  textTruncated: Schema.Boolean,
  controlsTruncated: Schema.Boolean,
  controls: Schema.Array(
    Schema.Struct({
      kind: ObservedControl.fields.kind,
      label: ObservedControl.fields.label,
      disabled: Schema.Boolean,
    }),
  ).check(Schema.isMaxLength(64)),
});

const Geometry = Schema.Struct({ width: Schema.Natural, height: Schema.Natural });

const TargetInfo = Schema.Struct({
  targetInfo: Schema.Struct({ targetId: Identifier, type: Schema.Literal("page") }),
});
const NativeWindow = Schema.Struct({ windowId: Schema.Natural });

const Count = Schema.Natural.check(Schema.isLessThanOrEqualTo(1000000));
const URLText = Schema.String.check(Schema.isMaxLength(8192));

interface Entry {
  readonly id: string;
  readonly page: Page;
  targetId?: string;
  readonly off: Array<() => void>;
  execution?: Promise<PageExecution>;
  executionValue?: PageExecution;
}
interface Snapshot {
  readonly id: string;
  valid: boolean;
  readonly nodes: Map<string, ElementHandle<Element>>;
}
interface CaptureWatcher {
  readonly frameId: string;
  readonly invalidate: (reason: CaptureInvalidation) => void;
}

/** No raw exception from Playwright is allowed to cross this private boundary. */
const sanitize = <A>(operation: string, action: () => Promise<A>): Promise<A> =>
  Promise.resolve()
    .then(action)
    .catch((error: unknown) => {
      throw Schema.is(BrowserError)(error) ? error : failure(operation, "provider");
    });

const closeWithin = async (action: () => Promise<unknown>, milliseconds = 2000): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      Promise.resolve().then(action),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(failure("native-close", "timeout")), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/** Production import is lazy: constructing any Layer cannot load Playwright or allocate a browser. */
export const connectPlaywright = async (
  connection: unknown,
  signal: AbortSignal,
  options: DriverOptions,
  events: DriverEvents,
): Promise<Driver> => {
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
  if (signal.aborted) throw failure("connect", "interrupted");
  const { chromium } = await import("playwright-core");

  const browser = await sanitize("connect", () =>
    chromium.connectOverCDP(connection, {
      timeout: 15000,
      ...(options.pageControl ? { noDefaults: true } : {}),
    }),
  );

  if (signal.aborted) {
    await closeWithin(() => browser.close()).catch(() => {});
    throw failure("connect", "interrupted");
  }
  try {
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
  const entries = new Map<string, Entry>();
  const byPage = new WeakMap<Page, Entry>();
  const frameIds = new WeakMap<Frame, string>();
  // A frame object outlives its documents, so readiness is keyed by frame *and* epoch.
  const documentEpochs = new WeakMap<Frame, number>();
  const registeredEpochs = new WeakMap<Frame, number>();
  const readyDocuments = new WeakMap<Frame, number>();
  const dialogs = new Set<Dialog>();
  const callbacks = new CallbackTasks(32, () => events.fault());
  const captureWatchers = new Map<string, Set<CaptureWatcher>>();

  let serial = 0,
    frameSerial = 0,
    observationSerial = 0,
    downloadSerial = 0;

  let selected: Entry | undefined;
  let selectedFrame: Frame | undefined;
  let observation: Snapshot | undefined;
  let closing = false;
  let creatingPage = false;
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

  const invalidateObservation = () => {
    if (observation !== undefined) observation.valid = false;
  };

  const changed = (reason: Parameters<DriverEvents["invalidate"]>[0]) => {
    invalidateObservation();
    events.invalidate(reason);
  };

  const epochOf = (frame: Frame): number => documentEpochs.get(frame) ?? 0;

  const frameId = (frame: Frame): string => {
    let id = frameIds.get(frame);

    if (id === undefined) {
      id = `frame-${++frameSerial}`;
      frameIds.set(frame, id);
    }

    return id;
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

  const disposeObservation = async () => {
    const old = observation;

    observation = undefined;
    if (old !== undefined) {
      old.valid = false;
      await closeWithin(() =>
        Promise.allSettled([...old.nodes.values()].map((node) => node.dispose())),
      );
    }
  };

  const register = (page: Page): Entry => {
    const existing = byPage.get(page);

    if (existing !== undefined) return existing;
    const entry: Entry = { id: `page-${++serial}`, page, off: [] };

    byPage.set(page, entry);
    if (entries.size >= options.maxPages) {
      callbacks.submit(() => closeWithin(() => page.close()));
      events.fault();

      return entry;
    }
    entries.set(entry.id, entry);
    for (const frame of page.frames()) frameId(frame);

    const onClose = () => {
      entry.executionValue?.invalidate();
      if (entry.execution !== undefined)
        callbacks.submit(async () => {
          await (await entry.execution)?.dispose();
        });
      invalidateCaptures(entry, "target-changed");
      captureWatchers.delete(entry.id);
      entries.delete(entry.id);
      for (const off of entry.off.splice(0)) off();
      if (selected === entry) {
        selected = undefined;
        selectedFrame = undefined;
        changed("target-changed");
      }
    };

    const onNavigation = (frame: Frame) => {
      if (frame === page.mainFrame() && entry.executionValue?.invalidate()) events.fault();
      documentEpochs.set(frame, epochOf(frame) + 1);
      if (initialized && bindings !== undefined) bindingTask(() => bindings.attach(frame, page));
      frameId(frame);
      invalidateCaptures(entry, "target-changed", frame);
      if (selected === entry && (selectedFrame === frame || frame === page.mainFrame()))
        changed("target-changed");
    };

    const onDetached = (frame: Frame) => {
      invalidateCaptures(entry, "target-changed", frame);
      if (selectedFrame === frame) {
        selectedFrame = undefined;
        changed("target-changed");
      }
    };

    const onDialog = (dialog: Dialog) => {
      if (options.dialogPolicy === "dismiss")
        callbacks.submit(() => closeWithin(() => dialog.dismiss()));
      else if (dialogs.size >= 8) {
        events.fault();
        callbacks.submit(() => closeWithin(() => dialog.dismiss()));
      } else {
        dialogs.add(dialog);
        invalidateObservation();
        events.pause();
      }
    };

    page.on("close", onClose);
    page.on("framenavigated", onNavigation);
    page.on("framedetached", onDetached);
    page.on("dialog", onDialog);
    entry.off.push(
      () => page.off("close", onClose),
      () => page.off("framenavigated", onNavigation),
      () => page.off("framedetached", onDetached),
      () => page.off("dialog", onDialog),
    );
    if (initialized && options.pageControl)
      callbacks.submit(async () => {
        await executionFor(entry);
      });
    if (initialized && bindings !== undefined) bindingTask(() => attachBindings(page));
    if (initialized && !creatingPage) {
      if (options.popupPolicy === "close") callbacks.submit(() => closeWithin(() => page.close()));
      else if (options.popupPolicy === "pause") events.pause();
    }

    return entry;
  };

  const onPage = (page: Page) => {
    register(page);
  };

  const onDisconnected = () => {
    if (!closing) {
      invalidateObservation();
      events.disconnected();
    }
  };

  context.on("page", onPage);
  browser.on("disconnected", onDisconnected);

  const current = () => {
    if (
      closing ||
      !browser.isConnected() ||
      selected === undefined ||
      selected.page.isClosed() ||
      selectedFrame === undefined ||
      selectedFrame.isDetached()
    )
      throw failure("target", "closed", "undispatched");

    return { entry: selected, frame: selectedFrame };
  };

  const getTargetId = async (entry: Entry): Promise<string> => {
    if (entry.targetId !== undefined) return entry.targetId;
    const cdp = await context.newCDPSession(entry.page);

    try {
      const info: unknown = await cdp.send("Target.getTargetInfo");

      entry.targetId = safeDecode(TargetInfo, info, "target-identity").targetInfo.targetId;

      return entry.targetId;
    } finally {
      await closeWithin(() => cdp.detach()).catch(() => {});
    }
  };

  const sizeNativeContents = async (entry: Entry): Promise<void> => {
    if (browserCdp === undefined) throw failure("viewport", "closed", "undispatched");
    const targetId = await getTargetId(entry);
    const current: unknown = await browserCdp.send("Browser.getWindowForTarget", { targetId });
    const native = safeDecode(NativeWindow, current, "viewport");

    await browserCdp.send("Browser.setContentsSize", {
      windowId: native.windowId,
      width: options.viewport.width,
      height: options.viewport.height,
    });
  };

  const observationUrl = () => safeDecode(URLText, current().frame.url(), "page-url");

  const postUrl = () => {
    const value = observationUrl();
    let url: URL;

    try {
      url = new URL(value);
    } catch {
      throw failure("page-url", "malformed");
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      throw failure("page-url", "malformed");

    return value;
  };

  // The native timeout is finite as well as Effect's authoritative deadline. It cannot undo dispatch.
  const timeout = (ticket: Ticket) => {
    ticket.check();

    return ticket.remainingMillis();
  };

  const exactElement = async (
    selector: string,
    ticket: Ticket,
  ): Promise<ElementHandle<Element>> => {
    ticket.check();

    const holder = await current().frame.evaluateHandle((requested) => {
      try {
        const matches = document.querySelectorAll(requested);

        return { count: matches.length, node: matches.length === 1 ? matches[0] : null };
      } catch {
        return { count: 0, node: null };
      }
    }, selector);

    let node: JSHandle | undefined;

    try {
      const countHandle = await holder.getProperty("count");
      let count: number;

      try {
        count = safeDecode(Count, await countHandle.jsonValue(), "target-count");
      } finally {
        await countHandle.dispose();
      }
      ticket.check();
      if (count !== 1)
        throw failure("target", count === 0 ? "not-found" : "ambiguous", "undispatched");
      node = await holder.getProperty("node");
      const element = node.asElement();

      if (element === null) throw failure("target", "not-found", "undispatched");
      ticket.check();

      return element;
    } catch (error) {
      await node?.dispose().catch(() => {});
      throw error;
    } finally {
      await holder.dispose();
    }
  };

  const withElement = async <A>(
    target: string | ObservedElement,
    ticket: Ticket,
    action: (element: ElementHandle<Element>) => Promise<A>,
  ): Promise<A> => {
    const retained = typeof target !== "string";
    let element: ElementHandle<Element>;

    if (typeof target === "string") element = await exactElement(target, ticket);
    else {
      if (
        observation === undefined ||
        !observation.valid ||
        observation.id !== target.observationId
      )
        throw failure("target", "stale", "undispatched");
      const node = observation.nodes.get(target.elementId);

      if (node === undefined) throw failure("target", "stale", "undispatched");
      element = node;
    }
    try {
      const attached: unknown = await element.evaluate(
        (node, selector) => {
          if (!node.isConnected) return false;
          if (selector === undefined) return true;
          const matches = node.ownerDocument.querySelectorAll(selector);

          return matches.length === 1 && matches[0] === node;
        },
        typeof target === "string" ? target : undefined,
      );

      if (attached !== true) throw failure("target", "stale", "undispatched");
      ticket.check();
      // ElementHandle actions do not re-resolve the selector onto a replacement node.
      ticket.dispatch();

      return await action(element);
    } finally {
      if (!retained) await closeWithin(() => element.dispose()).catch(() => {});
    }
  };

  const click = (target: string | ObservedElement, ticket: Ticket) =>
    sanitize("click", async () => {
      await withElement(target, ticket, (element) => element.click({ timeout: timeout(ticket) }));
      ticket.check();

      return postUrl();
    });

  const waitEvent = <A>(
    add: (listener: (value: A) => void) => void,
    remove: (listener: (value: A) => void) => void,
    ticket: Ticket,
    accepts: (value: A) => boolean = () => true,
  ) => {
    let done = false;
    let resolve: (value: A) => void = () => {};
    let reject: (error: BrowserError) => void = () => {};

    const promise = new Promise<A>((yes, no) => {
      resolve = yes;
      reject = no;
    });

    // Attach a rejection observer immediately, even while the action is still running.
    void promise.catch(() => {});

    const cleanup = () => {
      remove(listener);
      ticket.signal.removeEventListener("abort", abort);
      clearTimeout(timer);
    };

    const abort = () => {
      if (!done) {
        done = true;
        cleanup();
        reject(failure("wait", "interrupted"));
      }
    };

    const listener = (value: A) => {
      if (!done && accepts(value)) {
        done = true;
        cleanup();
        resolve(value);
      }
    };

    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        cleanup();
        reject(failure("wait", "timeout"));
      }
    }, ticket.remainingMillis());

    add(listener);
    ticket.signal.addEventListener("abort", abort, { once: true });
    if (ticket.signal.aborted) abort();

    return { promise, cancel: abort };
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

  /**
   * In-memory bytes and provider-stored paths reach the page by different mechanisms and are
   * never mixed: the first is streamed from this client, the second is opened by the browser
   * process itself. A mixed request is a configuration error, not a native surprise later.
   */
  const nativeSelection = (
    files: ReadonlyArray<NativeFileSelection>,
  ):
    | {
        readonly _tag: "Inline";
        readonly payload: Array<{ name: string; mimeType: string; buffer: Buffer }>;
      }
    | { readonly _tag: "Remote"; readonly paths: Array<string> } => {
    if (files.length === 0) throw failure("select-files", "configuration", "undispatched");
    const inline = files.filter((file) => file._tag === "Inline");
    const remote = files.filter((file) => file._tag === "Remote");

    // The maintained native API encodes a Node Buffer; this lazily loaded driver already
    // requires the Node-only Playwright peer, so the conversion belongs here and nowhere else.
    if (inline.length === files.length) {
      return {
        _tag: "Inline",
        payload: inline.map((file) => ({
          name: file.name,
          mimeType: file.mediaType,
          buffer: Buffer.from(file.bytes),
        })),
      };
    }
    if (remote.length === files.length)
      return { _tag: "Remote", paths: remote.map((file) => file.path) };
    throw failure("select-files", "configuration", "undispatched");
  };

  /**
   * A file the provider already stores is named to the browser process, which opens it; this
   * client never reads that path. Exactly one main-frame node may match, and exactly one
   * command dispatches. A retained node or child frame is refused rather than approximated.
   */
  const attachStoredFiles = async (
    target: string | ObservedElement,
    paths: ReadonlyArray<string>,
    ticket: Ticket,
  ) => {
    if (typeof target !== "string") throw failure("select-files", "unsupported", "undispatched");
    const { entry, frame } = current();

    if (frame !== entry.page.mainFrame())
      throw failure("select-files", "unsupported", "undispatched");
    const cdp = await context.newCDPSession(entry.page);

    try {
      ticket.check();

      const root = safeDecode(
        Schema.Struct({ root: Schema.Struct({ nodeId: Schema.Int }) }),
        await cdp.send("DOM.getDocument", { depth: 0 }),
        "select-files",
      );

      const matched = safeDecode(
        Schema.Struct({ nodeIds: Schema.Array(Schema.Int).check(Schema.isMaxLength(64)) }),
        await cdp.send("DOM.querySelectorAll", { nodeId: root.root.nodeId, selector: target }),
        "select-files",
      );

      ticket.check();
      const nodeId = matched.nodeIds[0];

      if (matched.nodeIds.length !== 1 || nodeId === undefined)
        throw failure(
          "select-files",
          matched.nodeIds.length === 0 ? "not-found" : "ambiguous",
          "undispatched",
        );
      ticket.dispatch();
      await cdp.send("DOM.setFileInputFiles", { files: [...paths], nodeId });
    } finally {
      await closeWithin(() => cdp.detach()).catch(() => {});
    }
  };

  const executionFor = (entry: Entry): Promise<PageExecution> => {
    if (!options.pageControl)
      return Promise.reject(failure("page-control", "unsupported", "undispatched"));
    entry.execution ??= sanitize("page-control", async () => {
      const cdp = await context.newCDPSession(entry.page);

      try {
        const targetId = await getTargetId(entry);

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
    selected: () => {
      const { entry, frame } = current();

      return { pageId: entry.id, frameId: frameId(frame) };
    },
    selectedTargetId: () => sanitize("target-identity", () => getTargetId(current().entry)),
    listPages: (ticket) =>
      sanitize("list-pages", async () => {
        ticket.check();
        const output: PageInfo[] = [];

        for (const entry of entries.values()) {
          const targetId = await getTargetId(entry);
          const title: unknown = await entry.page.title();

          ticket.check();
          if (typeof title !== "string") throw failure("list-pages", "malformed");
          output.push(
            safeDecode(
              PageInfo,
              {
                pageId: entry.id,
                targetId,
                title: title.slice(0, 512),
                url: entry.page.url(),
                selected: selected === entry,
              },
              "list-pages",
            ),
          );
        }

        return output;
      }),
    selectPage: (id, ticket) =>
      sanitize("select-page", async () => {
        const entry = entries.get(id);

        ticket.check();
        if (entry === undefined || entry.page.isClosed())
          throw failure("select-page", "not-found", "undispatched");
        await disposeObservation();
        ticket.check();
        selected = entry;
        selectedFrame = entry.page.mainFrame();
        changed("target-changed");
      }),
    newPage: (ticket) =>
      sanitize("new-page", async () => {
        if (entries.size >= options.maxPages) throw failure("new-page", "limit", "undispatched");
        ticket.dispatch();
        creatingPage = true;
        try {
          const page = await context.newPage();

          if (ticket.signal.aborted) {
            await closeWithin(() => page.close()).catch(() => {});
            ticket.check();
          }

          // Creation never silently selects a different tab.
          return register(page).id;
        } finally {
          creatingPage = false;
        }
      }),
    closePage: (id, ticket) =>
      sanitize("close-page", async () => {
        const entry = entries.get(id);

        if (entry === undefined) throw failure("close-page", "not-found", "undispatched");
        ticket.dispatch();
        await entry.page.close({ runBeforeUnload: false });
        ticket.check();
      }),
    listFrames: (ticket) =>
      sanitize("list-frames", async () => {
        ticket.check();
        const frames = current().entry.page.frames();

        if (frames.length > 128) throw failure("list-frames", "limit");

        return frames.map((frame) =>
          safeDecode(
            FrameInfo,
            {
              frameId: frameId(frame),
              parentFrameId: frame.parentFrame() === null ? null : frameId(frame.parentFrame()!),
              url: frame.url(),
              name: frame.name().slice(0, 256),
            },
            "list-frames",
          ),
        );
      }),
    selectFrame: (id, ticket) =>
      sanitize("select-frame", async () => {
        const entry = selected;

        if (entry === undefined) throw failure("select-frame", "closed");
        const frame = entry.page.frames().find((f) => frameId(f) === id);

        if (frame === undefined || frame.isDetached())
          throw failure("select-frame", "not-found", "undispatched");
        await disposeObservation();
        ticket.check();
        selectedFrame = frame;
        changed("target-changed");
      }),
    navigate: (url, ticket) =>
      sanitize("navigate", async () => {
        const { frame } = current();

        ticket.dispatch();
        await frame.goto(url, { waitUntil: "domcontentloaded", timeout: timeout(ticket) });
        ticket.check();

        return postUrl();
      }),
    readText: (selector, maximumBytes, ticket) =>
      sanitize("read-text", async () => {
        ticket.check();

        const raw: unknown = await current().frame.evaluate(
          ({ selector, maximumBytes }) => {
            const element =
              selector === undefined ? document.body : document.querySelector(selector);

            if (element === null) return { text: "", missing: true, overLimit: false };

            const text =
              element instanceof HTMLElement ? element.innerText : (element.textContent ?? "");

            if (new TextEncoder().encode(text).length > maximumBytes)
              return { text: "", missing: false, overLimit: true };

            return { text, missing: false, overLimit: false };
          },
          { selector, maximumBytes },
        );

        ticket.check();
        const value = safeDecode(TextResult, raw, "read-text");

        if (value.missing) throw failure("read-text", "not-found");
        if (value.overLimit || new TextEncoder().encode(value.text).length > maximumBytes)
          throw failure("read-text", "limit");

        return value.text;
      }),
    observe: (maximumBytes, controlLimit, ticket) =>
      sanitize("observe", async () => {
        await disposeObservation();
        ticket.check();

        const holder = await current().frame.evaluateHandle(
          ({ maximumBytes, controlLimit }) => {
            const all = document.querySelectorAll(
              "a[href],button,input,select,textarea,[role=button]",
            );

            const nodes: Element[] = [];

            for (let i = 0; i < Math.min(all.length, controlLimit); i++) nodes.push(all[i]);
            const source = document.body?.innerText ?? "";
            const encoded = new TextEncoder().encode(source);
            let end = Math.min(encoded.length, maximumBytes);

            // Do not manufacture a replacement character by cutting a UTF-8 sequence.
            while (end > 0 && end < encoded.length && (encoded[end] & 192) === 128) end--;
            const text = new TextDecoder().decode(encoded.subarray(0, end));

            return {
              nodes,
              data: {
                text,
                textTruncated: end < encoded.length,
                controlsTruncated: all.length > nodes.length,
                controls: nodes.map((node) => {
                  const tag = node.tagName.toLowerCase();

                  const kind =
                    tag === "a"
                      ? "link"
                      : ["button", "input", "select", "textarea"].includes(tag)
                        ? tag
                        : "other";

                  const label = (
                    node.getAttribute("aria-label") ??
                    node.getAttribute("placeholder") ??
                    (node instanceof HTMLInputElement
                      ? node.labels?.[0]?.textContent
                      : node.textContent) ??
                    ""
                  ).slice(0, 256);

                  return {
                    kind,
                    label,
                    disabled:
                      node.matches(":disabled") || node.getAttribute("aria-disabled") === "true",
                  };
                }),
              },
            };
          },
          { maximumBytes, controlLimit },
        );

        const nodes = new Map<string, ElementHandle<Element>>();
        let nodesHandle: JSHandle | undefined;

        try {
          const dataHandle = await holder.getProperty("data");
          let data: typeof ObservationData.Type;

          try {
            data = safeDecode(ObservationData, await dataHandle.jsonValue(), "observe");
          } finally {
            await dataHandle.dispose();
          }
          if (
            new TextEncoder().encode(data.text).length > maximumBytes ||
            data.controls.length > controlLimit
          )
            throw failure("observe", "limit");
          nodesHandle = await holder.getProperty("nodes");
          for (let i = 0; i < data.controls.length; i++) {
            const node = await nodesHandle.getProperty(String(i));
            const element = node.asElement();

            if (element === null) {
              await node.dispose();
              throw failure("observe", "malformed");
            }
            nodes.set(`element-${i}`, element);
          }
          ticket.check();
          const id = `observation-${++observationSerial}`;

          observation = { id, valid: true, nodes };

          const result: NativeObservation = {
            ...data,
            observationId: id,
            url: observationUrl(),
            controls: data.controls.map((control, i) =>
              ObservedControl.make({ ...control, elementId: `element-${i}` }),
            ),
          };

          return result;
        } catch (error) {
          await Promise.allSettled([...nodes.values()].map((node) => node.dispose()));
          throw error;
        } finally {
          await nodesHandle?.dispose().catch(() => {});
          await holder.dispose();
        }
      }),
    click,
    fill: (target, value, ticket) =>
      sanitize("fill", async () => {
        await withElement(target, ticket, (element) =>
          element.fill(value, { timeout: timeout(ticket) }),
        );
        ticket.check();

        return postUrl();
      }),
    scroll: (deltaX, deltaY, ticket) =>
      sanitize("scroll", async () => {
        const { frame } = current();

        ticket.dispatch();
        await frame.evaluate(
          ({ x, y }) => window.scrollBy({ left: x, top: y, behavior: "instant" }),
          { x: deltaX, y: deltaY },
        );
        ticket.check();

        return postUrl();
      }),
    screenshot: (fullPage, maximumBytes, ticket) =>
      sanitize("screenshot", async () => {
        const page = current().entry.page;

        ticket.check();

        const raw: unknown = await page.evaluate(
          (full) => ({
            width: full
              ? Math.max(document.documentElement.scrollWidth, window.innerWidth)
              : window.innerWidth,
            height: full
              ? Math.max(document.documentElement.scrollHeight, window.innerHeight)
              : window.innerHeight,
          }),
          fullPage,
        );

        const geometry = safeDecode(Geometry, raw, "screenshot");

        if (
          geometry.width < 1 ||
          geometry.height < 1 ||
          geometry.width > 16384 ||
          geometry.height > 16384 ||
          geometry.width * geometry.height > 33_554_432
        )
          throw failure("screenshot", "limit");
        ticket.check();

        const bytes: unknown = await page.screenshot({
          type: "png",
          fullPage,
          scale: "css",
          timeout: timeout(ticket),
        });

        if (!(bytes instanceof Uint8Array)) throw failure("screenshot", "malformed");
        if (bytes.length > maximumBytes) throw failure("screenshot", "limit");
        const actual = pngGeometry(bytes);

        if (
          actual.width > 16384 ||
          actual.height > 16384 ||
          actual.width * actual.height > 33_554_432
        )
          throw failure("screenshot", "limit");
        ticket.check();

        return new Uint8Array(bytes);
      }),
    resize: (viewport, ticket) =>
      sanitize("resize", async () => {
        const page = current().entry.page;
        const entry = current().entry;

        ticket.dispatch();
        invalidateCaptures(entry, "resized");
        changed("resized");
        await page.setViewportSize(viewport);
        ticket.check();
      }),
    waitFor: (selector, state, ticket) =>
      sanitize("wait", async () => {
        const node = await current().frame.waitForSelector(selector, {
          state,
          strict: true,
          timeout: timeout(ticket),
        });

        await node?.dispose();
        ticket.check();
      }),
    clickAndWait: (target, ticket) =>
      sanitize("click-and-wait", async () => {
        const { entry, frame } = current();

        const observer = waitEvent<Frame>(
          (on) => entry.page.on("framenavigated", on),
          (off) => entry.page.off("framenavigated", off),
          ticket,
          (changedFrame) => changedFrame === frame,
        );

        try {
          await click(target, ticket);
          await observer.promise;
          await frame.waitForLoadState("domcontentloaded", { timeout: timeout(ticket) });
          ticket.check();

          return postUrl();
        } finally {
          observer.cancel();
        }
      }),
    clickForDownload: (target, ticket) =>
      sanitize("download-action", async () => {
        const page = current().entry.page;

        const observer = waitEvent<Download>(
          (on) => page.on("download", on),
          (off) => page.off("download", off),
          ticket,
        );

        try {
          await click(target, ticket);
          const download = await observer.promise;

          const filename = safeDecode(
            SafeFilename,
            download.suggestedFilename(),
            "download-filename",
          );

          const error = await download.failure();

          ticket.check();

          return {
            downloadId: `native-download-${++downloadSerial}`,
            filename,
            state: error === null ? "completed" : "failed",
          };
        } finally {
          observer.cancel();
        }
      }),
    selectFiles: (target, files, ticket) =>
      sanitize("select-files", async () => {
        const selection = nativeSelection(files);

        if (selection._tag === "Remote") await attachStoredFiles(target, selection.paths, ticket);
        else
          await withElement(target, ticket, (element) =>
            element.setInputFiles(selection.payload, { timeout: timeout(ticket) }),
          );
        ticket.check();

        return postUrl();
      }),
    clickForFileSelection: (target, files, ticket) =>
      sanitize("file-chooser", async () => {
        const selection = nativeSelection(files);

        // A chooser is satisfied with bytes this client holds. A provider-stored file is
        // attached to an exact input node instead, where the browser can open the path.
        if (selection._tag === "Remote")
          throw failure("file-chooser", "unsupported", "undispatched");
        const page = current().entry.page;

        const observer = waitEvent<FileChooser>(
          (on) => page.on("filechooser", on),
          (off) => page.off("filechooser", off),
          ticket,
        );

        try {
          await click(target, ticket);
          const chooser = await observer.promise;

          ticket.check();
          if (!chooser.isMultiple() && selection.payload.length > 1)
            throw failure("file-chooser", "unsupported");
          // Exactly one attachment for this chooser; a second would open another dispatch.
          await chooser.setFiles(selection.payload, { timeout: timeout(ticket) });
          ticket.check();

          return postUrl();
        } finally {
          observer.cancel();
        }
      }),
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
          if ((await getTargetId(requested)) !== target.targetId)
            throw failure("capture", "stale", "undispatched");
          entry = requested;
          captureFrame = entry.page.mainFrame();
        }
        const page = entry.page;
        const targetId = await getTargetId(entry);
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
    invalidateObservation,
    fenceInitialization,
    disposeInitialization,
    disconnect: () =>
      sanitize("disconnect", async () => {
        closing = true;
        fenceInitialization();
        callbacks.stop();
        invalidateObservation();
        context.off("page", onPage);
        browser.off("disconnected", onDisconnected);
        for (const entry of entries.values()) for (const off of entry.off.splice(0)) off();
        captureWatchers.clear();
        await closeWithin(disposeInitialization).catch(() => {});
        await disposeObservation().catch(() => {});
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
        entries.clear();
        selected = undefined;
        selectedFrame = undefined;
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
    if (options.newPage || entries.size === 0) {
      creatingPage = true;
      try {
        selected = register(await context.newPage());
      } finally {
        creatingPage = false;
      }
    } else if (options.initialTargetId !== undefined) {
      for (const entry of entries.values())
        if ((await getTargetId(entry)) === options.initialTargetId) selected = entry;
      if (selected === undefined) throw failure("initial-page", "not-found");
    } else {
      if (entries.size !== 1) throw failure("initial-page", "ambiguous");
      selected = entries.values().next().value;
    }
    if (selected === undefined) throw failure("initial-page", "not-found");
    await attachBindings(selected.page);
    selectedFrame = selected.page.mainFrame();
    if (!options.preserveViewport) {
      await sizeNativeContents(selected);
      await selected.page.setViewportSize(options.viewport);
    }
    await getTargetId(selected);
    if (options.pageControl) for (const entry of entries.values()) await executionFor(entry);
    initialized = true;

    return driver;
  } catch (error) {
    await driver.disconnect().catch(() => {});
    throw error;
  }
};
