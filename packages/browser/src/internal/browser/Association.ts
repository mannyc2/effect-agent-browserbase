import type { Effect } from "effect";

import type { PageInfo, Target } from "../../BrowserData.ts";
import type { BrowserError } from "../../Errors.ts";
import type { CaptureSource } from "./Driver.ts";
import type { Owner, Ticket } from "./Owner.ts";

export interface CaptureLease {
  readonly stop: Effect.Effect<void>;
  readonly invalidate: (reason: string) => void;
  readonly reservedBytes: number;
}

export interface CaptureResolution {
  /** Stable native page identity used to quarantine an unconfirmed screencast across reconnects. */
  readonly key: string;
  readonly target: Target;
  readonly source: CaptureSource;
}

export interface CaptureParent {
  readonly owner: Owner;
  readonly resolve: (
    ticket: Ticket,
    target?: PageInfo,
  ) => Effect.Effect<CaptureResolution, BrowserError>;
  readonly target: () => Target;
  readonly captureLeases: Map<string, CaptureLease>;
  captureReservedBytes: number;
}

// This is a private capability registry, not stored domain data. Exact live session identity is
// required: spreading/cloning a session must not copy authority to mutate its capture owner,
// leases or reservations. A public/enumerable parent field would weaken that boundary.
// Keep this access centralized here; schemas describe data, never this mutable ownership state.
const parents = new WeakMap<object, CaptureParent>();

export const associate = (session: object, parent: CaptureParent): void => {
  parents.set(session, parent);
};

export const captureParent = (session: object): CaptureParent | undefined => parents.get(session);
