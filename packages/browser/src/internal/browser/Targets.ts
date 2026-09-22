import { Schema } from "effect";
import type { Browser, BrowserContext, Dialog, Frame, Page } from "playwright-core";

import { FrameInfo, PageInfo, Identifier } from "../../BrowserData.ts";
import { Reasons } from "../../Errors.ts";
import type { CallbackTasks } from "./CallbackTasks.ts";
import type { DriverEvents, DriverOptions, DriverTarget } from "./Driver.ts";
import { closeWithin, failure, safeDecode, sanitize } from "./NativeCalls.ts";
import type { Ticket } from "./Owner.ts";
import type { PageExecution } from "./PageExecution.ts";

const TargetInfo = Schema.Struct({
  targetInfo: Schema.Struct({ targetId: Identifier, type: Schema.Literal("page") }),
});

const URLText = Schema.String.check(Schema.isMaxLength(8192));

export interface Entry {
  readonly id: string;
  readonly page: Page;
  targetId?: string;
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
  /** A tracked page was registered; `created` while this driver is opening the page itself. */
  readonly opened: (entry: Entry, created: boolean) => void;
  /** Before a closed page leaves the registry. */
  readonly closed: (entry: Entry) => void;
  /** Before a navigated frame's document epoch advances. */
  readonly navigating: (entry: Entry, frame: Frame) => void;
  /** After a navigated frame's document epoch advances. */
  readonly navigated: (entry: Entry, frame: Frame) => void;
  /** A frame navigated or detached, before any consequence for the selection. */
  readonly frameChanged: (entry: Entry, frame: Frame) => void;
  readonly dialog: (dialog: Dialog) => void;
  /** Retained observation is released before a selection is replaced. */
  readonly release: () => Promise<void>;
  readonly changed: (reason: "target-changed") => void;
}

/**
 * The connection's pages, frames and document epochs, and the one selected target every other
 * seam acts on. A page beyond the configured bound is closed and faulted, never tracked.
 */
export const makeTargets = (
  browser: Browser,
  context: BrowserContext,
  options: DriverOptions,
  callbacks: CallbackTasks,
  events: DriverEvents,
  closing: () => boolean,
  hooks: TargetHooks,
) => {
  const entries = new Map<string, Entry>();
  const byPage = new WeakMap<Page, Entry>();
  const frameIds = new WeakMap<Frame, string>();
  // A frame object outlives its documents, so readiness is keyed by frame *and* epoch.
  const documentEpochs = new WeakMap<Frame, number>();
  const selection: Selection = {};
  // Pages whose navigation this driver began and has not seen settle.
  const navigating = new Set<string>();
  // FrameInfo is connection-local public metadata. A new driver after reconnect must never
  // regenerate an old frame id for a different frame, even when serial order happens to match.
  const connectionNamespace = globalThis.crypto.randomUUID();

  let serial = 0,
    frameSerial = 0;

  let creatingPage = false;

  const epochOf = (frame: Frame): number => documentEpochs.get(frame) ?? 0;

  const frameId = (frame: Frame): string => {
    let id = frameIds.get(frame);

    if (id === undefined) {
      id = `frame-${connectionNamespace}-${++frameSerial}`;
      frameIds.set(frame, id);
    }

    return id;
  };

  const register = (page: Page): Entry => {
    const existing = byPage.get(page);

    if (existing !== undefined) return existing;
    const entry: Entry = { id: `page-${connectionNamespace}-${++serial}`, page, off: [] };

    byPage.set(page, entry);
    if (entries.size >= options.maxPages) {
      callbacks.submit(() => closeWithin(() => page.close()));
      events.fault();

      return entry;
    }
    entries.set(entry.id, entry);
    for (const frame of page.frames()) frameId(frame);

    const onClose = () => {
      hooks.closed(entry);
      entries.delete(entry.id);
      for (const off of entry.off.splice(0)) off();
      if (selection.entry === entry) {
        selection.entry = undefined;
        selection.frame = undefined;
        hooks.changed("target-changed");
      }
    };

    const onNavigation = (frame: Frame) => {
      hooks.navigating(entry, frame);
      documentEpochs.set(frame, epochOf(frame) + 1);
      hooks.navigated(entry, frame);
      frameId(frame);
      hooks.frameChanged(entry, frame);
      if (selection.entry === entry && (selection.frame === frame || frame === page.mainFrame()))
        hooks.changed("target-changed");
    };

    const onDetached = (frame: Frame) => {
      hooks.frameChanged(entry, frame);
      if (selection.frame === frame) {
        selection.frame = undefined;
        hooks.changed("target-changed");
      }
    };

    const onDialog = (dialog: Dialog) => {
      hooks.dialog(dialog);
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
    hooks.opened(entry, creatingPage);

    return entry;
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

      return entry.targetId;
    } finally {
      await closeWithin(() => cdp.detach()).catch(() => {});
    }
  };

  const urlOf = (frame: Frame) => safeDecode(URLText, frame.url());

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
        selection.entry = register(await context.newPage());
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

  const selectedTargetId = () => sanitize(() => targetId(current().entry));

  /** Describe this exact entry, including when creation has already dispatched. */
  const pageInfo = async (entry: Entry, ticket: Ticket): Promise<PageInfo> => {
    const id = await targetId(entry, ticket);

    ticket.check();
    const title: unknown = await entry.page.title();

    ticket.check();
    if (entries.get(entry.id) !== entry || entry.page.isClosed())
      throw failure(Reasons.Stale.make({}), ticket.dispatched ? "unknown" : "undispatched");
    if (typeof title !== "string") throw failure(Reasons.Malformed.make({ path: "page.title" }));

    return safeDecode(PageInfo, {
      pageId: entry.id,
      targetId: id,
      title: title.slice(0, 512),
      url: entry.page.url(),
      selected: selection.entry === entry,
    });
  };

  const listPages = (ticket: Ticket) =>
    sanitize(async () => {
      ticket.check();
      const output: PageInfo[] = [];

      for (const entry of entries.values()) output.push(await pageInfo(entry, ticket));

      return output;
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

  const resolvePage = (page: PageInfo, ticket: Ticket) =>
    sanitize(async () => {
      const entry = await explicitPage(page, ticket);

      return { pageId: entry.id, frameId: frameId(entry.page.mainFrame()) };
    });

  const selectPage = (page: PageInfo, ticket: Ticket) =>
    sanitize(async () => {
      const entry = await explicitPage(page, ticket);

      await hooks.release();
      ticket.check();
      if (entries.get(entry.id) !== entry || entry.page.isClosed())
        throw failure(Reasons.Stale.make({}), "undispatched");
      selection.entry = entry;
      selection.frame = entry.page.mainFrame();
      hooks.changed("target-changed");
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
        const page = await context.newPage();

        if (ticket.signal.aborted) {
          await closeWithin(() => page.close()).catch(() => {});
          ticket.check();
        }

        entry = register(page);
      } finally {
        creatingPage = false;
      }

      // Creation never selects or relists. A failed metadata read cannot repeat the creation.
      return pageInfo(entry, ticket);
    });

  const closePage = (page: PageInfo, ticket: Ticket) =>
    sanitize(async () => {
      const entry = await explicitPage(page, ticket);

      ticket.dispatch();
      await entry.page.close({ runBeforeUnload: false });
      ticket.check();
    });

  const listFrames = (ticket: Ticket, page?: PageInfo) =>
    sanitize(async () => {
      ticket.check();
      const entry = page === undefined ? selectedCurrent().entry : await explicitPage(page, ticket);
      const frames = entry.page.frames();

      if (frames.length > 128)
        throw failure(
          Reasons.Limit.make({ dimension: "frames", maximum: 128, observed: frames.length }),
        );

      return frames.map((frame) =>
        safeDecode(FrameInfo, {
          frameId: frameId(frame),
          parentFrameId: frame.parentFrame() === null ? null : frameId(frame.parentFrame()!),
          url: frame.url(),
          name: frame.name().slice(0, 256),
        }),
      );
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

  const selectFrame = (id: string, ticket: Ticket) =>
    sanitize(async () => {
      const entry = selection.entry;

      if (entry === undefined) throw failure(Reasons.Closed.make({}));
      const frame = entry.page.frames().find((f) => frameId(f) === id);

      if (frame === undefined || frame.isDetached())
        throw failure(Reasons.NotFound.make({}), "undispatched");
      await hooks.release();
      ticket.check();
      selection.frame = frame;
      hooks.changed("target-changed");
    });

  return {
    entries: entries as ReadonlyMap<string, Entry>,
    selection,
    epochOf,
    frameId,
    register,
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
    resolvePage,
    selectPage,
    newPage,
    closePage,
    listFrames,
    resolveFrame,
    selectFrame,
  };
};

export type Targets = ReturnType<typeof makeTargets>;
