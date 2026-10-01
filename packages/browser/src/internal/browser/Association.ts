import { Effect } from "effect";

import type { PageStatus } from "../../Browser.ts";
import type { PageInfo, Target } from "../../BrowserData.ts";
import type { CaptureQualification } from "../../CaptureData.ts";
import { BrowserError, Reasons, type BrowserOperation } from "../../Errors.ts";
import type { CaptureReason } from "../../TimelineData.ts";
import type { CaptureSource } from "./Driver.ts";
import type { Owner, Ticket } from "./Owner.ts";
import type { PageControls } from "./Session.ts";

export interface CaptureLease {
  readonly pageId: string;
  readonly stop: Effect.Effect<void>;
  readonly invalidate: (reason: string) => void;
  readonly reservedBytes: number;
}

export interface CaptureResolution {
  /** Stable native page identity used to quarantine an unconfirmed screencast across reconnects. */
  readonly key: string;
  readonly target: Target;
  readonly source: CaptureSource;
  /** Retains one bounded authority record after it leaves the owner's live inventory. */
  readonly status?: () => Pick<PageStatus, "phase" | "containment">;
  /** Captured when this exact interval is resolved, never redirected by reconnect. */
  readonly metadata?: (event: CaptureMetadata) => void;
}

/** Original interval evidence only; no frame bytes or new capture ownership. */
export type CaptureMetadata =
  | {
      readonly _tag: "FirstFrame";
      readonly captureId: string;
      readonly target: Target;
      readonly captureBoundary: number;
      readonly captureDocument: number;
      readonly frameSequence: number;
      readonly sourceTimeMillis: number;
      readonly sourceClock: "presentation-unix-millis";
      readonly receivedMonotonicNanos: bigint;
      readonly width: number;
      readonly height: number;
      readonly viewportWidth: number;
      readonly viewportHeight: number;
    }
  | {
      readonly _tag: "CaptureBoundary";
      readonly captureId: string;
      readonly target: Target;
      readonly captureBoundary: number;
      readonly captureDocument: number;
      readonly sameDocument: boolean;
      readonly url: string | null;
      readonly urlQualification: "NativeCached" | "Omitted";
      readonly afterSequence: number | null;
      readonly observedMonotonicNanos: bigint;
    }
  | {
      readonly _tag: "Capture";
      readonly captureId: string;
      readonly target: Target;
      readonly phase: "Reserved" | "Watching" | "Started" | "Ended" | "Stopped";
      readonly latePhase: boolean;
      readonly observedMonotonicNanos: bigint;
      readonly captureBoundary: number;
      readonly captureDocument: number;
      readonly qualification: CaptureQualification;
      readonly initialUrl: string | null;
      readonly initialUrlQualification: "NativeCached" | "Unread" | "Omitted";
      readonly reason: CaptureReason | null;
      readonly nativeStop: "confirmed" | "unconfirmed" | null;
      readonly received: number;
      readonly delivered: number;
      readonly discarded: number;
      readonly overflow: number;
      readonly late: number;
      readonly duplicates: number;
      readonly rejected: number;
      readonly upstreamDrops: "unknown";
    };

/** Capture ownership and accounting, shared by a session and every Page it issues. */
export interface CaptureParent {
  readonly owner: Owner;
  /** Prebound to the original owner's Crypto; starting capture adds no caller service. */
  readonly newCaptureId: Effect.Effect<string>;
  readonly resolve: (
    ticket: Ticket,
    page: PageInfo,
  ) => Effect.Effect<CaptureResolution, BrowserError>;
  readonly captureLeases: Map<string, CaptureLease>;
  captureReservedBytes: number;
}

/** The capture parent of one issued Page: the only kind that can start a capture. */
export interface PageCaptureParent extends CaptureParent {
  /** The page's own authority check, reported under the caller's operation. */
  readonly validate: (operation: BrowserOperation) => Effect.Effect<void, BrowserError>;
  /** The exact page this parent captures. */
  readonly page: PageInfo;
}

// This is a private capability registry, not stored domain data. Exact live session identity is
// required: spreading/cloning a session must not copy authority to mutate its capture owner,
// leases or reservations. A public/enumerable parent field would weaken that boundary.
// Keep this access centralized here; schemas describe data, never this mutable ownership state.
const parents = new WeakMap<object, CaptureParent>();
const pageParents = new WeakMap<object, PageCaptureParent>();

export const associate = (session: object, parent: CaptureParent): void => {
  parents.set(session, parent);
};

/** An issued Page shares its session's owner and accounting and adds its own exact page. */
export const associatePage = (page: object, parent: PageCaptureParent): void => {
  parents.set(page, parent);
  pageParents.set(page, parent);
};

/** A page delegates to the same owner and accounting; its destination cannot be replaced. */
export const forPage = (
  parent: CaptureParent,
  info: PageInfo,
  identity: Target,
  validate: (operation: BrowserOperation) => Effect.Effect<void, BrowserError>,
): PageCaptureParent => ({
  validate,
  page: info,
  owner: parent.owner,
  newCaptureId: parent.newCaptureId,
  captureLeases: parent.captureLeases,
  get captureReservedBytes() {
    return parent.captureReservedBytes;
  },
  set captureReservedBytes(value) {
    parent.captureReservedBytes = value;
  },
  resolve: (ticket, requested) =>
    validate("capture").pipe(
      Effect.andThen(
        Effect.suspend(() => {
          if (ticket.generation !== identity.generation)
            return Effect.fail(
              BrowserError.make({
                operation: "capture",
                reason: Reasons.Stale.make({}),
                outcome: "undispatched",
              }),
            );
          if (requested.pageId !== info.pageId || requested.targetId !== info.targetId)
            return Effect.fail(
              BrowserError.make({
                operation: "capture",
                reason: Reasons.Configuration.make({ path: "target" }),
                outcome: "undispatched",
              }),
            );

          return parent
            .resolve(ticket, info)
            .pipe(Effect.tap(() => Effect.sync(() => ticket.check())));
        }),
      ),
    ),
});

const pageAuthorities = new WeakMap<object, PageControls>();

export const associatePageAuthority = (page: object, controls: PageControls): void => {
  pageAuthorities.set(page, controls);
};

/** Provider bridges borrow the exact issued page on this session's original owner. */
export const resolvePageControlsForSession = (
  session: object,
  page: object,
  operation: BrowserOperation = "target",
): Effect.Effect<PageControls, BrowserError> =>
  Effect.suspend(() => {
    const owner = parents.get(session)?.owner;
    const controls = pageAuthorities.get(page);

    if (owner === undefined || parents.get(page)?.owner !== owner || controls === undefined)
      return Effect.fail(
        BrowserError.make({
          operation,
          reason: Reasons.UnregisteredSession.make({}),
          outcome: "undispatched",
        }),
      );

    return controls.validate(operation).pipe(Effect.as(controls));
  });

const frameAuthorities = new WeakMap<
  object,
  { readonly owner: Owner; readonly controls: PageControls }
>();

/** An issued Frame keeps its own exact controls and the owner of the session that issued it. */
export const associateFrameAuthority = (
  frame: object,
  owner: Owner,
  controls: PageControls,
): void => {
  frameAuthorities.set(frame, { owner, controls });
};

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
    const frame = frameAuthorities.get(target);

    if (frame === undefined) return resolvePageControlsForSession(session, target, operation);
    if (parents.get(session)?.owner !== frame.owner)
      return Effect.fail(
        BrowserError.make({
          operation,
          reason: Reasons.UnregisteredSession.make({}),
          outcome: "undispatched",
        }),
      );

    return frame.controls.validate(operation).pipe(Effect.as(frame.controls));
  });

/** Capture binds only to original issued Page authority; a session association is insufficient. */
export const capturePageParent = (page: object): PageCaptureParent | undefined =>
  pageParents.get(page);
