import { Clock, Effect, Schema, Semaphore } from "effect";
import { BrowserbaseError } from "../Types.ts";
import { deadlineAfter, nowMillis, within } from "./Deadline.ts";

export type Phase = "acquiring" | "open" | "paused" | "detached" | "uncertain" | "closing" | "closed";
export type Invalidation = "observation" | "target-changed" | "resized" | "paused" | "disconnected" | "uncertain" | "closed";

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

  const invalidate = (reason: Invalidation) => {
    state.revision++;
    for (const hook of hooks) hook(reason);
  };

  const fence = (phase: Phase, reason: Invalidation) => {
    if (state.phase === "closed" || (state.phase === "closing" && phase !== "closed" && phase !== "closing")) return;
    state.phase = phase;
    state.generation++;
    active?.abort();
    invalidate(reason);
  };

  const guard = <A, R>(
    operation: string,
    body: (ticket: Ticket) => Effect.Effect<A, BrowserbaseError, R>,
    options: { readonly charge?: boolean; readonly mutation?: boolean; readonly phases?: ReadonlyArray<Phase>; readonly verifyAfter?: boolean; readonly preflight?: Effect.Effect<void, BrowserbaseError> } = {},
  ): Effect.Effect<A, BrowserbaseError, R> => semaphore.withPermitsIfAvailable(1)(
    Effect.gen(function* () {
      if (!(options.phases ?? ["open"]).includes(state.phase)) {
        return yield* BrowserbaseError.make({
          operation, reason: state.phase === "paused" ? "busy" : "closed", outcome: "undispatched",
        });
      }
      yield* options.preflight ?? Effect.void;
      const now = yield* nowMillis;
      if (now >= lifetimeDeadline) {
        fence("uncertain", "uncertain");
        return yield* BrowserbaseError.make({ operation, reason: "timeout", outcome: "undispatched" });
      }
      if (options.charge !== false) {
        if (state.actions >= limits.maxActions) return yield* BrowserbaseError.make({ operation, reason: "limit", outcome: "undispatched" });
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
        if (controller.signal.aborted || state.generation !== generation || !allowed.includes(state.phase)) {
          throw BrowserbaseError.make({ operation, reason: "stale", outcome: dispatched ? "unknown" : "undispatched" });
        }
      };
      const ticket: Ticket = {
        signal: controller.signal,
        deadline: Math.min(now + limits.actionTimeoutMillis, lifetimeDeadline),
        generation,
        remainingMillis: () => Math.max(1, Math.min(now + limits.actionTimeoutMillis, lifetimeDeadline) - Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000),
        get dispatched() { return dispatched; },
        check,
        dispatch() { check(); if (!dispatched && options.mutation) invalidate("observation"); dispatched = true; },
      };
      const uncertain = () => {
        controller.abort();
        if (dispatched && state.phase !== "closing" && state.phase !== "closed") fence("uncertain", "uncertain");
      };
      return yield* within(body(ticket), ticket.deadline, operation, uncertain).pipe(
        Effect.tap((_) => options.verifyAfter === false ? Effect.void : Effect.try({ try: check, catch: () => BrowserbaseError.make({ operation, reason: "stale", outcome: dispatched ? "unknown" : "undispatched" }) })),
        Effect.catch((error) => {
          if (dispatched) uncertain();
          return Effect.fail(BrowserbaseError.make({
            operation,
            reason: error.reason,
            outcome: error.outcome ?? (dispatched ? "unknown" : "undispatched"),
            ...(error.status === undefined ? {} : { status: error.status }),
            ...(error.retryAfterMillis === undefined ? {} : { retryAfterMillis: error.retryAfterMillis }),
          }));
        }),
        Effect.onInterrupt(() => Effect.sync(uncertain)),
        Effect.ensuring(Effect.sync(() => {
          controller.abort();
          if (active === controller) active = undefined;
        })),
      );
    }),
  ).pipe(Effect.flatMap(Effect.fromOption(() => BrowserbaseError.make({ operation, reason: "busy", outcome: "undispatched" }))));

  /** Lifecycle transitions are performed while holding guard's permit; close alone preempts it. */
  return {
    state,
    lifetimeDeadline,
    guard,
    invalidate,
    fence,
    onInvalidate(hook: (reason: Invalidation) => void): () => void {
      hooks.add(hook);
      return () => { hooks.delete(hook); };
    },
  };
});

export type Owner = Effect.Success<ReturnType<typeof makeOwner>>;

export const native = <A>(operation: string, ticket: Ticket, body: () => Promise<A>) =>
  Effect.callback<A, BrowserbaseError>((resume) => {
    let done = false;
    const cleanup = () => { done = true; ticket.signal.removeEventListener("abort", abort); };
    const abort = () => {
      if (done) return;
      cleanup();
      resume(Effect.fail(BrowserbaseError.make({ operation, reason: "stale", outcome: ticket.dispatched ? "unknown" : "undispatched" })));
    };
    ticket.signal.addEventListener("abort", abort, { once: true });
    try {
      ticket.check();
      // Observe both branches even after the waiter exits. Cancellation does not undo native work.
      void body().then((value) => {
        if (!done) { cleanup(); resume(Effect.succeed(value)); }
      }, (error: unknown) => {
        if (!done) { cleanup(); resume(Effect.fail(sanitizeNativeError(error, operation, ticket.dispatched))); }
      });
    } catch (error) {
      cleanup(); resume(Effect.fail(sanitizeNativeError(error, operation, ticket.dispatched)));
    }
    return Effect.sync(cleanup);
  });

const sanitizeNativeError = (error: unknown, operation: string, dispatched: boolean): BrowserbaseError =>
  Schema.is(BrowserbaseError)(error) ? error : BrowserbaseError.make({
    operation, reason: "provider", outcome: dispatched ? "unknown" : "undispatched",
  });
