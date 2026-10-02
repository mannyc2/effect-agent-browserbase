import { Deferred, Effect } from "effect";

import type { OperationOptions, Page, PageStatus } from "../../Browser.ts";
import type { PageExecutionState, PageInfo, PageSuspension, Target } from "../../BrowserData.ts";
import { BrowserError, Reasons, type BrowserOperation } from "../../Errors.ts";
import type { Terminal } from "../../TimelineData.ts";
import type { makeRetirement } from "../timeline/Retirement.ts";
import type { makeStore } from "../timeline/Store.ts";
import type { AdmissionLane } from "./Admission.ts";
import type { CaptureParent, PageCaptureParent } from "./Association.ts";
import type { Owner } from "./Owner.ts";
import type { PageControls } from "./Session.ts";

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

export interface PageControlPort {
  readonly state: (
    page: PageInfo,
    options?: OperationOptions,
  ) => Effect.Effect<PageExecutionState, BrowserError>;
  readonly suspend: (
    page: PageInfo,
    options?: OperationOptions,
  ) => Effect.Effect<PageSuspension, BrowserError>;
  readonly resume: (
    receipt: PageSuspension,
    options?: OperationOptions,
  ) => Effect.Effect<void, BrowserError>;
}

export interface PageControlAssociation {
  readonly port: PageControlPort;
  readonly page: PageInfo;
}

/** What one issued Page carries: its record, controls, capture parent and page control. */
export interface IssuedPage {
  readonly record: PageRecord;
  readonly controls: PageControls;
  readonly capture: PageCaptureParent;
  readonly pageControl: PageControlAssociation;
}

type Issued =
  | { readonly _tag: "Session"; readonly capture: CaptureParent }
  | ({ readonly _tag: "Page" } & IssuedPage)
  | { readonly _tag: "Frame"; readonly owner: Owner; readonly controls: PageControls };

// This is a private capability registry, not stored domain data. Exact live identity is required:
// spreading or cloning a session, Page or Frame must not copy authority over its owner, capture
// leases, reservations or page control. A public or enumerable field would weaken that boundary.
// Schemas describe data, never this mutable ownership state.
const issued = new WeakMap<object, Issued>();
// One canonical Page per page record: issuing the same record again returns the same object.
const canonical = new WeakMap<PageRecord, Page>();

/** Registers a session's own capture parent under the session object itself. */
export const issueSession = (session: object, capture: CaptureParent): void => {
  issued.set(session, { _tag: "Session", capture });
};

/** The canonical Page for `record`: built by `make` and registered the first time only. */
export const issuePage = (
  record: PageRecord,
  make: () => Page,
  authority: () => Omit<IssuedPage, "record">,
): Page => {
  const existing = canonical.get(record);

  if (existing !== undefined) return existing;
  const page = make();
  const { controls, capture, pageControl } = authority();

  canonical.set(record, page);
  issued.set(page, {
    _tag: "Page",
    record,
    controls,
    capture,
    pageControl: { port: pageControl.port, page: Object.freeze({ ...pageControl.page }) },
  });

  return page;
};

/** An issued Frame keeps its own exact controls and the owner of the session that issued it. */
export const issueFrame = (frame: object, owner: Owner, controls: PageControls): void => {
  issued.set(frame, { _tag: "Frame", owner, controls });
};

const sessionOwner = (session: object): Owner | undefined => {
  const entry = issued.get(session);

  return entry?._tag === "Session" ? entry.capture.owner : undefined;
};

/** The issued Page `page` is, if this exact object was issued by the session owning `owner`. */
export const issuedPageOf = (page: object, owner: Owner): IssuedPage | undefined => {
  const entry = issued.get(page);

  return entry?._tag === "Page" && entry.capture.owner === owner ? entry : undefined;
};

/** Capture binds only to original issued Page authority; a session association is insufficient. */
export const capturePageParent = (page: object): PageCaptureParent | undefined => {
  const entry = issued.get(page);

  return entry?._tag === "Page" ? entry.capture : undefined;
};

/** The page control an issued Page carries. */
export const pageControl = (page: object): PageControlAssociation | undefined => {
  const entry = issued.get(page);

  return entry?._tag === "Page" ? entry.pageControl : undefined;
};

const unregistered = (operation: BrowserOperation) =>
  Effect.fail(
    BrowserError.make({
      operation,
      reason: Reasons.UnregisteredSession.make({}),
      outcome: "undispatched",
    }),
  );

/** Provider bridges borrow the exact issued page on this session's original owner. */
export const resolvePageControlsForSession = (
  session: object,
  page: object,
  operation: BrowserOperation = "target",
): Effect.Effect<PageControls, BrowserError> =>
  Effect.suspend(() => {
    const owner = sessionOwner(session);
    const entry = owner === undefined ? undefined : issuedPageOf(page, owner);

    return entry === undefined
      ? unregistered(operation)
      : entry.controls.validate(operation).pipe(Effect.as(entry.controls));
  });

/**
 * Tools borrow an exact issued Page, or an exact Frame one of its Pages issued, on this session's
 * original owner. Capture, page control and provider transfers stay Page-only.
 */
export const resolveTargetControlsForSession = (
  session: object,
  target: object,
  operation: BrowserOperation = "target",
): Effect.Effect<PageControls, BrowserError> =>
  Effect.suspend(() => {
    const entry = issued.get(target);

    if (entry?._tag !== "Frame") return resolvePageControlsForSession(session, target, operation);
    if (sessionOwner(session) !== entry.owner) return unregistered(operation);

    return entry.controls.validate(operation).pipe(Effect.as(entry.controls));
  });
