import {
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Schema,
  Scope,
  Semaphore,
} from "effect";
import { RunToolScheduling } from "effect-agent/run-options";
import type { BrowserSession, NavigationOperation } from "effect-browser/browser";
import type { InputReceipt, SessionStatus } from "effect-browser/browser-data";
import { BrowserError, Reasons, type InitializationError } from "effect-browser/errors";

import type {
  FormToolHandlers,
  KeyboardToolHandlers,
  NativeToolHandlers,
  ObservedToolHandlers,
  ReadingToolHandlers,
  SelectionToolHandlers,
  ToolHandlers,
  ToolHostServices,
  WaitToolHandlers,
} from "./Definitions.ts";
import { sequentialScheduling } from "./Guidance.ts";
import { type Call, failureWith, type Hooks, makeLayers, navigationResult } from "./Handlers.ts";
import { BrowserToolFailure } from "./Model.ts";
import { type HandlerOptions, option, resolveOptions } from "./Options.ts";
import { continuationFor } from "./Results.ts";

export type ToolRunRequirements<R> = Exclude<Exclude<R, ToolHostServices>, Scope.Scope>;

/**
 * The host's one invocation lane. Every Tool call waits its turn, and a call that cannot enter
 * the queue, or waits past its deadline, is refused without dispatching anything.
 */
export interface LaneOptions {
  /** Calls admitted at once, the active one included; 32 by default (1–1024). */
  readonly maxOutstanding?: number;
  /** How long a call may wait for the lane, 30000 ms by default (1–600000). */
  readonly maxQueueMillis?: number;
}

export interface HostOptions<E = never, R = never> extends HandlerOptions {
  /**
   * Runs beside completion of the one navigation already dispatched. Returning does not finish
   * navigation. `operation.stop` explicitly stops it; cancelling a waiter alone does not.
   * The callback and any scoped work it starts are joined before the Tool returns.
   */
  readonly onNavigation?: (event: {
    readonly operation: NavigationOperation;
    readonly toolCallId: string | undefined;
  }) => Effect.Effect<void, E, R | Scope.Scope>;
  /** Called after real pointer or keyboard input, with the unmodified host-only receipt. */
  readonly onInput?: (event: {
    readonly receipt: InputReceipt;
    readonly toolCallId: string | undefined;
  }) => Effect.Effect<void, E, R | Scope.Scope>;
  readonly lane?: LaneOptions;
  /**
   * How `run` schedules this package's Tools within one model response. `sequential`, the
   * default, has Effect Agent run each browser call alone and in the order the model declared
   * it, while other Tools still run concurrently between them. `lane` leaves the engine's own
   * scheduling alone; the host lane still runs one call at a time, in no promised order.
   */
  readonly scheduling?: "sequential" | "lane";
}

export type ToolHostFailure<OwnerError = never, CallbackError = never> =
  | OwnerError
  | CallbackError
  | InitializationError
  | BrowserError;

/** Original bounded browser error fields, copied before the model-facing projection. */
export interface ToolFailureDiagnostic {
  readonly error: Pick<BrowserError, "_tag" | "operation" | "reason" | "outcome">;
  /** The Tool whose call failed. */
  readonly toolName: string;
  /** IDs longer than 256 UTF-16 code units are omitted, never shortened into a different ID. */
  readonly toolCallId: string | undefined;
  readonly toolCallIdOmitted: boolean;
}

/** A memory-only snapshot of the latest 32 ordinary browser failures, oldest first. */
export interface ToolFailureSnapshot {
  /** Current owner state at snapshot read time, not historical state at the recorded failure. */
  readonly status: SessionStatus;
  readonly failures: ReadonlyArray<ToolFailureDiagnostic>;
  /** Entries evicted from the bounded window; saturates at Number.MAX_SAFE_INTEGER. */
  readonly dropped: number;
}

export interface ToolHost<OwnerError = never, CallbackError = never> {
  readonly handlers: Layer.Layer<ToolHandlers>;
  readonly readingHandlers: Layer.Layer<ReadingToolHandlers>;
  readonly nativeHandlers: Layer.Layer<NativeToolHandlers>;
  readonly keyboardHandlers: Layer.Layer<KeyboardToolHandlers>;
  readonly selectionHandlers: Layer.Layer<SelectionToolHandlers>;
  readonly waitHandlers: Layer.Layer<WaitToolHandlers>;
  readonly formHandlers: Layer.Layer<FormToolHandlers>;
  readonly observedHandlers: Layer.Layer<ObservedToolHandlers>;
  /** All Tool handler services. The agent still sees only the Toolkits it explicitly declares. */
  readonly layer: Layer.Layer<ToolHostServices>;
  /** First host callback, navigation-cleanup or browser fail-session cause. */
  readonly failure: Effect.Effect<never, ToolHostFailure<OwnerError, CallbackError>>;
  /** Original ordinary action errors. Reading never enters browser admission and works after close. */
  readonly toolFailures: Effect.Effect<ToolFailureSnapshot>;
  /** Provide this host's handlers and supervise the program without closing the borrowed browser. */
  readonly run: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | ToolHostFailure<OwnerError, CallbackError>, ToolRunRequirements<R>>;
}

const encodeBrowserError = Schema.encodeSync(BrowserError);

interface Invocation {
  readonly host: object;
  active: boolean;
}

/** Inherited invocation extents, including enclosing hosts; never a public service requirement. */
const invocations = Context.Reference<ReadonlyArray<Invocation>>(
  "effect-agent-browser/Tools/invocations",
  {
    defaultValue: () => [],
  },
);

const HostSettings = {
  maxOutstanding: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1024 })),
  maxQueueMillis: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 600_000 })),
  scheduling: Schema.Literals(["sequential", "lane"]),
};

/**
 * Scoped host composition over the same maintained handlers. Options are checked here, once;
 * an invalid one fails acquisition with a `Configuration` reason naming it. Dependencies are
 * captured here; callback failures are retained on `failure` and only a bounded failure reaches
 * the model. Closing this scope joins its supervised programs, Tool calls and callbacks without
 * closing the borrowed browser. A cancelled navigation asks its exact operation to stop before
 * the operation scope can fence abandonment.
 */
export const makeHost = Effect.fnUntraced(function* <OwnerError, E = never, R = never>(
  browser: BrowserSession<OwnerError>,
  options: HostOptions<E, R> = {},
): Effect.fn.Return<ToolHost<OwnerError, E>, BrowserError, Exclude<R, Scope.Scope> | Scope.Scope> {
  const resolved = yield* resolveOptions(options);

  const maximumInvocations = yield* option(
    "lane.maxOutstanding",
    HostSettings.maxOutstanding,
    options.lane?.maxOutstanding,
    32,
  );

  const maximumQueueMillis = yield* option(
    "lane.maxQueueMillis",
    HostSettings.maxQueueMillis,
    options.lane?.maxQueueMillis,
    30_000,
  );

  const scheduling = yield* option(
    "scheduling",
    HostSettings.scheduling,
    options.scheduling,
    "sequential",
  );

  const consumer = yield* Effect.context<Exclude<R, Scope.Scope>>();
  const scope = yield* Scope.make("sequential");
  const failure = yield* Deferred.make<never, ToolHostFailure<OwnerError, E>>();
  const lane = yield* Semaphore.make(1);
  const clock = yield* Clock.Clock;
  const identity = {};
  const { onNavigation, onInput } = options;
  const toolFailures: ToolFailureDiagnostic[] = [];
  let dropped = 0;
  let closed = false;
  let outstanding = 0;

  const recordFailure = (error: BrowserError, call: Call) => {
    const encoded = encodeBrowserError(error);
    const toolCallIdOmitted = call.id !== undefined && call.id.length > 256;

    if (toolFailures.length === 32) {
      toolFailures.shift();
      dropped = Math.min(Number.MAX_SAFE_INTEGER, dropped + 1);
    }
    toolFailures.push(
      Object.freeze({
        error: Object.freeze({ ...encoded, reason: Object.freeze({ ...encoded.reason }) }),
        toolName: call.tool,
        toolCallId: toolCallIdOmitted ? undefined : call.id,
        toolCallIdOmitted,
      }),
    );
  };

  yield* Effect.addFinalizer((exit) =>
    Effect.sync(() => {
      closed = true;
    }).pipe(Effect.andThen(Scope.close(scope, exit))),
  );

  yield* browser.failure.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause) ? Effect.void : Deferred.failCause(failure, cause),
    ),
    Effect.forkIn(scope, { startImmediately: true }),
  );

  const callbackFailed = () => BrowserToolFailure.make({ reason: "failed", outcome: "unknown" });

  const invoke = Effect.fnUntraced(function* (effect: Effect.Effect<void, E, R | Scope.Scope>) {
    const enclosing = yield* invocations;

    return yield* Effect.scoped(effect).pipe(
      Effect.provideContext(Context.add(consumer, invocations, enclosing)),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;

        return Deferred.failCause(failure, cause).pipe(
          Effect.andThen(Effect.fail(callbackFailed())),
        );
      }),
    );
  });

  const run = <A, E2>(effect: Effect.Effect<A, E2>): Effect.Effect<A, E2 | BrowserToolFailure> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const enclosing = yield* invocations;

        if (enclosing.some((invocation) => invocation.host === identity && invocation.active))
          return yield* BrowserToolFailure.make({ reason: "busy", outcome: "undispatched" });
        if (closed)
          return yield* BrowserToolFailure.make({ reason: "closed", outcome: "undispatched" });
        if (Deferred.isDoneUnsafe(failure))
          return yield* BrowserToolFailure.make({ reason: "failed", outcome: "undispatched" });
        if (outstanding >= maximumInvocations)
          return yield* BrowserToolFailure.make({ reason: "busy", outcome: "undispatched" });

        const now = () => Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000;
        const deadline = now() + maximumQueueMillis;
        const invocation: Invocation = { host: identity, active: false };

        outstanding++;

        const admitted = lane.withPermits(1)(
          Effect.suspend((): Effect.Effect<A, E2 | BrowserToolFailure> => {
            if (closed)
              return Effect.fail(
                BrowserToolFailure.make({ reason: "closed", outcome: "undispatched" }),
              );
            if (Deferred.isDoneUnsafe(failure))
              return Effect.fail(
                BrowserToolFailure.make({ reason: "failed", outcome: "undispatched" }),
              );
            if (now() >= deadline)
              return Effect.fail(
                BrowserToolFailure.make({ reason: "timeout", outcome: "undispatched" }),
              );

            invocation.active = true;

            return restore(effect).pipe(
              Effect.provideService(invocations, [
                ...enclosing.filter((entry) => entry.active),
                invocation,
              ]),
            );
          }),
        );

        // Race the bracketed acquisition, never a naked take: cancellation cannot leak a permit.
        // Once admitted, neither a queue deadline nor a waiting-only failure can relabel input.
        const waiting = Effect.suspend(() => Effect.sleep(Math.max(0, deadline - now()))).pipe(
          Effect.provideService(Clock.Clock, clock),
          Effect.as("timeout" as const),
          Effect.raceFirst(Deferred.await(failure).pipe(Effect.exit, Effect.as("failed" as const))),
          Effect.flatMap((reason) =>
            Effect.suspend(() =>
              invocation.active
                ? Effect.never
                : Effect.fail(BrowserToolFailure.make({ reason, outcome: "undispatched" })),
            ),
          ),
        );

        // Reserve before forking; the host owns this fiber before it can wait for admission.
        const fiber = yield* Effect.forkIn(
          Effect.raceFirst(admitted, waiting).pipe(Effect.interruptible),
          scope,
        );

        return yield* restore(Fiber.join(fiber)).pipe(
          Effect.ensuring(Fiber.interrupt(fiber)),
          Effect.ensuring(
            Effect.sync(() => {
              outstanding--;
              // Captured contexts can outlive a call; they must not retain an active reentry marker.
              invocation.active = false;
            }),
          ),
        );
      }),
    );

  const navigate: NonNullable<Hooks["navigate"]> = Effect.fnUntraced(function* (request, call) {
    const onFailure = failureWith({ run, failure: recordFailure }, call);
    const operation = yield* browser.startNavigation(request).pipe(Effect.mapError(onFailure));
    let settled = false;

    const completed = operation.completed.pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (Exit.isSuccess(exit) || !Cause.hasInterruptsOnly(exit.cause)) settled = true;
        }),
      ),
      Effect.flatMap((result) => navigationResult(result.url)),
      Effect.mapError(onFailure),
    );

    // Start the callback before racing completion, including a navigation already settled.
    const callback =
      onNavigation === undefined
        ? undefined
        : yield* invoke(
            Effect.suspend(() => onNavigation({ operation, toolCallId: call.id })),
          ).pipe(Effect.forkScoped({ startImmediately: true }));

    const observed =
      callback === undefined
        ? completed
        : Effect.raceFirst(Fiber.join(callback).pipe(Effect.andThen(Effect.never)), completed).pipe(
            Effect.ensuring(Fiber.interrupt(callback)),
            Effect.filterOrFail(() => !Deferred.isDoneUnsafe(failure), callbackFailed),
          );

    return yield* observed.pipe(
      Effect.onExit(() =>
        settled
          ? Effect.void
          : operation.stop.pipe(
              Effect.onError((cause) => Deferred.failCause(failure, cause)),
              Effect.mapError(onFailure),
            ),
      ),
    );
  }, Effect.scoped);

  const hooks: Hooks = {
    run,
    navigate,
    failure: recordFailure,
    input: (receipt, call) =>
      onInput === undefined
        ? Effect.void
        : invoke(Effect.suspend(() => onInput({ receipt, toolCallId: call.id }))),
  };

  const layers = makeLayers(browser, resolved, hooks, continuationFor(browser));

  const layer = Layer.mergeAll(
    layers.handlers,
    layers.readingHandlers,
    layers.nativeHandlers,
    layers.keyboardHandlers,
    layers.selectionHandlers,
    layers.waitHandlers,
    layers.formHandlers,
    layers.observedHandlers,
  );

  /** Browser calls in declaration order, whatever scheduling the caller already provides. */
  const scheduled = <A, E2, R2>(effect: Effect.Effect<A, E2, R2>) =>
    scheduling === "lane"
      ? effect
      : Effect.gen(function* () {
          const existing = yield* RunToolScheduling;

          return yield* Effect.provideService(
            effect,
            RunToolScheduling,
            sequentialScheduling(existing),
          );
        });

  const supervise: ToolHost<OwnerError, E>["run"] = (effect) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (closed)
          return yield* BrowserError.make({
            operation: "close",
            reason: Reasons.Closed.make({}),
            outcome: "undispatched",
          });
        if (Deferred.isDoneUnsafe(failure)) return yield* Deferred.await(failure);

        const fiber = yield* Effect.forkIn(
          restore(Effect.scoped(scheduled(effect.pipe(Effect.provide(layer))))),
          scope,
          { startImmediately: true },
        );

        return yield* restore(Effect.raceFirst(Deferred.await(failure), Fiber.join(fiber))).pipe(
          Effect.ensuring(Fiber.interrupt(fiber)),
        );
      }),
    );

  return {
    handlers: layers.handlers,
    readingHandlers: layers.readingHandlers,
    nativeHandlers: layers.nativeHandlers,
    keyboardHandlers: layers.keyboardHandlers,
    selectionHandlers: layers.selectionHandlers,
    waitHandlers: layers.waitHandlers,
    formHandlers: layers.formHandlers,
    observedHandlers: layers.observedHandlers,
    layer,
    failure: Deferred.await(failure),
    toolFailures: Effect.gen(function* () {
      const status = yield* browser.status;

      return Object.freeze({
        status,
        failures: Object.freeze([...toolFailures]),
        dropped,
      });
    }),
    run: supervise,
  };
});

/** Scope one Tool host and each program run, provide handlers, and supervise without owning the browser. */
export const run = <OwnerError, A, E2, R2, CallbackError = never, CallbackR = never>(
  browser: BrowserSession<OwnerError>,
  effect: Effect.Effect<A, E2, R2>,
  options: HostOptions<CallbackError, CallbackR> = {},
): Effect.Effect<
  A,
  E2 | ToolHostFailure<OwnerError, CallbackError>,
  ToolRunRequirements<R2> | Exclude<CallbackR, Scope.Scope>
> => Effect.scoped(makeHost(browser, options).pipe(Effect.flatMap((host) => host.run(effect))));
