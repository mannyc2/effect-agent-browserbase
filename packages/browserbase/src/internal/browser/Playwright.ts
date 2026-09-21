import { Schema } from "effect";
import type { Browser, BrowserContext, CDPSession, Dialog, Page } from "playwright-core";

import { BrowserError, InitializationError } from "../../Errors.ts";
import { makeActions } from "./Actions.ts";
import { CallbackTasks } from "./CallbackTasks.ts";
import { makeCaptureSources } from "./CaptureSource.ts";
import type { Driver, DriverEvents, DriverOptions } from "./Driver.ts";
import { makeInitialization } from "./Initialization.ts";
import { closeWithin, failure, NativeFailure, safeDecode, sanitize } from "./NativeCalls.ts";
import { makePageControl } from "./NativePageControl.ts";
import { makeObservation } from "./Observation.ts";
import { type Entry, makeTargets } from "./Targets.ts";

const NativeWindow = Schema.Struct({ windowId: Schema.Natural });

/**
 * The provider-issued address is accepted only as a credential-free Browserbase WSS URL. Every
 * binding applies this first, including one a host routes elsewhere, so routing can never be
 * reached with an address the provider did not plausibly issue.
 */
export const validateConnection = (connection: unknown): string => {
  if (typeof connection !== "string" || connection.length > 16384) throw failure("malformed");
  let url: URL;

  try {
    url = new URL(connection);
  } catch {
    throw failure("malformed");
  }
  if (
    url.protocol !== "wss:" ||
    url.username ||
    url.password ||
    url.port ||
    !url.hostname.endsWith(".browserbase.com")
  )
    throw failure("unsafe-url");

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
  if (signal.aborted) throw failure("interrupted");
  const { chromium } = await import("playwright-core");

  const browser = await sanitize(() =>
    chromium.connectOverCDP(endpoint, {
      timeout: 15000,
      ...(options.pageControl ? { noDefaults: true } : {}),
    }),
  );

  if (signal.aborted) {
    await closeWithin(() => browser.close()).catch(() => {});
    throw failure("interrupted");
  }
  try {
    observe?.(browser);
    const driver = await makePlaywrightDriver(browser, options, events);

    if (signal.aborted) {
      await driver.disconnect().catch(() => {});
      throw failure("interrupted");
    }

    return driver;
  } catch (error) {
    await closeWithin(() => browser.close()).catch(() => {});
    throw Schema.is(BrowserError)(error) ||
      Schema.is(InitializationError)(error) ||
      Schema.is(NativeFailure)(error)
      ? error
      : failure("provider");
  }
};

/** Tests may supply a real already-connected browser. This is deliberately not an exported subpath. */
export const makePlaywrightDriver = async (
  browser: Browser,
  options: DriverOptions,
  events: DriverEvents,
): Promise<Driver> => {
  const contexts = browser.contexts();

  if (contexts.length !== 1) throw failure("ambiguous");
  const context: BrowserContext = contexts[0];
  const dialogs = new Set<Dialog>();
  const callbacks = new CallbackTasks(32, () => events.fault());

  let closing = false;
  let initialized = false;
  let browserCdp: CDPSession | undefined;

  const targets = makeTargets(browser, context, options, callbacks, events, () => closing, {
    opened: (entry, created) => {
      if (initialized && options.pageControl)
        callbacks.submit(async () => {
          await pageControl.execution(entry);
        });
      if (initialized) initialization.attachPage(entry.page);
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
      if (initialized) initialization.attachFrame(frame, entry.page);
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
    if (browserCdp === undefined) throw failure("closed", "undispatched");
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
    selectPage: targets.selectPage,
    newPage: targets.newPage,
    closePage: targets.closePage,
    listFrames: targets.listFrames,
    selectFrame: targets.selectFrame,
    navigate: actions.navigate,
    readText: observation.readText,
    observe: observation.observe,
    click: actions.click,
    fill: actions.fill,
    scroll: actions.scroll,
    screenshot: observation.screenshot,
    resize: (viewport, ticket) =>
      sanitize(async () => {
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
    documentReadiness: initialization.documentReadiness,
    dismissDialogs: (ticket) =>
      sanitize(async () => {
        for (const dialog of [...dialogs]) {
          ticket.dispatch();
          await dialog.dismiss();
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
        browser.off("disconnected", onDisconnected);
        for (const entry of entries.values()) for (const off of entry.off.splice(0)) off();
        captures.clear();
        await closeWithin(initialization.dispose).catch(() => {});
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
    await initialization.install();
    for (const entry of entries.values()) await initialization.attach(entry.page);
    await targets.selectInitial();
    const { selection } = targets;

    if (selection.entry === undefined) throw failure("not-found");
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
