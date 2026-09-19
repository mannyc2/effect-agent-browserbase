import type { Effect } from "effect";

import type { BrowserbaseError, PageInfo, Target } from "../Types.ts";
import type { CaptureSource } from "./Driver.ts";
import type { Invalidation, Owner, Ticket } from "./Owner.ts";

export interface CaptureLease {
  readonly pageId: string;
  readonly reservedBytes: number;
  readonly stop: Effect.Effect<void>;
  readonly invalidate: (reason: Invalidation) => void;
}

export interface CaptureParent {
  readonly owner: Owner;
  readonly source: (
    ticket: Ticket,
    target: PageInfo | undefined,
  ) => Effect.Effect<
    { readonly source: CaptureSource; readonly target: Target },
    BrowserbaseError
  >;
  readonly captureLeases: Map<string, CaptureLease>;
  readonly invalidatePage: (
    pageId: string,
    reason: Extract<Invalidation, "target-changed" | "resized">,
  ) => void;
  readonly invalidateAll: (reason: Invalidation) => void;
}

// Live identity association only; typed outcomes are Schemas, never hidden in this WeakMap.
const parents = new WeakMap<object, CaptureParent>();

export const associate = (session: object, parent: CaptureParent): void => {
  parents.set(session, parent);
};

export const captureParent = (session: object): CaptureParent | undefined => parents.get(session);
