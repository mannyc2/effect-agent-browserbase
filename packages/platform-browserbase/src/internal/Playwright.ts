import { Schema } from "effect";
import type {
  Browser,
  BrowserContext,
  CDPSession,
  Dialog,
  Download,
  ElementHandle,
  Frame,
  JSHandle,
  Page,
} from "playwright-core";

import type { ObservedElement } from "../Types.ts";
import {
  BrowserbaseError,
  FrameInfo,
  Identifier,
  ObservedControl,
  PageInfo,
  SafeFilename,
} from "../Types.ts";
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
  NativeObservation,
} from "./Driver.ts";
import { pngGeometry } from "./Images.ts";
import type { Ticket } from "./Owner.ts";

const failure = (
  operation: string,
  reason: BrowserbaseError["reason"],
  outcome?: BrowserbaseError["outcome"],
) => BrowserbaseError.make({ operation, reason, ...(outcome === undefined ? {} : { outcome }) });

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

const Count = Schema.Natural.check(Schema.isLessThanOrEqualTo(1000000));
const URLText = Schema.String.check(Schema.isMaxLength(8192));

interface Entry {
  readonly id: string;
  readonly page: Page;
  targetId?: string;
  readonly off: Array<() => void>;
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
      throw Schema.is(BrowserbaseError)(error) ? error : failure(operation, "provider");
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
    chromium.connectOverCDP(connection, { timeout: 15000 }),
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
    throw Schema.is(BrowserbaseError)(error) ? error : failure("connect", "provider");
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

  const invalidateObservation = () => {
    if (observation !== undefined) observation.valid = false;
  };

  const changed = (reason: Parameters<DriverEvents["invalidate"]>[0]) => {
    invalidateObservation();
    events.invalidate(reason);
  };

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
    let reject: (error: BrowserbaseError) => void = () => {};

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

  const driver: Driver = {
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
          start: (callback, quality, invalidate) =>
            sanitize("capture-start", async () => {
              watcherSet = captureWatchers.get(entry.id) ?? new Set<CaptureWatcher>();
              captureWatchers.set(entry.id, watcherSet);
              watcher = { frameId: watchedFrameId, invalidate };
              watcherSet.add(watcher);
              try {
                await page.screencast.start({
                  quality,
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
    disconnect: () =>
      sanitize("disconnect", async () => {
        closing = true;
        callbacks.stop();
        invalidateObservation();
        context.off("page", onPage);
        browser.off("disconnected", onDisconnected);
        for (const entry of entries.values()) for (const off of entry.off.splice(0)) off();
        captureWatchers.clear();
        await disposeObservation().catch(() => {});
        await closeWithin(() =>
          Promise.allSettled([...dialogs].map((dialog) => dialog.dismiss())),
        ).catch(() => {});
        dialogs.clear();
        await closeWithin(() => callbacks.settle()).catch(() => {});
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
    selectedFrame = selected.page.mainFrame();
    if (!options.preserveViewport) await selected.page.setViewportSize(options.viewport);
    await getTargetId(selected);
    initialized = true;

    return driver;
  } catch (error) {
    await driver.disconnect().catch(() => {});
    throw error;
  }
};
