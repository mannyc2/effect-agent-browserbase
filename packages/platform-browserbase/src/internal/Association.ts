import type { Effect } from "effect";

import type { BrowserbaseError, Target } from "../Types.ts";
import type { CaptureSource } from "./Driver.ts";
import type { Owner, Ticket } from "./Owner.ts";

export interface CaptureLease {
  readonly stop: Effect.Effect<void>;
  readonly invalidate: (reason: string) => void;
}

export interface CaptureParent {
  readonly owner: Owner;
  readonly source: (ticket: Ticket) => Effect.Effect<CaptureSource, BrowserbaseError>;
  readonly target: () => Target;
  captureLease?: CaptureLease;
}

// Live identity association only; typed outcomes are Schemas, never hidden in this WeakMap.
const parents = new WeakMap<object, CaptureParent>();

export const associate = (session: object, parent: CaptureParent): void => {
  parents.set(session, parent);
};

export const captureParent = (session: object): CaptureParent | undefined => parents.get(session);
