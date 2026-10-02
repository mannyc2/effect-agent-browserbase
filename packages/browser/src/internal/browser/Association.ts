import { Effect } from "effect";

import type { PageStatus } from "../../Browser.ts";
import type { PageInfo, Target } from "../../BrowserData.ts";
import type { CaptureQualification } from "../../CaptureData.ts";
import { BrowserError, Reasons, type BrowserOperation } from "../../Errors.ts";
import type { CaptureReason } from "../../TimelineData.ts";
import type { CaptureSource } from "./Driver.ts";
import type { Owner, Ticket } from "./Owner.ts";

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
