import { Effect, type Option } from "effect";

import type { CleanupResult } from "./Cleanup.ts";
import type { ContextWriterPermit } from "./ContextCoordination.ts";
import { acquireRemote } from "./internal/session/Acquisition.ts";
import type { LaunchRecipe } from "./Launch.ts";
import type { AllocationAttempt, SessionReference } from "./References.ts";

/** A session this process allocated and owns, with no browser connected to it. */
export interface AllocatedSession {
  readonly reference: SessionReference;
  /** The creation attempt, retained so an unknown provider outcome stays attributable. */
  readonly attempt: AllocationAttempt;
  /**
   * Release now and read the cleanup evidence. The scope finalizer performs the same
   * release, so an uncalled `release` is a scope that has not closed yet, not a leak.
   */
  readonly release: Effect.Effect<CleanupResult>;
  /** The cleanup evidence once it exists, and `None` while the session is still held. */
  readonly cleanupResult: Effect.Effect<Option.Option<CleanupResult>>;
}

export interface AllocationOptions {
  /** Required exactly when the recipe persists a Context, and refused when it does not. */
  readonly contextWriter?: ContextWriterPermit;
  readonly allocationDeadline?: number;
  /** Bounded host notification of the canonical facts. Reporting never changes them. */
  readonly onCleanup?: (result: CleanupResult) => Effect.Effect<void>;
  /** Exactly one notification when a creation attempt's effect on the provider is unknown. */
  readonly onAllocationUncertain?: (attempt: AllocationAttempt) => Effect.Effect<void>;
}

/**
 * Allocate a session without connecting a browser, for a caller that drives the remote
 * session with its own automation client. This is the allocation path the browser owner
 * uses, so release, unknown-outcome reporting and Context writer authority keep a single
 * owner: the creation request is never retried, a foreign project is refused before it is
 * sent, and no native peer is loaded. The scope owns the release; closing it releases the
 * session whether or not the caller ever connected to it.
 */
export const scoped = Effect.fnUntraced(function* (
  launch: LaunchRecipe,
  options: AllocationOptions = {},
) {
  const acquisition = yield* acquireRemote({ launch, ...options });

  const allocated: AllocatedSession = {
    reference: acquisition.reference,
    attempt: acquisition.attempt,
    release: acquisition.release,
    cleanupResult: acquisition.cleanupResult,
  };

  return allocated;
});
