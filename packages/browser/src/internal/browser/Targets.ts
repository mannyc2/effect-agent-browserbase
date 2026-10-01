import { Schema } from "effect";
import type { Browser, BrowserContext, Dialog, Frame, Page } from "playwright-core";

import { FrameInfo, PageInfo, Identifier } from "../../BrowserData.ts";
import { Reasons } from "../../Errors.ts";
import type {
  DriverOptions,
  DriverTarget,
  NativeCachedPage,
  NativePageLifecycle,
} from "./Driver.ts";
import { closeWithin, failure, safeDecode, sanitize } from "./NativeCalls.ts";
import type { ObservationScope, Ticket } from "./Owner.ts";
import type { PageExecution } from "./PageExecution.ts";

const TargetInfo = Schema.Struct({
  targetInfo: Schema.Struct({ targetId: Identifier, type: Schema.Literal("page") }),
});

const URLText = Schema.String.check(Schema.isMaxLength(8192));

export interface Entry {
  readonly id: string;
  readonly page: Page;
  targetId?: string;
  /** Undefined until read; null records an omitted oversized native title. */
  cachedTitle?: string | null;
  readonly off: Array<() => void>;
  execution?: Promise<PageExecution>;
  executionValue?: PageExecution;
}

/** The selected page and frame. Only the registry and the connection's own setup assign it. */
export interface Selection {
  entry?: Entry;
  frame?: Frame;
}

/**
 * What the other driver seams do when a registered page changes. The registry calls each at one
 * fixed point of its own event handling, so their order relative to its state never moves.
 */
export interface TargetHooks {
  readonly lifecycle?: (event: NativePageLifecycle) => void;
  /** A tracked page was registered; `created` while this driver is opening the page itself. */
  readonly opened: (entry: Entry, created: boolean) => void;
  /**
   * A page registered while this driver was opening one, which turned out to be another page:
   * a popup, say. It is now treated as any page from outside is.
   */
  readonly external: (entry: Entry) => void;
  /** An excess page is never admitted to this registry; its configured policy owns cleanup. */
  readonly overflow: (entry: Entry) => void;
  /** Before a closed page leaves the registry. */
  readonly closed: (entry: Entry) => void;
  /** Before a navigated frame's document epoch advances. */
  readonly navigating: (entry: Entry, frame: Frame) => void;
  /** After a navigated frame's document epoch advances. */
  readonly navigated: (entry: Entry, frame: Frame) => void;
  /** A URL changed inside the current document; no observation or document epoch is retired. */
  readonly sameDocumentNavigated: (entry: Entry, frame: Frame) => void;
  /** A frame navigated or detached, before any consequence for the selection. */
  readonly frameChanged: (entry: Entry, frame: Frame) => void;
  readonly dialog: (entry: Entry, dialog: Dialog) => void;
  /** Selection changes notify the owner without retiring another page's retained nodes. */
  readonly changed: (reason: "target-changed", scope: ObservationScope) => void;
}

/**
 * Where the pages this driver opens come from. Chromium paints only the front tab of a window,
 * so a screenshot of a tab behind it waits seconds for a compositor frame, or never gets one. A
 * page in a window of its own is painted whether or not another page is in front.
 */
export interface Windows {
  /**
   * Asks the browser for a blank page in a new window, and returns its target id with the sizing
   * of that window still in flight. Undefined when the browser refused the window, which means it
   * created nothing: a tab is then the only page it offers.
   */
  readonly open: () => Promise<OpenedWindow | undefined>;
}

export interface OpenedWindow {
  readonly targetId: string;
  readonly sized: Promise<void>;
  /** Closes the window's page by its target id, for a page this driver never adopted. */
  readonly discard: () => Promise<void>;
}

interface ClientFrameNavigation {
  readonly newDocument?: unknown;
  readonly error?: unknown;
}

interface ClientFrame {
  readonly _eventEmitter: {
    readonly on: (event: "navigated", listener: (event: ClientFrameNavigation) => void) => void;
    readonly off: (event: "navigated", listener: (event: ClientFrameNavigation) => void) => void;
  };
}

/**
 * Playwright 1.63.0's client Frame emits this synchronous private event before the public Page
 * `framenavigated` event. Its `newDocument` field distinguishes document commits from URL-only
 * changes. A missing emitter is an unsupported runtime, never a reason to guess from the URL.
 */
const clientNavigationEmitter = (frame: Frame): ClientFrame["_eventEmitter"] => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- accesses the exact pinned client seam described above
  const emitter = (frame as unknown as ClientFrame)._eventEmitter;

  if (typeof emitter?.on !== "function" || typeof emitter.off !== "function")
    throw new Error("Playwright 1.63.0 client Frame navigation event is unavailable");

  return emitter;
};

/**
 * The connection's pages, frames and document epochs, and the one selected target every other
 * seam acts on. A page beyond the configured bound is handed to policy recovery, never tracked.
 */
export const makeTargets = (
  browser: Browser,
  context: BrowserContext,
  options: DriverOptions,
  /**
   * FrameInfo is connection-local public metadata. A new driver after reconnect must never
   * regenerate an old frame id for a different frame, even when serial order happens to match.
   */
  connectionNamespace: string,
  closing: () => boolean,
  hooks: TargetHooks,
  windows: Windows,
) => {
  const entries = new Map<string, Entry>();
  const byPage = new WeakMap<Page, Entry>();
  const frameIds = new WeakMap<Frame, string>();
  // A frame object outlives its documents, so readiness is keyed by frame *and* epoch.
  const documentEpochs = new WeakMap<Frame, number>();
  const selection: Selection = {};
  // Pages whose navigation this driver began and has not seen settle.
  const navigating = new Set<string>();

  let serial = 0,
    frameSerial = 0;

  let creatingPage = false;
  // Told of every page registered while this driver opens one, since the event brings it here.
  const arrivals = new Set<(entry: Entry) => void>();

  const epochOf = (frame: Frame): number => documentEpochs.get(frame) ?? 0;

  const frameId = (frame: Frame): string => {
    let id = frameIds.get(frame);

    if (id === undefined) {
      id = `frame-${connectionNamespace}-${++frameSerial}`;
      frameIds.set(frame, id);
    }

    return id;
  };

  const cachedPage = (entry: Entry): NativeCachedPage => {
    const frame = entry.page.mainFrame();
    const url = frame.url();
    let displayState: NativeCachedPage["displayState"] = "unknown";

    try {
      displayState = entry.executionValue?.state().state ?? "unknown";
    } catch {
      // Native retirement can precede the registry close listener; no native read repairs it.
    }

    return Object.freeze({
      pageId: entry.id,
      frameId: frameId(frame),
      targetId: entry.targetId ?? null,
      documentEpoch: epochOf(frame),
      url: url.length <= 8192 ? url : null,
      urlQualification: url.length <= 8192 ? "NativeCached" : "Omitted",
      title: entry.cachedTitle ?? null,
      titleQualification:
        entry.cachedTitle === undefined
          ? "Unread"
          : entry.cachedTitle === null
            ? "Omitted"
            : "ObservedCached",
      selected: selection.entry === entry,
      displayState,
    });
  };

  const notify = (entry: Entry, kind: "Opened" | "Metadata" | "Display") => {
    if (entries.get(entry.id) === entry) hooks.lifecycle?.({ _tag: kind, page: cachedPage(entry) });
  };

  const navigated = (entry: Entry, frame: Frame, sameDocument: boolean) => {
    const url = frame.url();

    hooks.lifecycle?.({
      _tag: "Navigated",
      page: cachedPage(entry),
      frameId: frameId(frame),
      documentEpoch: epochOf(frame),
      sameDocument,
      url: url.length <= 8192 ? url : null,
      urlQualification: url.length <= 8192 ? "NativeCached" : "Omitted",
    });
  };

  const retire = (entry: Entry): void => {
    if (entries.get(entry.id) !== entry) return;
    hooks.closed(entry);
    entries.delete(entry.id);
    navigating.delete(entry.id);
    for (const off of entry.off.splice(0)) off();
    if (selection.entry !== entry) return;
    selection.entry = undefined;
    selection.frame = undefined;
    for (const candidate of entries.values()) {
      const frame = candidate.page.mainFrame();

      if (candidate.page.isClosed() || frame.isDetached()) continue;
      try {
        candidate.executionValue?.assertRunning();
      } catch {
        continue;
      }
      selection.entry = candidate;
      selection.frame = frame;
      break;
    }
    hooks.changed("target-changed", { pageId: entry.id });
    if (selection.entry !== undefined) notify(selection.entry, "Display");
  };

  const register = (page: Page): Entry => {
    const existing = byPage.get(page);

    if (existing !== undefined) return existing;
    const entry: Entry = { id: `page-${connectionNamespace}-${++serial}`, page, off: [] };

    byPage.set(page, entry);
    for (const arrived of arrivals) arrived(entry);
    if (entries.size >= options.maxPages) {
      hooks.overflow(entry);

      return entry;
    }
    entries.set(entry.id, entry);
    const sameDocumentNavigations = new WeakSet<Frame>();
    const frameNavigationOff = new WeakMap<Frame, () => void>();

    const watchFrameNavigation = (frame: Frame): void => {
      if (frameNavigationOff.has(frame)) return;
      const emitter = clientNavigationEmitter(frame);

      const onNavigated = (event: ClientFrameNavigation) => {
        if (event.error !== undefined || event.newDocument !== undefined) return;
        sameDocumentNavigations.add(frame);
        navigated(entry, frame, true);
        hooks.sameDocumentNavigated(entry, frame);
      };

      emitter.on("navigated", onNavigated);
      const off = () => emitter.off("navigated", onNavigated);

      frameNavigationOff.set(frame, off);
      entry.off.push(off);
    };

    for (const frame of page.frames()) {
      frameId(frame);
      watchFrameNavigation(frame);
    }

    const onClose = () => {
      retire(entry);
    };

    const onNavigation = (frame: Frame) => {
      // The private client event above runs synchronously before this public event.
      if (sameDocumentNavigations.delete(frame)) return;
      hooks.navigating(entry, frame);
      documentEpochs.set(frame, epochOf(frame) + 1);
      if (frame === page.mainFrame()) entry.cachedTitle = undefined;
      hooks.navigated(entry, frame);
      navigated(entry, frame, false);
      frameId(frame);
      hooks.frameChanged(entry, frame);
      if (selection.entry === entry && (selection.frame === frame || frame === page.mainFrame()))
        hooks.changed("target-changed", { pageId: entry.id });
    };

    const onDetached = (frame: Frame) => {
      const off = frameNavigationOff.get(frame);

      off?.();
      const cleanupIndex = off === undefined ? -1 : entry.off.indexOf(off);

      if (cleanupIndex !== -1) entry.off.splice(cleanupIndex, 1);
      frameNavigationOff.delete(frame);
      hooks.frameChanged(entry, frame);
      if (selection.frame === frame) {
        selection.frame = undefined;
        hooks.changed("target-changed", { pageId: entry.id });
      }
    };

    const onDialog = (dialog: Dialog) => {
      hooks.dialog(entry, dialog);
    };

    const onFrameAttached = (frame: Frame) => {
      frameId(frame);
      watchFrameNavigation(frame);
    };

    page.on("close", onClose);
    page.on("frameattached", onFrameAttached);
    page.on("framenavigated", onNavigation);
    page.on("framedetached", onDetached);
    page.on("dialog", onDialog);
    entry.off.push(
      () => page.off("close", onClose),
      () => page.off("frameattached", onFrameAttached),
      () => page.off("framenavigated", onNavigation),
      () => page.off("framedetached", onDetached),
      () => page.off("dialog", onDialog),
    );
    hooks.opened(entry, creatingPage);
    notify(entry, "Opened");

    return entry;
  };

  /** Bootstrap callbacks may name only an exact page still owned by this registry. */
  const pageIdOf = (page: Page): string | undefined => {
    const entry = byPage.get(page);

    return entry !== undefined && entries.get(entry.id) === entry && !page.isClosed()
      ? entry.id
      : undefined;
  };

  const selectedCurrent = () => {
    if (
      closing() ||
      !browser.isConnected() ||
      selection.entry === undefined ||
      selection.entry.page.isClosed() ||
      selection.frame === undefined ||
      selection.frame.isDetached()
    )
      throw failure(Reasons.Closed.make({}), "undispatched");

    return { entry: selection.entry, frame: selection.frame };
  };

  const explicitCurrent = (target: DriverTarget) => {
    if (closing() || !browser.isConnected()) throw failure(Reasons.Closed.make({}), "undispatched");
    const entry = entries.get(target.pageId);

    if (entry === undefined || entry.page.isClosed())
      throw failure(Reasons.Stale.make({}), "undispatched");
    const frame = entry.page.frames().find((candidate) => frameId(candidate) === target.frameId);

    if (frame === undefined || frame.isDetached())
      throw failure(Reasons.Stale.make({}), "undispatched");

    return { entry, frame };
  };

  const current = (target?: DriverTarget) =>
    target === undefined ? selectedCurrent() : explicitCurrent(target);

  const targetId = async (entry: Entry, ticket?: Ticket): Promise<string> => {
    ticket?.check();
    if (entry.targetId !== undefined) return entry.targetId;
    const cdp = await context.newCDPSession(entry.page);

    try {
      ticket?.check();
      const info: unknown = await cdp.send("Target.getTargetInfo");

      ticket?.check();
      entry.targetId = safeDecode(TargetInfo, info).targetInfo.targetId;
      notify(entry, "Metadata");

      return entry.targetId;
    } finally {
      await closeWithin(() => cdp.detach()).catch(() => {});
    }
  };

  const urlOf = (frame: Frame) => safeDecode(URLText, frame.url());

  /**
   * Opens one page: in a window of its own when the browser opens one, else as a tab. The window's
   * page arrives through the context's page event like any other, and its target id tells it
   * apart from a popup arriving at the same time. It is registered, and sized, when this returns.
   */
  const open = async (signal: AbortSignal): Promise<Entry> => {
    const arrived: Entry[] = [];
    let wake = () => {};

    const arrival = (entry: Entry) => {
      arrived.push(entry);
      wake();
    };

    const next = () =>
      new Promise<void>((resolve, reject) => {
        const abort = () => reject(failure(Reasons.Interrupted.make({}), "unknown"));

        if (signal.aborted) {
          abort();

          return;
        }
        signal.addEventListener("abort", abort, { once: true });
        wake = () => {
          signal.removeEventListener("abort", abort);
          resolve();
        };
      });

    const adopt = async (created: string): Promise<Entry> => {
      for (let index = 0; ; index++) {
        while (arrived.length <= index) await next();
        const candidate = arrived[index];
        // A page whose id cannot be read, such as a popup already closing, is not this one.
        const id = candidate === undefined ? undefined : await targetId(candidate).catch(() => {});

        if (candidate !== undefined && id === created) return candidate;
      }
    };

    /** Every other page that arrived meanwhile is from outside, and its policy applies now. */
    const settle = (isOurs: (entry: Entry) => boolean) => {
      for (const entry of arrived)
        if (!isOurs(entry) && entries.get(entry.id) === entry) hooks.external(entry);
    };

    arrivals.add(arrival);
    try {
      const opened = await windows.open();

      if (opened === undefined) {
        const entry = register(await context.newPage());

        settle((candidate) => candidate === entry);

        return entry;
      }
      try {
        const [entry] = await Promise.all([adopt(opened.targetId), opened.sized]);

        settle((candidate) => candidate === entry);

        return entry;
      } catch (error) {
        // Whatever went wrong after the browser opened the window, that window is not kept.
        await closeWithin(opened.discard).catch(() => {});
        // Only a page known to be another one is let through; the window may be any unread one.
        settle(
          (candidate) => candidate.targetId === undefined || candidate.targetId === opened.targetId,
        );
        throw error;
      }
    } finally {
      arrivals.delete(arrival);
    }
  };

  const selectedUrl = () => urlOf(selectedCurrent().frame);
  const url = (target?: DriverTarget) => urlOf(current(target).frame);

  /**
   * Chooses the connection's first target: a page it opens itself, the one the caller named, or
   * the only page present. Assignments land on the live selection as they happen.
   */
  const selectInitial = async (): Promise<void> => {
    if (options.newPage || entries.size === 0) {
      creatingPage = true;
      try {
        selection.entry = await open(AbortSignal.timeout(15000));
      } finally {
        creatingPage = false;
      }
    } else if (options.initialTargetId !== undefined) {
      for (const entry of entries.values())
        if ((await targetId(entry)) === options.initialTargetId) selection.entry = entry;
      if (selection.entry === undefined) throw failure(Reasons.NotFound.make({}));
    } else {
      if (entries.size !== 1) throw failure(Reasons.Ambiguous.make({}));
      selection.entry = entries.values().next().value;
    }
  };

  const clear = () => {
    entries.clear();
    selection.entry = undefined;
    selection.frame = undefined;
  };

  const selected = () => {
    const { entry, frame } = current();

    return { pageId: entry.id, frameId: frameId(frame) };
  };

  /** Detach records the selected page alone; none of its frames can make that fail. */
  const selectedTargetId = () =>
    sanitize(() => {
      const entry = selection.entry;

      if (closing() || !browser.isConnected() || entry === undefined || entry.page.isClosed())
        throw failure(Reasons.Closed.make({}), "undispatched");

      return targetId(entry);
    });

  /** Describe this exact entry, including when creation has already dispatched. */
  const pageInfo = async (entry: Entry, ticket: Ticket): Promise<PageInfo> => {
    const id = await targetId(entry, ticket);

    ticket.check();
    const title: unknown = await entry.page.title();

    ticket.check();
    if (entries.get(entry.id) !== entry || entry.page.isClosed())
      throw failure(Reasons.Stale.make({}), ticket.dispatched ? "unknown" : "undispatched");
    if (typeof title !== "string") throw failure(Reasons.Malformed.make({ path: "page.title" }));
    entry.cachedTitle = title.length <= 512 ? title : null;
    notify(entry, "Metadata");

    return safeDecode(PageInfo, {
      pageId: entry.id,
      targetId: id,
      title: title.slice(0, 512),
      url: entry.page.url(),
      selected: selection.entry === entry,
    });
  };

  /** Each page's title is its own round trip, so they are read together rather than in turn. */
  const listPages = (ticket: Ticket) =>
    sanitize(async () => {
      ticket.check();

      return Promise.all([...entries.values()].map((entry) => pageInfo(entry, ticket)));
    });

  const explicitPage = async (page: PageInfo, ticket: Ticket): Promise<Entry> => {
    ticket.check();
    const entry = entries.get(page.pageId);

    if (entry === undefined || entry.page.isClosed())
      throw failure(Reasons.NotFound.make({}), "undispatched");
    if ((await targetId(entry, ticket)) !== page.targetId)
      throw failure(Reasons.Stale.make({}), "undispatched");
    ticket.check();
    if (entries.get(entry.id) !== entry || entry.page.isClosed())
      throw failure(Reasons.Stale.make({}), "undispatched");

    return entry;
  };

  const describePage = (page: PageInfo, ticket: Ticket) =>
    sanitize(async () => pageInfo(await explicitPage(page, ticket), ticket));

  const resolvePage = (page: PageInfo, ticket: Ticket) =>
    sanitize(async () => {
      const entry = await explicitPage(page, ticket);

      return { pageId: entry.id, frameId: frameId(entry.page.mainFrame()) };
    });

  const selectPage = (page: PageInfo, ticket: Ticket) =>
    sanitize(async () => {
      const entry = await explicitPage(page, ticket);
      const previous = selection.entry;

      ticket.check();
      if (entries.get(entry.id) !== entry || entry.page.isClosed())
        throw failure(Reasons.Stale.make({}), "undispatched");
      selection.entry = entry;
      selection.frame = entry.page.mainFrame();
      hooks.changed("target-changed", "none");
      if (previous !== undefined && previous !== entry) notify(previous, "Display");
      notify(entry, "Display");
    });

  const newPage = (ticket: Ticket) =>
    sanitize(async () => {
      if (entries.size >= options.maxPages)
        throw failure(
          Reasons.Limit.make({
            dimension: "pages",
            maximum: options.maxPages,
            observed: entries.size,
          }),
          "undispatched",
        );
      ticket.dispatch();
      creatingPage = true;
      let entry: Entry;

      try {
        entry = await open(ticket.signal);

        if (ticket.signal.aborted) {
          await closeWithin(() => entry.page.close()).catch(() => {});
          ticket.check();
        }
      } finally {
        creatingPage = false;
      }

      ticket.acknowledge?.();
      ticket.followUp?.();

      // Creation never selects or relists. A failed metadata read cannot repeat the creation.
      return pageInfo(entry, ticket);
    });

  const closePage = (page: PageInfo, ticket: Ticket, onDispatch?: () => void) =>
    sanitize(async () => {
      const entry = await explicitPage(page, ticket);

      ticket.dispatch();
      onDispatch?.();
      await entry.page.close({ runBeforeUnload: false });
      if (!entry.page.isClosed()) throw failure(Reasons.Failed.make({}), "unknown");
      ticket.acknowledge?.();
      ticket.followUp?.();
      retire(entry);
      ticket.check();
    });

  const containPage = async (pageId: string): Promise<void> => {
    const entry = entries.get(pageId);

    // A closed page has already left the registry.
    if (entry === undefined) return;
    await closeWithin(() => entry.page.close({ runBeforeUnload: false }));
    if (!entry.page.isClosed()) throw failure(Reasons.Failed.make({}));
    retire(entry);
  };

  const listFrames = (ticket: Ticket, page?: PageInfo) =>
    sanitize(async () => {
      ticket.check();
      const entry = page === undefined ? selectedCurrent().entry : await explicitPage(page, ticket);
      const frames = entry.page.frames();

      if (frames.length > 128)
        throw failure(
          Reasons.Limit.make({ dimension: "frames", maximum: 128, observed: frames.length }),
        );

      return frames.map((frame) => {
        const parent = frame.parentFrame();

        return safeDecode(FrameInfo, {
          frameId: frameId(frame),
          parentFrameId: parent === null ? null : frameId(parent),
          url: frame.url(),
          name: frame.name().slice(0, 256),
        });
      });
    });

  const resolveFrame = (page: PageInfo, requested: FrameInfo, ticket: Ticket) =>
    sanitize(async () => {
      const entry = await explicitPage(page, ticket);

      const frame = entry.page
        .frames()
        .find((candidate) => frameId(candidate) === requested.frameId);

      if (frame === undefined || frame.isDetached())
        throw failure(Reasons.NotFound.make({}), "undispatched");
      ticket.check();

      return { pageId: entry.id, frameId: frameId(frame) };
    });

  return {
    entries: entries as ReadonlyMap<string, Entry>,
    cachedPages: () => Object.freeze([...entries.values()].map(cachedPage)),
    cachedPage,
    notifyDisplay: (entry: Entry) => notify(entry, "Display"),
    selection,
    epochOf,
    frameId,
    register,
    pageIdOf,
    current,
    targetId,
    urlOf,
    /** A navigation this driver began on the page is still in flight. */
    navigating: {
      begin: (pageId: string) => void navigating.add(pageId),
      end: (pageId: string) => void navigating.delete(pageId),
      has: (pageId: string) => navigating.has(pageId),
    },
    selectedUrl,
    url,
    selectInitial,
    clear,
    selected,
    selectedTargetId,
    listPages,
    describePage,
    resolvePage,
    selectPage,
    newPage,
    closePage,
    containPage,
    listFrames,
    resolveFrame,
  };
};

export type Targets = ReturnType<typeof makeTargets>;
