import { Schema } from "effect";
import type { Browser, CDPSession, Dialog, Frame, Page } from "playwright-core";

import { Identifier } from "../../BrowserData.ts";
import { Reasons, BrowserError, InitializationError } from "../../Errors.ts";
import { makeActions } from "./Actions.ts";
import type { ConnectionIdentity } from "./Binding.ts";
import { CallbackTasks } from "./CallbackTasks.ts";
import { makeCaptureSources } from "./CaptureSource.ts";
import type { Driver, DriverEvents, DriverOptions } from "./Driver.ts";
import { makeInitialization } from "./Initialization.ts";
import { makeKeyboard } from "./Keyboard.ts";
import {
  closeWithin,
  failure,
  NativeFailure,
  providerReason,
  safeDecode,
  sanitize,
} from "./NativeCalls.ts";
import { makePageControl } from "./NativePageControl.ts";
import { makeObservation } from "./Observation.ts";
import { makePointer } from "./Pointer.ts";
import { PolicyCleanup } from "./PolicyCleanup.ts";
import { type Entry, makeTargets } from "./Targets.ts";

const NativeWindow = Schema.Struct({ windowId: Schema.Natural });

const CreatedTarget = Schema.Struct({ targetId: Identifier });

/**
 * Playwright 1.63.0 reports the browser's own error reply to a CDP command this way. A reply is
 * the browser's answer that it did not do what was asked; anything else leaves that unknown.
 */
const refusedBy = (method: string, error: unknown): boolean =>
  error instanceof Error &&
  error.message.includes(`Protocol error (${method})`) &&
  // Playwright's own rejection of a call still pending when its session closed.
  !error.message.includes("session closed");

/**
 * Connects to an already validated or host-resolved CDP endpoint and builds the one driver. The
 * import is lazy, so constructing any Layer cannot load Playwright or allocate a browser. A
 * trusted observer sees the engine's browser before the driver exists and never replaces it.
 */
export const connectPlaywrightEndpoint = async (
  endpoint: string,
  signal: AbortSignal,
  identity: ConnectionIdentity,
  options: DriverOptions,
  events: DriverEvents,
  observe?: (browser: Browser) => void,
): Promise<Driver> => {
  if (signal.aborted) throw failure(Reasons.Interrupted.make({}));
  const { chromium } = await import("playwright-core");

  const browser = await sanitize(() =>
    chromium.connectOverCDP(endpoint, {
      timeout: 15000,
      ...(options.pageControl ? { noDefaults: true } : {}),
    }),
  );

  if (signal.aborted) {
    await closeWithin(() => browser.close()).catch(() => {});
    throw failure(Reasons.Interrupted.make({}));
  }
  try {
    observe?.(browser);
    const driver = await makePlaywrightDriver(browser, identity, options, events);

    if (signal.aborted) {
      await driver.disconnect().catch(() => {});
      throw failure(Reasons.Interrupted.make({}));
    }

    return driver;
  } catch (error) {
    await closeWithin(() => browser.close()).catch(() => {});
    throw Schema.is(BrowserError)(error) ||
      Schema.is(InitializationError)(error) ||
      Schema.is(NativeFailure)(error)
      ? error
      : failure(providerReason(error));
  }
};

/** Tests may supply a real already-connected browser. This is deliberately not an exported subpath. */
export const makePlaywrightDriver = async (
  browser: Browser,
  identity: ConnectionIdentity,
  options: DriverOptions,
  events: DriverEvents,
): Promise<Driver> => {
  // This constructor is reached only after native acquisition, including in driver tests.
  const { errors } = await import("playwright-core");
  const contexts = browser.contexts();
  const [context] = contexts;

  if (contexts.length !== 1 || context === undefined) throw failure(Reasons.Ambiguous.make({}));

  const dialogs = new Map<
    Dialog,
    { readonly dismissed: (confirmed: boolean) => void } | undefined
  >();

  const callbacks = new CallbackTasks(32, (disposition) =>
    events.fault({ source: "native", reason: "callback", disposition }),
  );

  const policyCleanup = new PolicyCleanup(events);
  const blockedPopup = {};

  let closing = false;
  let initialized = false;
  let browserCdp: CDPSession | undefined;
  // Cleared the first time the browser refuses a window; the pages it opens are tabs from then on.
  let windows = true;
  let sameDocumentCapture: (entry: Entry, frame: Frame) => void = () => {};

  const targets = makeTargets(
    browser,
    context,
    options,
    identity.namespace,
    () => closing,
    {
      opened: (entry, created) => {
        if (initialized && !created && options.popupPolicy === "close") {
          void policyCleanup.run(entry.page, () => entry.page.close({ runBeforeUnload: false }));

          return;
        }
        if (initialized && options.pageControl)
          callbacks.submit(async () => {
            await pageControl.execution(entry);
          });
        if (initialized) initialization.attachPage(entry.page);
        if (initialized && !created && options.popupPolicy === "pause")
          events.pause("popup", entry.id);
      },
      external: (entry) => {
        if (!initialized) return;
        if (options.popupPolicy === "close")
          void policyCleanup.run(entry.page, () => entry.page.close({ runBeforeUnload: false }));
        else if (options.popupPolicy === "pause") events.pause("popup", entry.id);
      },
      overflow: (entry) => {
        if (options.popupPolicy === "close")
          void policyCleanup.run(entry.page, () => entry.page.close({ runBeforeUnload: false }), {
            overflow: "popup-overflow",
          });
        else
          events.fault({
            source: "policy",
            reason: "popup-overflow",
            token: blockedPopup,
            disposition: "not-dispatched",
          });
      },
      closed: (entry) => {
        actions.retireWaitPage(entry);
        keyboard.retirePage(entry.page);
        for (const [dialog, beforeUnload] of dialogs)
          if (dialog.page() === entry.page) {
            beforeUnload?.dismissed(false);
            dialogs.delete(dialog);
          }
        observation.retirePage(entry.id);
        pageControl.closed(entry);
        captures.forget(entry);
        events.pageClosed?.(entry.id);
      },
      navigating: (entry, frame) => pageControl.navigating(entry, frame),
      navigated: (entry, frame) => {
        if (initialized) initialization.attachFrame(frame, entry.page);
      },
      sameDocumentNavigated: (entry, frame) => sameDocumentCapture(entry, frame),
      frameChanged: (entry, frame) => {
        if (frame.isDetached()) events.frameClosed?.(entry.id, targets.frameId(frame));
        actions.waitChanged(entry, frame);
        // Only the frame an observation read can change what it names.
        observation.invalidate({ pageId: entry.id, frameId: targets.frameId(frame) });
        captures.invalidate(entry, "target-changed", frame);
      },
      dialog: (entry, dialog) => {
        // Capture the exact navigation now. A page lookup after acknowledgement could name its successor.
        const beforeUnload =
          dialog.type() === "beforeunload" ? actions.beforeUnload(entry.id) : undefined;

        const overflow = dialogs.size >= 8;

        if (options.dialogPolicy === "dismiss" || overflow)
          void policyCleanup.run(dialog, () => dialog.dismiss(), {
            ...(overflow ? { overflow: "dialog-overflow" } : {}),
            settled: (disposition) => beforeUnload?.dismissed(disposition === "confirmed"),
          });
        else {
          dialogs.set(dialog, beforeUnload);
          observation.invalidate({ pageId: entry.id });
          events.pause("dialog", entry.id);
        }
      },
      changed: (reason, scope) => observation.changed(reason, scope),
    },
    {
      open: async () => {
        if (!windows) return undefined;
        const cdp = browserSession();
        let created: unknown;

        try {
          created = await cdp.send("Target.createTarget", { url: "about:blank", newWindow: true });
        } catch (error) {
          if (!refusedBy("Target.createTarget", error)) throw error;
          windows = false;

          return undefined;
        }
        const { targetId } = safeDecode(CreatedTarget, created);

        return {
          targetId,
          // The browser sizes a new window like the last one it showed, which may be a popup's, so
          // a fixed viewport is set on each. A preserved viewport is the provider's to size.
          sized: options.preserveViewport ? Promise.resolve() : sizeNativeWindow(targetId),
          discard: async () => {
            await cdp.send("Target.closeTarget", { targetId });
          },
        };
      },
    },
  );

  const { current, entries, register } = targets;

  const initialization = makeInitialization(
    context,
    options,
    identity.bindings,
    targets,
    callbacks,
    events,
    () => closing,
  );

  const observation = makeObservation(
    targets,
    identity.namespace,
    events,
    options.observationLimits,
  );

  const actions = makeActions(
    context,
    targets,
    observation,
    (error) => error instanceof errors.TimeoutError,
  );

  const pointer = makePointer(targets, actions);

  actions.setPointerInvalidator(pointer.invalidate);
  const keyboard = makeKeyboard(targets, actions, pointer.receipt);
  const captures = makeCaptureSources(targets);

  sameDocumentCapture = captures.sameDocumentNavigated;

  const pageControl = makePageControl(
    browser,
    context,
    options,
    identity.namespace,
    targets,
    callbacks,
    events,
    () => closing,
    (pageId) => observation.held(pageId),
  );

  const onPage = (page: Page) => {
    register(page);
  };

  const retired = () => {
    policyCleanup.retired();
    keyboard.retire();
    actions.retireWait();
    observation.retireConnection();
    events.retired?.();
  };

  const onDisconnected = () => {
    retired();
    if (!closing) {
      observation.invalidate();
      events.disconnected();
    }
  };

  context.on("page", onPage);
  browser.on("disconnected", onDisconnected);

  const browserSession = (): CDPSession => {
    if (browserCdp === undefined) throw failure(Reasons.Closed.make({}), "undispatched");

    return browserCdp;
  };

  const sizeNativeWindow = async (targetId: string): Promise<void> => {
    const cdp = browserSession();
    const current: unknown = await cdp.send("Browser.getWindowForTarget", { targetId });
    const native = safeDecode(NativeWindow, current);

    await cdp.send("Browser.setContentsSize", {
      windowId: native.windowId,
      width: options.viewport.width,
      height: options.viewport.height,
    });
  };

  const sizeNativeContents = async (entry: Entry): Promise<void> =>
    sizeNativeWindow(await targets.targetId(entry));

  const driver: Driver = {
    ...(options.pageControl
      ? {
          pageControl: pageControl.operations,
        }
      : {}),
    selected: targets.selected,
    selectedTargetId: targets.selectedTargetId,
    listPages: targets.listPages,
    describePage: targets.describePage,
    resolvePage: targets.resolvePage,
    selectPage: targets.selectPage,
    newPage: targets.newPage,
    closePage: targets.closePage,
    containPage: targets.containPage,
    listFrames: targets.listFrames,
    resolveFrame: targets.resolveFrame,
    selectFrame: targets.selectFrame,
    beginNavigation: actions.beginNavigation,
    readText: observation.readText,
    observe: observation.observe,
    checkpoint: observation.checkpoint,
    controlFacts: observation.controlFacts,
    revalidate: observation.revalidate,
    click: actions.click,
    fill: actions.fill,
    formStep: actions.formStep,
    formState: observation.formState,
    formSubmit: actions.formSubmit,
    selectOption: actions.selectOption,
    scroll: actions.scroll,
    pointerMove: pointer.pointerMove,
    hover: pointer.hover,
    wheel: pointer.wheel,
    press: keyboard.press,
    type: keyboard.type,
    screenshot: observation.screenshot,
    resize: (viewport, ticket, target) =>
      sanitize(async () => {
        const { entry } = current(target);
        const { page } = entry;

        ticket.dispatch();
        captures.invalidate(entry, "resized");
        observation.changed("resized", { pageId: entry.id });
        await page.setViewportSize(viewport);
        ticket.acknowledge?.();
        ticket.check();
      }),
    waitFor: actions.waitFor,
    waitForElement: actions.waitForElement,
    clickAndWait: actions.clickAndWait,
    clickForDownload: actions.clickForDownload,
    selectFiles: actions.selectFiles,
    clickForFileSelection: actions.clickForFileSelection,
    documentReadiness: initialization.documentReadiness,
    dismissDialogs: (ticket) =>
      sanitize(async () => {
        for (const [dialog, beforeUnload] of dialogs) {
          const disposition = await policyCleanup.run(dialog, () => dialog.dismiss(), {
            dispatch: () => ticket.dispatch(),
            settled: (disposition) => beforeUnload?.dismissed(disposition === "confirmed"),
          });

          if (disposition === "confirmed") {
            ticket.acknowledge?.();
            ticket.followUp?.();
          }
          ticket.check();
          if (disposition !== "confirmed")
            throw failure(
              disposition === "not-dispatched" ? Reasons.Busy.make({}) : Reasons.Provider.make({}),
              disposition === "not-dispatched" ? "undispatched" : "unknown",
            );
          dialogs.delete(dialog);
        }
      }),
    capture: captures.capture,
    invalidateObservation: observation.invalidate,
    fenceInitialization: initialization.fence,
    fenceInitializationPage: initialization.fencePage,
    restoreInitializationPage: initialization.restorePage,
    handoffDrained: () =>
      initialization.drained() &&
      callbacks.drained() &&
      policyCleanup.drained() &&
      observation.drained() &&
      keyboard.drained(),
    retireInitializationPage: initialization.retirePage,
    disposeInitialization: initialization.dispose,
    disconnect: () =>
      sanitize(async () => {
        closing = true;
        initialization.fence();
        callbacks.stop();
        observation.invalidate();
        context.off("page", onPage);
        // Explicit cleanup owns its close result. Preserve the established ordering by removing
        // the ordinary disconnect listener first; positive retirement is recorded only after the
        // close below actually settles. Natural disconnects still retire through onDisconnected.
        browser.off("disconnected", onDisconnected);
        for (const entry of entries.values()) for (const off of entry.off.splice(0)) off();
        // Retained dialogs share their one dismissal with explicit resume. A timed-out dismissal
        // stays in the pool and is never sent a second time by connection cleanup.
        for (const [dialog, beforeUnload] of dialogs)
          void policyCleanup.run(dialog, () => dialog.dismiss(), {
            settled: (disposition) => beforeUnload?.dismissed(disposition === "confirmed"),
          });
        captures.clear();
        await closeWithin(initialization.dispose).catch(() => {});
        await observation.dispose().catch(() => {});
        await closeWithin(() => policyCleanup.settle()).catch(() => {});
        policyCleanup.stop();
        dialogs.clear();
        await closeWithin(() => callbacks.settle()).catch(() => {});
        await closeWithin(() => pageControl.dispose()).catch(() => {});
        await closeWithin(() => browserCdp?.detach() ?? Promise.resolve()).catch(() => {});
        await closeWithin(() => browser.close());
        retired();
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
    await initialization.install();
    for (const entry of entries.values()) await initialization.attach(entry.page);
    await targets.selectInitial();
    const { selection } = targets;

    if (selection.entry === undefined) throw failure(Reasons.NotFound.make({}));
    await initialization.attach(selection.entry.page);
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
