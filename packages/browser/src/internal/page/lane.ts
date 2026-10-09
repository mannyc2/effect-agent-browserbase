/**
 * A page's admission: the one lane every operation on the page takes its turn in, so a page waits
 * only for itself. A write, an action that sends input or navigates, holds the lane alone, in the
 * order writes asked; reads share it, after the write in flight and every write asked before them,
 * so a read describes the page an action left, never one an action is still changing. Each write
 * starts a new epoch as it asks. A turn not given in time fails `Busy`, never `Timeout`, and a
 * caller under `FailFast` gets it at once.
 *
 * Reads keep their work. An identical read asked in the same epoch and document joins the one in
 * flight, which runs in the page's scope under the action timeout whoever gives up; one that ends
 * after all its callers gave up serves the next to ask the same, within an action timeout. A write
 * stops the reads nobody awaits, since no caller after it could use them.
 *
 * Effect's `Semaphore` is not fair to a writer that needs every permit, so the rule is this
 * module's own: one state, changed by `step` alone, which the model test drives.
 */
import { Context, Deferred, Duration, Effect, Exit, type Fiber, type Scope } from "effect";

import { BrowserError, Busy } from "../../BrowserError.ts";

export type Kind = "read" | "write";

export interface Ticket {
  readonly id: number;
  readonly kind: Kind;
}

/** Who holds the lane: no one, reads together, or one write. */
export type Turn =
  | { readonly _tag: "Free" }
  | { readonly _tag: "Reading"; readonly count: number }
  | { readonly _tag: "Writing" };

export interface State {
  readonly turn: Turn;
  /** The tickets waiting, in the order they asked. */
  readonly queue: ReadonlyArray<Ticket>;
  /** The writes asked so far: two reads in one epoch follow the same writes. */
  readonly epoch: number;
}

export type Input =
  | { readonly _tag: "Ask"; readonly ticket: Ticket }
  /** The ticket gave up waiting, or ended its turn. */
  | { readonly _tag: "Leave"; readonly ticket: Ticket };

export const initial: State = { turn: { _tag: "Free" }, queue: [], epoch: 0 };

const holders = (turn: Turn) =>
  turn._tag === "Reading" ? turn.count : turn._tag === "Writing" ? 1 : 0;

/** Whether a ticket of `kind` asking now would hold the lane at once. */
export const admitsNow = ({ turn, queue }: State, kind: Kind) =>
  queue.length === 0 && (kind === "read" ? turn._tag !== "Writing" : turn._tag === "Free");

/**
 * The operations ahead of a waiting ticket: those holding the lane and those asked before it, or
 * all that are queued for a ticket not in the queue.
 */
export const ahead = ({ turn, queue }: State, id?: number) => {
  const at = queue.findIndex((ticket) => ticket.id === id);

  return holders(turn) + (at === -1 ? queue.length : at);
};

/**
 * The lane after `input`, and the tickets it lets in. Tickets go in from the head of the queue
 * only: a write once the lane is free, reads while no write holds it, so reads asked before a
 * write go before it, and reads asked after it wait for it.
 */
export const step = (
  state: State,
  input: Input,
): { readonly state: State; readonly admitted: ReadonlyArray<Ticket> } => {
  let { turn, queue, epoch } = state;

  if (input._tag === "Ask") {
    queue = [...queue, input.ticket];
    if (input.ticket.kind === "write") epoch += 1;
  } else {
    const at = queue.findIndex((ticket) => ticket.id === input.ticket.id);

    if (at !== -1) queue = queue.toSpliced(at, 1);
    else
      turn =
        turn._tag === "Reading" && turn.count > 1
          ? { _tag: "Reading", count: turn.count - 1 }
          : { _tag: "Free" };
  }

  const admitted: Array<Ticket> = [];

  for (const ticket of queue) {
    if (ticket.kind === "write" ? turn._tag !== "Free" : turn._tag === "Writing") break;
    admitted.push(ticket);
    turn =
      ticket.kind === "write" ? { _tag: "Writing" } : { _tag: "Reading", count: holders(turn) + 1 };
  }

  return { state: { turn, queue: queue.slice(admitted.length), epoch }, admitted };
};

/** Whether operations on a busy page fail `Busy` at once rather than wait their turn. */
export const FailFast = Context.Reference<boolean>("effect-browser/internal/page/FailFast", {
  defaultValue: () => false,
});

/** The id a caller gives the actions it asks for, which each records as its `correlation`. */
export const Correlation = Context.Reference<string | undefined>(
  "effect-browser/internal/page/Correlation",
  { defaultValue: () => undefined },
);

/** A shared read in flight: its epoch, its result once it ends, and how many callers await it. */
interface Flight<A> {
  readonly epoch: number;
  readonly result: Deferred.Deferred<A, BrowserError>;
  waiting: number;
  fiber: Fiber.Fiber<A, BrowserError> | undefined;
}

export const make = (options: {
  readonly now: () => number;
  readonly actionTimeout: Duration.Duration;
  /** When the page's current document began: a read is shared only within one. */
  readonly documentAt: () => number;
  /** The failure of a read still awaited as the page closes. */
  readonly gone: (operation: string) => BrowserError;
  /** The page's scope, which shared reads run in. */
  readonly scope: Scope.Scope;
}) => {
  const { now, actionTimeout } = options;
  let state = initial;
  let tickets = 0;
  const admissions = new Map<number, Deferred.Deferred<void>>();
  // Each shared read's sweep, which a write runs as it asks.
  const sweeps: Array<() => void> = [];

  const apply = (input: Input) => {
    const next = step(state, input);

    state = next.state;
    if (input._tag === "Leave") admissions.delete(input.ticket.id);
    for (const ticket of next.admitted) {
      const admitted = admissions.get(ticket.id);

      admissions.delete(ticket.id);
      if (admitted !== undefined) Deferred.doneUnsafe(admitted, Exit.void);
    }
    if (input._tag === "Ask" && input.ticket.kind === "write") for (const sweep of sweeps) sweep();
  };

  const busy = (operation: string, askedAt: number, id?: number) =>
    new BrowserError({
      operation,
      reason: new Busy({ waitedMillis: Math.round(now() - askedAt), ahead: ahead(state, id) }),
      dispatched: false,
    });

  /**
   * Run `effect` in a turn of `kind`, waiting at most `wait` for it, or failing `Busy`. The turn
   * ends with `effect`, however it ends.
   */
  const turn =
    (kind: Kind, operation: string, wait: Duration.Duration) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | BrowserError, R> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const ticket: Ticket = { id: ++tickets, kind };
          const askedAt = now();

          if ((yield* FailFast) && !admitsNow(state, kind)) return yield* busy(operation, askedAt);
          const admitted = Deferred.makeUnsafe<void>();

          admissions.set(ticket.id, admitted);
          apply({ _tag: "Ask", ticket });

          const given = yield* Effect.exit(
            restore(
              Deferred.await(admitted).pipe(
                Effect.timeoutOrElse({
                  duration: wait,
                  orElse: () =>
                    Deferred.isDoneUnsafe(admitted)
                      ? Effect.void
                      : Effect.fail(busy(operation, askedAt, ticket.id)),
                }),
              ),
            ),
          );

          if (Exit.isFailure(given)) {
            apply({ _tag: "Leave", ticket });

            return yield* Effect.failCause(given.cause);
          }

          return yield* restore(effect).pipe(
            Effect.ensuring(Effect.sync(() => apply({ _tag: "Leave", ticket }))),
          );
        }),
      );

  /**
   * A read whose identical calls share their work: `work` runs once per epoch and document while
   * calls await it, and with `keep` its result serves the next call after all of them gave up,
   * within an action timeout of its end. Pictures, whose callers say how old they may be, only
   * join.
   */
  const shared = <A>(operation: string, keep: boolean) => {
    const flights = new Map<string, Flight<A>>();
    const kept = new Map<string, { readonly value: A; readonly until: number }>();

    sweeps.push(() => {
      kept.clear();
      for (const flight of flights.values())
        if (flight.waiting === 0) flight.fiber?.interruptUnsafe();
    });

    // A read in flight, its first caller waiting. However its fiber ends, even before it began,
    // as when the page closes, its callers hear.
    const start = (id: string, work: Effect.Effect<A, BrowserError>) =>
      Effect.gen(function* () {
        const flight: Flight<A> = {
          epoch: state.epoch,
          result: Deferred.makeUnsafe(),
          waiting: 1,
          fiber: undefined,
        };

        flights.set(id, flight);
        flight.fiber = yield* turn(
          "read",
          operation,
          actionTimeout,
        )(work).pipe(
          // The caller chose whether to wait; the work it started serves others too.
          Effect.provideService(FailFast, false),
          Effect.forkIn(options.scope),
        );
        flight.fiber.addObserver((exit) => {
          flights.delete(id);
          if (keep && Exit.isSuccess(exit) && flight.waiting === 0 && flight.epoch === state.epoch)
            kept.set(id, { value: exit.value, until: now() + Duration.toMillis(actionTimeout) });
          Deferred.doneUnsafe(
            flight.result,
            Exit.hasInterrupts(exit) ? Effect.fail(options.gone(operation)) : exit,
          );
        });

        return flight;
      });

    const join = (id: string, work: Effect.Effect<A, BrowserError>) =>
      Effect.acquireUseRelease(
        Effect.suspend(() => {
          const flying = flights.get(id);

          if (flying === undefined) return start(id, work);
          flying.waiting += 1;

          return Effect.as(Effect.annotateCurrentSpan("shared", "joined"), flying);
        }),
        (flight) => Deferred.await(flight.result),
        (flight) =>
          Effect.sync(() => {
            flight.waiting -= 1;
            if (flight.waiting === 0 && flight.epoch < state.epoch) flight.fiber?.interruptUnsafe();
          }),
      );

    return (key: string, work: Effect.Effect<A, BrowserError>): Effect.Effect<A, BrowserError> =>
      Effect.gen(function* () {
        const id = `${state.epoch} ${options.documentAt()} ${key}`;
        const at = now();

        for (const [old, { until }] of kept) if (until < at) kept.delete(old);
        const hit = kept.get(id);

        if (hit !== undefined) {
          kept.delete(id);
          yield* Effect.annotateCurrentSpan("shared", "kept");

          return hit.value;
        }
        if ((yield* FailFast) && !admitsNow(state, "read")) return yield* busy(operation, at);

        return yield* join(id, work);
      });
  };

  return {
    /** A turn alone, for an action: `wait` bounds the wait for it. */
    write: (operation: string, wait: Duration.Duration) => turn("write", operation, wait),
    /** A turn beside other reads, waited for within the action timeout. */
    read: (operation: string) => turn("read", operation, actionTimeout),
    shared,
  };
};

export type Lane = ReturnType<typeof make>;
