import { Clock, Duration, Effect, Schema, Semaphore } from "effect";

import {
  BrowserDiagnostic,
  BrowserDiagnostics,
  SessionStatus,
  type SessionReason,
  type SessionPhase,
} from "../../BrowserData.ts";
import { BrowserError, Reasons, type BrowserOperation } from "../../Errors.ts";
import type { DriverFault } from "./Driver.ts";
import { publicError } from "./NativeCalls.ts";

/** The browser domain's bounded step: one deadline, one declared BrowserError timeout. */
export const within = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  deadline: number,
  onTimeout: () => BrowserError,
): Effect.Effect<A, E | BrowserError, R> =>
  Effect.gen(function* () {
    const now = Number(yield* Clock.monotonicTimeNanos) / 1_000_000;

    return yield* deadline <= now
      ? Effect.fail(onTimeout())
      : effect.pipe(
          Effect.timeoutOrElse({
            duration: Duration.millis(deadline - now),
            orElse: () => Effect.fail(onTimeout()),
          }),
        );
  });

export type Phase = SessionPhase;

export type Invalidation =
  | "observation"
  | "target-changed"
  | "resized"
  | "paused"
  | "disconnected"
  | "uncertain"
  | "closed";

/** Observation retirement is independent of the owner's revision and connection fences. */
export type ObservationScope = "all" | "none" | { readonly pageId: string };

/** One admitted native operation; checks at dispatch also fence late Promise continuations. */
export interface Ticket {
  readonly signal: AbortSignal;
  readonly deadline: number;
  readonly generation: number;
  readonly dispatched: boolean;
  readonly remainingMillis: () => number;
  check(): void;
  dispatch(): void;
}

/**
 * A dispatched mutation the browser is still performing after its permit was released: an
 * in-flight navigation. It keeps other mutations off that page while reads, holds and other
 * pages proceed. Like a permit it cannot be dropped silently: only a known outcome releases it.
 */
export interface Reservation {
  /** Aborted by any fence, so work that outlives its connection is never treated as current. */
  readonly signal: AbortSignal;
  /** `unknown` fences the owner, exactly as a mutation interrupted after dispatch does. */
  readonly settle: (outcome: "known" | "unknown") => void;
}

export interface Limits {
  readonly maxActions: number;
  readonly maxHostReads: number;
  readonly maxElapsedMillis: number;
  readonly actionTimeoutMillis: number;
}

export const makeOwner = Effect.fnUntraced(function* (limits: Limits) {
  const semaphore = yield* Semaphore.make(1);
  const clock = yield* Clock.Clock;

  const lifetimeDeadline =
    Number(yield* Clock.monotonicTimeNanos) / 1_000_000 + limits.maxElapsedMillis;

  const hooks = new Set<(reason: Invalidation, scope: ObservationScope) => void>();

  const state = {
    phase: "acquiring" as Phase,
    generation: 0,
    revision: 0,
    selection: 0,
    actions: 0,
    hostReads: 0,
  };

  let active: AbortController | undefined;
  let holdingPermit = false;
  const reservations = new Map<string, AbortController>();
  // These facts outlive the tickets which produced them. Aborting admission is not retirement.
  const unresolved = new Set<object>();
  let nativeUncertainty = false;
  let terminalReason: SessionReason | null = null;
  let pauseReason: SessionReason | null = null;
  const policies = new Map<object, Extract<DriverFault, { readonly source: "policy" }>>();
  const records: Array<BrowserDiagnostics["records"][number]> = [];
  let total = 0;
  let dropped = 0;

  const record = (
    reason: SessionReason,
    disposition: BrowserDiagnostics["records"][number]["disposition"],
    generation = state.generation,
  ) => {
    total = Math.min(Number.MAX_SAFE_INTEGER, total + 1);
    if (records.length === 32) {
      records.shift();
      dropped = Math.min(Number.MAX_SAFE_INTEGER, dropped + 1);
    }
    records.push(
      Object.freeze(
        BrowserDiagnostic.make({
          reason,
          disposition,
          generation,
          monotonicNanos: clock.monotonicTimeNanosUnsafe(),
        }),
      ),
    );
  };

  const transition = (phase: Phase) => {
    if (
      (terminalReason !== null || state.phase === "closed" || state.phase === "closing") &&
      phase !== "closing" &&
      phase !== "closed"
    )
      return;
    state.phase = phase;
    if (phase === "open") pauseReason = null;
  };

  const invalidate = (reason: Invalidation, scope: ObservationScope = "all") => {
    state.revision++;
    for (const hook of hooks) hook(reason, scope);
  };

  const fence = (phase: Phase, reason: Invalidation, trigger?: SessionReason) => {
    if (
      state.phase === "closed" ||
      (state.phase === "closing" && phase !== "closed" && phase !== "closing")
    )
      return;
    if (phase === "uncertain" || phase === "faulted" || phase === "closing" || phase === "closed")
      terminalReason ??= trigger ?? (phase === "uncertain" ? "native-failure" : "closed");
    else if (trigger !== undefined) pauseReason = trigger;
    // A known trigger is retained even when the abort below interrupts dispatched work.
    if (!(state.phase === "faulted" && phase === "uncertain")) state.phase = phase;
    state.generation++;
    const pending = [...reservations.values()];

    reservations.clear();
    active?.abort();
    for (const reservation of pending) reservation.abort();
    invalidate(reason);
  };

  const terminate = (
    reason: SessionReason,
    disposition: "known" | "not-dispatched" | "unknown",
    generation = state.generation,
  ) => {
    if (disposition === "unknown") nativeUncertainty = true;
    record(reason, disposition === "known" ? "confirmed" : disposition, generation);
    fence(
      disposition === "unknown" ? "uncertain" : "faulted",
      disposition === "unknown" ? "uncertain" : "closed",
      reason,
    );
  };

  const expire = () => {
    if (terminalReason !== null || state.phase === "closing" || state.phase === "closed") return;
    terminate("expired", "known");
  };

  /** Quarantine changes admission only; an originating click keeps its own valid ticket. */
  const policy = (
    event: Extract<DriverFault, { readonly source: "policy" }>,
    generation: number,
  ) => {
    if (event.disposition !== "dispatched") record(event.reason, event.disposition, generation);
    const previous = policies.get(event.token);

    switch (event.disposition) {
      case "pending":
        if (previous === undefined && terminalReason === null) policies.set(event.token, event);
        break;
      case "dispatched":
        unresolved.add(event.token);
        if (previous !== undefined) policies.set(event.token, event);
        break;
      case "confirmed":
        unresolved.delete(event.token);
        policies.delete(event.token);
        break;
      case "unknown":
        // Keep the token so a late acknowledgement may retire it, but never reopen admission.
        unresolved.add(event.token);
        fence("uncertain", "uncertain", event.reason);
        break;
      case "not-dispatched":
        policies.delete(event.token);
        fence("faulted", "closed", event.reason);
        break;
    }
  };

  /** Taken under the permit that dispatched the work, so nothing can interleave before it. */
  const reserve = (key: string): Reservation => {
    // Outlives the fiber that dispatched it, and must be abortable by a fence from outside it.
    const controller = new AbortController();

    reservations.set(key, controller);
    unresolved.add(controller);

    return {
      signal: controller.signal,
      settle: (outcome) => {
        // A fence already cleared it, and decided the outcome for everything it aborted.
        if (reservations.get(key) !== controller) return;
        reservations.delete(key);
        if (outcome === "known") unresolved.delete(controller);
        else fence("uncertain", "uncertain");
      },
    };
  };

  const guard = <A, E, R>(
    operation: BrowserOperation,
    body: (ticket: Ticket) => Effect.Effect<A, E, R>,
    options: {
      readonly charge?: boolean | "host-read";
      readonly mutation?: boolean;
      readonly mutationScope?: () => ObservationScope;
      readonly phases?: ReadonlyArray<Phase>;
      readonly verifyAfter?: boolean;
      readonly preflight?: Effect.Effect<void, BrowserError>;
      /** Private recovery admission: one absolute deadline also bounds waiting for this permit. */
      readonly waitUntil?: number;
    } = {},
  ): Effect.Effect<A, E | BrowserError, R> =>
    Effect.suspend(() => {
      let admitted: Ticket | undefined;

      const work = Effect.gen(function* () {
        holdingPermit = true;
        if (!(options.phases ?? ["open"]).includes(state.phase) || policies.size > 0) {
          return yield* BrowserError.make({
            operation,
            reason:
              terminalReason === "expired"
                ? Reasons.Expired.make({})
                : state.phase === "paused" || (terminalReason === null && policies.size > 0)
                  ? Reasons.Busy.make({})
                  : Reasons.Closed.make({}),
            outcome: "undispatched",
          });
        }
        yield* options.preflight ?? Effect.void;
        const now = Number(yield* Clock.monotonicTimeNanos) / 1_000_000;

        if (now >= lifetimeDeadline) {
          expire();

          return yield* BrowserError.make({
            operation,
            reason: Reasons.Expired.make({}),
            outcome: "undispatched",
          });
        }

        const deadline = Math.min(
          options.waitUntil ?? now + limits.actionTimeoutMillis,
          lifetimeDeadline,
        );

        if (now >= deadline)
          return yield* BrowserError.make({
            operation,
            reason: Reasons.Timeout.make({}),
            outcome: "undispatched",
          });
        if (options.charge !== false) {
          const hostRead = options.charge === "host-read";
          const maximum = hostRead ? limits.maxHostReads : limits.maxActions;
          const observed = hostRead ? state.hostReads : state.actions;

          if (observed >= maximum)
            return yield* BrowserError.make({
              operation,
              reason: Reasons.Limit.make({
                dimension: hostRead ? "host-reads" : "actions",
                maximum,
                observed,
              }),
              outcome: "undispatched",
            });
          if (hostRead) state.hostReads++;
          else state.actions++;
        }
        // The lifecycle fence must actively abort admitted native work outside the current fiber.
        // @effect-diagnostics-next-line abortControllerInEffect:off
        const controller = new AbortController();

        active = controller;
        let dispatched = false;
        const generation = state.generation;
        const allowed = options.phases ?? ["open"];

        const check = () => {
          if (Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000 >= lifetimeDeadline) expire();
          if (
            controller.signal.aborted ||
            state.generation !== generation ||
            !allowed.includes(state.phase)
          ) {
            throw BrowserError.make({
              operation,
              reason: Reasons.Stale.make({}),
              outcome: dispatched ? "unknown" : "undispatched",
            });
          }
          if (Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000 >= deadline)
            throw BrowserError.make({
              operation,
              reason: Reasons.Timeout.make({}),
              outcome: dispatched ? "unknown" : "undispatched",
            });
        };

        const ticket: Ticket = {
          signal: controller.signal,
          deadline,
          generation,
          remainingMillis: () =>
            Math.max(1, deadline - Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000),
          get dispatched() {
            return dispatched;
          },
          check,
          dispatch() {
            check();
            if (!dispatched && options.mutation)
              invalidate("observation", options.mutationScope?.() ?? "all");
            dispatched = true;
            unresolved.add(controller);
          },
        };

        admitted = ticket;

        const uncertain = () => {
          // The action timer can win the same instant as the independent lifetime timer.
          if (Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000 >= lifetimeDeadline) expire();
          const fenced = controller.signal.aborted;

          controller.abort();
          if (dispatched && !fenced && state.phase !== "closing" && state.phase !== "closed")
            fence("uncertain", "uncertain");
        };

        return yield* within(body(ticket), ticket.deadline, () => {
          uncertain();

          return BrowserError.make({
            operation,
            reason: Reasons.Timeout.make({}),
            outcome: dispatched ? "unknown" : "undispatched",
          });
        }).pipe(
          Effect.tap(() =>
            options.verifyAfter === false
              ? Effect.void
              : Effect.try({
                  try: check,
                  catch: () =>
                    BrowserError.make({
                      operation,
                      reason: Reasons.Stale.make({}),
                      outcome: dispatched ? "unknown" : "undispatched",
                    }),
                }),
          ),
          Effect.catch((error): Effect.Effect<never, E | BrowserError> => {
            if (dispatched) uncertain();
            // The permit adds dispatch evidence only to browser-operation errors. Typed
            // initialization/consumer failures retain their identity and original family.
            if (!Schema.is(BrowserError)(error)) return Effect.fail(error);

            return Effect.fail(
              BrowserError.make({
                operation,
                reason: error.reason,
                outcome: error.outcome,
              }),
            );
          }),
          Effect.onInterrupt(() => Effect.sync(uncertain)),
          Effect.tap(() => Effect.sync(() => unresolved.delete(controller))),
          Effect.ensuring(
            Effect.sync(() => {
              controller.abort();
              if (active === controller) active = undefined;
            }),
          ),
        );
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            holdingPermit = false;
          }),
        ),
      );

      if (options.waitUntil !== undefined)
        return within(
          semaphore.withPermits(1)(work),
          Math.min(options.waitUntil, lifetimeDeadline),
          () =>
            BrowserError.make({
              operation,
              reason: Reasons.Timeout.make({}),
              outcome: admitted?.dispatched === true ? "unknown" : "undispatched",
            }),
        );

      return semaphore
        .withPermitsIfAvailable(1)(work)
        .pipe(
          Effect.flatMap(
            Effect.fromOption(() =>
              BrowserError.make({
                operation,
                reason: Reasons.Busy.make({}),
                outcome: "undispatched",
              }),
            ),
          ),
        );
    });

  /** Lifecycle transitions are performed while holding guard's permit; close alone preempts it. */
  return {
    state,
    lifetimeDeadline,
    guard,
    reserve,
    reserved: (key: string): boolean => reservations.has(key),
    invalidate,
    fence,
    transition,
    expire,
    terminate,
    policy,
    record,
    /** Only positive lifetime-source evidence may retire control lost to a connection fence. */
    retireControl: () => {
      unresolved.clear();
      nativeUncertainty = false;
      policies.clear();
    },
    status: Effect.sync(() =>
      Object.freeze(
        SessionStatus.make({
          phase: state.phase,
          reason: terminalReason ?? pauseReason ?? policies.values().next().value?.reason ?? null,
          generation: state.generation,
          busy: holdingPermit || policies.size > 0,
          unresolvedDispatch: nativeUncertainty || unresolved.size > 0,
        }),
      ),
    ),
    diagnostics: Effect.sync(() => {
      const snapshot = BrowserDiagnostics.make({
        records: [...records],
        total,
        dropped,
        truncated: dropped > 0,
      });

      // Schema construction owns its array; freeze the produced snapshot, not merely its input.
      for (const record of snapshot.records) Object.freeze(record);
      Object.freeze(snapshot.records);

      return Object.freeze(snapshot);
    }),
    onInvalidate(hook: (reason: Invalidation, scope: ObservationScope) => void): () => void {
      hooks.add(hook);

      return () => {
        hooks.delete(hook);
      };
    },
  };
});

export type Owner = Effect.Success<ReturnType<typeof makeOwner>>;

/** Without a native answer, whether the step was sent is all the owner knows about it. */
const unsettled = (ticket: Ticket): Pick<BrowserError, "reason" | "outcome"> => ({
  reason: Reasons.Provider.make({}),
  outcome: ticket.dispatched ? "unknown" : "undispatched",
});

/**
 * The one place a native step becomes a public error: whatever the driver raised, the caller
 * sees the operation it asked for.
 */
export const native = <A>(operation: BrowserOperation, ticket: Ticket, body: () => Promise<A>) =>
  Effect.callback<A, BrowserError>((resume) => {
    let done = false;

    const cleanup = () => {
      done = true;
      ticket.signal.removeEventListener("abort", abort);
    };

    const abort = () => {
      if (done) return;
      cleanup();
      resume(
        Effect.fail(
          BrowserError.make({
            operation,
            reason: Reasons.Stale.make({}),
            outcome: ticket.dispatched ? "unknown" : "undispatched",
          }),
        ),
      );
    };

    ticket.signal.addEventListener("abort", abort, { once: true });
    try {
      ticket.check();
      // Observe both branches even after the waiter exits. Cancellation does not undo native work.
      void body().then(
        (value) => {
          if (!done) {
            cleanup();
            resume(Effect.succeed(value));
          }
        },
        (error: unknown) => {
          if (!done) {
            cleanup();
            resume(Effect.fail(publicError(error, operation, unsettled(ticket))));
          }
        },
      );
    } catch (error) {
      cleanup();
      resume(Effect.fail(publicError(error, operation, unsettled(ticket))));
    }

    return Effect.sync(cleanup);
  });
