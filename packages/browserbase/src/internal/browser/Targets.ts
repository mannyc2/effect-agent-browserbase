import { Schema } from "effect";
import type { Browser, BrowserContext, Dialog, Frame, Page } from "playwright-core";

import { FrameInfo, PageInfo } from "../../BrowserData.ts";
import { Identifier } from "../../References.ts";
import type { CallbackTasks } from "./CallbackTasks.ts";
import type { DriverEvents, DriverOptions } from "./Driver.ts";
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

  let serial = 0,
    frameSerial = 0;

  let creatingPage = false;

  const epochOf = (frame: Frame): number => documentEpochs.get(frame) ?? 0;

  const frameId = (frame: Frame): string => {
    let id = frameIds.get(frame);

    if (id === undefined) {
      id = `frame-${++frameSerial}`;
      frameIds.set(frame, id);
    }

    return id;
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

  const current = () => {
    if (
      closing() ||
      !browser.isConnected() ||
      selection.entry === undefined ||
      selection.entry.page.isClosed() ||
      selection.frame === undefined ||
      selection.frame.isDetached()
    )
      throw failure("target", "closed", "undispatched");

    return { entry: selection.entry, frame: selection.frame };
  };

  const targetId = async (entry: Entry): Promise<string> => {
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

  const selectedUrl = () => safeDecode(URLText, current().frame.url(), "page-url");

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
      if (selection.entry === undefined) throw failure("initial-page", "not-found");
    } else {
      if (entries.size !== 1) throw failure("initial-page", "ambiguous");
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

  const selectedTargetId = () => sanitize("target-identity", () => targetId(current().entry));

  const listPages = (ticket: Ticket) =>
    sanitize("list-pages", async () => {
      ticket.check();
      const output: PageInfo[] = [];

      for (const entry of entries.values()) {
        const id = await targetId(entry);
        const title: unknown = await entry.page.title();

        ticket.check();
        if (typeof title !== "string") throw failure("list-pages", "malformed");
        output.push(
          safeDecode(
            PageInfo,
            {
              pageId: entry.id,
              targetId: id,
              title: title.slice(0, 512),
              url: entry.page.url(),
              selected: selection.entry === entry,
            },
            "list-pages",
          ),
        );
      }

      return output;
    });

  const selectPage = (id: string, ticket: Ticket) =>
    sanitize("select-page", async () => {
      const entry = entries.get(id);

      ticket.check();
      if (entry === undefined || entry.page.isClosed())
        throw failure("select-page", "not-found", "undispatched");
      await hooks.release();
      ticket.check();
      selection.entry = entry;
      selection.frame = entry.page.mainFrame();
      hooks.changed("target-changed");
    });

  const newPage = (ticket: Ticket) =>
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
    });

  const closePage = (id: string, ticket: Ticket) =>
    sanitize("close-page", async () => {
      const entry = entries.get(id);

      if (entry === undefined) throw failure("close-page", "not-found", "undispatched");
      ticket.dispatch();
      await entry.page.close({ runBeforeUnload: false });
      ticket.check();
    });

  const listFrames = (ticket: Ticket) =>
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
    });

  const selectFrame = (id: string, ticket: Ticket) =>
    sanitize("select-frame", async () => {
      const entry = selection.entry;

      if (entry === undefined) throw failure("select-frame", "closed");
      const frame = entry.page.frames().find((f) => frameId(f) === id);

      if (frame === undefined || frame.isDetached())
        throw failure("select-frame", "not-found", "undispatched");
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
    selectedUrl,
    selectInitial,
    clear,
    selected,
    selectedTargetId,
    listPages,
    selectPage,
    newPage,
    closePage,
    listFrames,
    selectFrame,
  };
};

export type Targets = ReturnType<typeof makeTargets>;
