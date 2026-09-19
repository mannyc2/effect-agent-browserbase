import type { Effect } from "effect";

import type { BrowserbaseError, PageInfo, Target } from "../Types.ts";
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
  ) => Effect.Effect<CaptureResolution, BrowserbaseError>;
  readonly target: () => Target;
  readonly captureLeases: Map<string, CaptureLease>;
  captureReservedBytes: number;
}

// Live identity association only; typed outcomes are Schemas, never hidden in this WeakMap.
const parents = new WeakMap<object, CaptureParent>();

export const associate = (session: object, parent: CaptureParent): void => {
  parents.set(session, parent);
};

export const captureParent = (session: object): CaptureParent | undefined => parents.get(session);
