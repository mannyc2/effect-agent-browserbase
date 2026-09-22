import { Schema } from "effect";
import type { Browser, BrowserContext, CDPSession, Dialog, Page } from "playwright-core";

import { Reasons, BrowserError, InitializationError } from "../../Errors.ts";
import { makeActions } from "./Actions.ts";
import { CallbackTasks } from "./CallbackTasks.ts";
import { makeCaptureSources } from "./CaptureSource.ts";
import type { Driver, DriverEvents, DriverOptions } from "./Driver.ts";
import { makeInitialization } from "./Initialization.ts";
import { makeKeyboard } from "./Keyboard.ts";
import { closeWithin, failure, NativeFailure, safeDecode, sanitize } from "./NativeCalls.ts";
import { makePageControl } from "./NativePageControl.ts";
import { makeObservation } from "./Observation.ts";
import { makePointer } from "./Pointer.ts";
import { PolicyCleanup } from "./PolicyCleanup.ts";
import { type Entry, makeTargets } from "./Targets.ts";

const NativeWindow = Schema.Struct({ windowId: Schema.Natural });

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
    const driver = await makePlaywrightDriver(browser, options, events);

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
      : failure(Reasons.Provider.make({}));
  }
};

/** Tests may supply a real already-connected browser. This is deliberately not an exported subpath. */
export const makePlaywrightDriver = async (
  browser: Browser,
  options: DriverOptions,
  events: DriverEvents,
): Promise<Driver> => {
  // This constructor is reached only after native acquisition, including in driver tests.
  const { errors } = await import("playwright-core");
  const contexts = browser.contexts();

  if (contexts.length !== 1) throw failure(Reasons.Ambiguous.make({}));
  const context: BrowserContext = contexts[0];

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

  const targets = makeTargets(browser, context, options, () => closing, {
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
      if (initialized && !created && options.popupPolicy === "pause") events.pause("popup");
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
      actions.waitChanged(entry);
      for (const [dialog, beforeUnload] of dialogs)
        if (dialog.page() === entry.page) {
          beforeUnload?.dismissed(false);
          dialogs.delete(dialog);
        }
      observation.invalidate({ pageId: entry.id });
      pageControl.closed(entry);
      captures.invalidate(entry, "target-changed");
      captures.forget(entry);
    },
    navigating: (entry, frame) => pageControl.navigating(entry, frame),
    navigated: (entry, frame) => {
      if (initialized) initialization.attachFrame(frame, entry.page);
    },
    frameChanged: (entry, frame) => {
      actions.waitChanged(entry, frame);
      observation.invalidate({ pageId: entry.id });
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
        observation.invalidate();
        events.pause("dialog");
      }
    },
    changed: (reason, scope) => observation.changed(reason, scope),
  });

  const { current, entries, register } = targets;

  const initialization = makeInitialization(
    context,
    options,
    targets,
    callbacks,
    events,
    () => closing,
  );

  const observation = makeObservation(targets, events);

  const actions = makeActions(
    context,
    targets,
    observation,
    (error) => error instanceof errors.TimeoutError,
  );

  const pointer = makePointer(targets, actions);
  const keyboard = makeKeyboard(targets, actions, pointer.receipt);
  const captures = makeCaptureSources(targets);

  const pageControl = makePageControl(
    browser,
    context,
    options,
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
    actions.retireWait();
    observation.retireConnection();
    events.retired?.();
    browser.off("disconnected", onDisconnected);
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

  const sizeNativeContents = async (entry: Entry): Promise<void> => {
    if (browserCdp === undefined) throw failure(Reasons.Closed.make({}), "undispatched");
    const targetId = await targets.targetId(entry);
    const current: unknown = await browserCdp.send("Browser.getWindowForTarget", { targetId });
    const native = safeDecode(NativeWindow, current);

    await browserCdp.send("Browser.setContentsSize", {
      windowId: native.windowId,
      width: options.viewport.width,
      height: options.viewport.height,
    });
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
    resolvePage: targets.resolvePage,
    selectPage: targets.selectPage,
    newPage: targets.newPage,
    closePage: targets.closePage,
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
    selectOption: actions.selectOption,
    scroll: actions.scroll,
    pointerMove: pointer.pointerMove,
    hover: pointer.hover,
    wheel: pointer.wheel,
    press: keyboard.press,
    type: keyboard.type,
    screenshot: observation.screenshot,
    resize: (viewport, ticket) =>
      sanitize(async () => {
        const page = current().entry.page;
        const entry = current().entry;

        ticket.dispatch();
        captures.invalidate(entry, "resized");
        observation.changed("resized", { pageId: entry.id });
        await page.setViewportSize(viewport);
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
    disposeInitialization: initialization.dispose,
    disconnect: () =>
      sanitize(async () => {
        closing = true;
        initialization.fence();
        callbacks.stop();
        observation.invalidate();
        context.off("page", onPage);
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
        // Keep retirement observed even when the bounded cleanup waiter times out first.
        await closeWithin(async () => {
          await browser.close();
          retired();
        });
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
