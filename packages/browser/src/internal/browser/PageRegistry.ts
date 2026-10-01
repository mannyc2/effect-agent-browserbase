import { Deferred, Effect } from "effect";

import type { PageStatus } from "../../Browser.ts";
import type { PageInfo, Target } from "../../BrowserData.ts";
import type { Terminal } from "../../TimelineData.ts";
import type { makeRetirement } from "../timeline/Retirement.ts";
import type { makeStore } from "../timeline/Store.ts";
import type { AdmissionLane } from "./Admission.ts";

/** One frame of a registered page. Frames issued for a detached one are refused. */
export interface FrameRecord {
  readonly detached: boolean;
}

/** The session's record of one registered page at one connection generation. */
export interface PageRecord {
  readonly identity: Target;
  readonly admission: AdmissionLane;
  readonly info: PageInfo;
  readonly frames: ReadonlyMap<string, FrameRecord>;
  readonly phase: "open" | "paused" | "closing" | "closed";
  readonly containment: PageStatus["containment"];
  readonly store: ReturnType<typeof makeStore>;
  readonly terminal: Terminal | null;
  readonly retirement: ReturnType<typeof makeRetirement>;
  /** The native closure in flight for this page, settled true once it closed. */
  readonly attempt?: Deferred.Deferred<boolean>;
}

interface FrameState {
  detached: boolean;
}

interface RecordState {
  readonly identity: Target;
  readonly admission: AdmissionLane;
  readonly info: PageInfo;
  readonly frames: Map<string, FrameState>;
  phase: PageRecord["phase"];
  containment: PageStatus["containment"];
  readonly store: ReturnType<typeof makeStore>;
  readonly terminal: Terminal | null;
  readonly retirement: ReturnType<typeof makeRetirement>;
  attempt?: Deferred.Deferred<boolean>;
}

/**
 * The session's registered pages at their connection generations. Callers read the records; only
 * these transitions change them.
 */
export const makePageRegistry = () => {
  const pages = new Map<string, RecordState>();
  // Every record this registry made, by identity, including ones it no longer lists.
  const owned = new WeakMap<PageRecord, RecordState>();

  const state = (record: PageRecord): RecordState => {
    const found = owned.get(record);

    if (found === undefined) throw new TypeError("Page record belongs to another registry");

    return found;
  };

  return {
    get: (pageId: string): PageRecord | undefined => pages.get(pageId),
    records: (): ReadonlyArray<PageRecord> => [...pages.values()],
    /** Registers a page at a new generation, replacing any record of an earlier one. */
    add: (init: {
      readonly identity: Target;
      readonly admission: AdmissionLane;
      readonly info: PageInfo;
      readonly paused: boolean;
      readonly store: ReturnType<typeof makeStore>;
      readonly retirement: ReturnType<typeof makeRetirement>;
      readonly terminal: () => Terminal | null;
    }): PageRecord => {
      const record: RecordState = {
        identity: init.identity,
        admission: init.admission,
        info: init.info,
        frames: new Map(),
        phase: init.paused ? "paused" : "open",
        containment: { _tag: "NotRequired" },
        store: init.store,
        retirement: init.retirement,
        get terminal() {
          return init.terminal();
        },
      };

      owned.set(record, record);
      pages.set(init.info.pageId, record);

      return record;
    },
    /** A popup/dialog policy holds an open page for its operator. */
    pause: (pageId: string) => {
      const page = pages.get(pageId);

      if (page !== undefined && page.phase === "open") page.phase = "paused";
    },
    /** The page is being closed: its issued authority refuses new work. */
    closing: (pageId: string) => {
      const page = pages.get(pageId);

      if (page !== undefined && page.phase !== "closed") page.phase = "closing";
    },
    /** The page closed: it settles its closure attempt and leaves the registry. */
    closed: (pageId: string) => {
      const page = pages.get(pageId);

      if (page === undefined) return;
      page.phase = "closed";
      if (page.attempt !== undefined) Deferred.doneUnsafe(page.attempt, Effect.succeed(true));
      pages.delete(pageId);
    },
    /** Records how an unknown outcome on this page was contained. */
    contain: (record: PageRecord, containment: PageStatus["containment"]) => {
      state(record).containment = containment;
    },
    /** The native closure now in flight for this page. */
    attempting: (record: PageRecord, attempt: Deferred.Deferred<boolean>) => {
      state(record).attempt = attempt;
    },
    /** The page's record of one frame, registered on first use. */
    frame: (record: PageRecord, frameId: string): FrameRecord => {
      const page = state(record);
      const existing = page.frames.get(frameId);

      if (existing !== undefined) return existing;
      const frame: FrameState = { detached: false };

      page.frames.set(frameId, frame);

      return frame;
    },
    /** A frame left its page: Frames issued for it are refused from now on. */
    detachFrame: (pageId: string, frameId: string) => {
      const page = pages.get(pageId);
      const frame = page?.frames.get(frameId);

      if (frame !== undefined) frame.detached = true;
      page?.frames.delete(frameId);
    },
    clear: () => {
      pages.clear();
    },
  };
};

export type PageRegistry = ReturnType<typeof makePageRegistry>;
