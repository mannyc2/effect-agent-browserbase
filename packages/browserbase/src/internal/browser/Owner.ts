import { Clock, Effect, Schema, Semaphore } from "effect";

import { BrowserError, type BrowserOperation } from "../../Errors.ts";
import { deadlineAfter, nowMillis, until } from "../Deadline.ts";
import { publicError } from "./NativeCalls.ts";

/** The browser domain's bounded step: one deadline, one declared BrowserError timeout. */
export const within = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  deadline: number,
  operation: BrowserOperation,
  onTimeout?: () => void,
): Effect.Effect<A, E | BrowserError, R> =>
  until(effect, deadline, () => {
    onTimeout?.();

    return BrowserError.make({ operation, reason: "timeout" });
  });

export type Phase =
  | "acquiring"
  | "open"
  | "paused"
  | "detached"
  | "uncertain"
  | "closing"
  | "closed";

export type Invalidation =
  | "observation"
  | "target-changed"
  | "resized"
  | "paused"
  | "disconnected"
  | "uncertain"
  | "closed";

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
  readonly maxElapsedMillis: number;
  readonly actionTimeoutMillis: number;
}

export const makeOwner = Effect.fnUntraced(function* (limits: Limits) {
  const semaphore = yield* Semaphore.make(1);
  const clock = yield* Clock.Clock;
  const lifetimeDeadline = yield* deadlineAfter(limits.maxElapsedMillis);
  const hooks = new Set<(reason: Invalidation) => void>();

  const state = {
    phase: "acquiring" as Phase,
    generation: 0,
    revision: 0,
    selection: 0,
    actions: 0,
  };

  let active: AbortController | undefined;
  const reservations = new Map<string, AbortController>();

  const invalidate = (reason: Invalidation) => {
    state.revision++;
    for (const hook of hooks) hook(reason);
  };

  const fence = (phase: Phase, reason: Invalidation) => {
    if (
      state.phase === "closed" ||
      (state.phase === "closing" && phase !== "closed" && phase !== "closing")
    )
      return;
    state.phase = phase;
    state.generation++;
    active?.abort();
    for (const reservation of reservations.values()) reservation.abort();
    reservations.clear();
    invalidate(reason);
  };

  /** Taken under the permit that dispatched the work, so nothing can interleave before it. */
  const reserve = (key: string): Reservation => {
    // Outlives the fiber that dispatched it, and must be abortable by a fence from outside it.
    const controller = new AbortController();

    reservations.set(key, controller);

    return {
      signal: controller.signal,
      settle: (outcome) => {
        // A fence already cleared it, and decided the outcome for everything it aborted.
        if (reservations.get(key) !== controller) return;
        reservations.delete(key);
        if (outcome === "unknown") fence("uncertain", "uncertain");
      },
    };
  };

  const guard = <A, E, R>(
    operation: BrowserOperation,
    body: (ticket: Ticket) => Effect.Effect<A, E, R>,
    options: {
      readonly charge?: boolean;
      readonly mutation?: boolean;
      readonly phases?: ReadonlyArray<Phase>;
      readonly verifyAfter?: boolean;
      readonly preflight?: Effect.Effect<void, BrowserError>;
    } = {},
  ): Effect.Effect<A, E | BrowserError, R> =>
    semaphore
      .withPermitsIfAvailable(1)(
        Effect.gen(function* () {
          if (!(options.phases ?? ["open"]).includes(state.phase)) {
            return yield* BrowserError.make({
              operation,
              reason: state.phase === "paused" ? "busy" : "closed",
              outcome: "undispatched",
            });
          }
          yield* options.preflight ?? Effect.void;
          const now = yield* nowMillis;

          if (now >= lifetimeDeadline) {
            fence("uncertain", "uncertain");

            return yield* BrowserError.make({
              operation,
              reason: "timeout",
              outcome: "undispatched",
            });
          }
          if (options.charge !== false) {
            if (state.actions >= limits.maxActions)
              return yield* BrowserError.make({
                operation,
                reason: "limit",
                outcome: "undispatched",
              });
            state.actions++;
          }
          // The lifecycle fence must actively abort admitted native work outside the current fiber.
          // @effect-diagnostics-next-line abortControllerInEffect:off
          const controller = new AbortController();

          active = controller;
          let dispatched = false;
          const generation = state.generation;
          const allowed = options.phases ?? ["open"];

          const check = () => {
            if (
              controller.signal.aborted ||
              state.generation !== generation ||
              !allowed.includes(state.phase)
            ) {
              throw BrowserError.make({
                operation,
                reason: "stale",
                outcome: dispatched ? "unknown" : "undispatched",
              });
            }
          };

          const ticket: Ticket = {
            signal: controller.signal,
            deadline: Math.min(now + limits.actionTimeoutMillis, lifetimeDeadline),
            generation,
            remainingMillis: () =>
              Math.max(
                1,
                Math.min(now + limits.actionTimeoutMillis, lifetimeDeadline) -
                  Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000,
              ),
            get dispatched() {
              return dispatched;
            },
            check,
            dispatch() {
              check();
              if (!dispatched && options.mutation) invalidate("observation");
              dispatched = true;
            },
          };

          const uncertain = () => {
            controller.abort();
            if (dispatched && state.phase !== "closing" && state.phase !== "closed")
              fence("uncertain", "uncertain");
          };

          return yield* within(body(ticket), ticket.deadline, operation, uncertain).pipe(
            Effect.tap((_) =>
              options.verifyAfter === false
                ? Effect.void
                : Effect.try({
                    try: check,
                    catch: () =>
                      BrowserError.make({
                        operation,
                        reason: "stale",
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
                  outcome: error.outcome ?? (dispatched ? "unknown" : "undispatched"),
                  ...(error.status === undefined ? {} : { status: error.status }),
                  ...(error.retryAfterMillis === undefined
                    ? {}
                    : { retryAfterMillis: error.retryAfterMillis }),
                }),
              );
            }),
            Effect.onInterrupt(() => Effect.sync(uncertain)),
            Effect.ensuring(
              Effect.sync(() => {
                controller.abort();
                if (active === controller) active = undefined;
              }),
            ),
          );
        }),
      )
      .pipe(
        Effect.flatMap(
          Effect.fromOption(() =>
            BrowserError.make({ operation, reason: "busy", outcome: "undispatched" }),
          ),
        ),
      );

  /** Lifecycle transitions are performed while holding guard's permit; close alone preempts it. */
  return {
    state,
    lifetimeDeadline,
    guard,
    reserve,
    reserved: (key: string): boolean => reservations.has(key),
    invalidate,
    fence,
    onInvalidate(hook: (reason: Invalidation) => void): () => void {
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
  reason: "provider",
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
            reason: "stale",
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
