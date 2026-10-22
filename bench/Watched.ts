/** A consumer's watched browsing: retained preparation, an event-driven reveal and clean step cuts. */
import { type Cause, Deferred, Effect, Exit, Option, Scope } from "effect";
import type * as Browser from "effect-browser/Browser";
import type { BrowserError } from "effect-browser/BrowserError";
import type { Page } from "effect-browser/Page";
import * as Plan from "effect-browser/Plan";
import * as Stage from "effect-browser/Stage";
import type * as Supervisor from "effect-browser/Supervisor";

export interface Prepared<A> {
  readonly id: string;
  readonly generation: number;
  readonly browser: Browser.Service;
  readonly value: A;
  readonly page: Page;
  readonly hold: Scope.Closeable;
}

/** A turn includes the consumer's hold transfer, which follows the stage's commit. */
const ordered = () => {
  const waiting: Array<Deferred.Deferred<void>> = [];

  return <A, E, R>(work: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const turn = Deferred.makeUnsafe<void>();

        waiting.push(turn);
        if (waiting.length === 1) Deferred.doneUnsafe(turn, Exit.void);

        return turn;
      }),
      (turn) => Deferred.await(turn).pipe(Effect.andThen(Effect.uninterruptible(work))),
      (turn) =>
        Effect.sync(() => {
          const at = waiting.indexOf(turn);

          waiting.splice(at, 1);
          if (at === 0 && waiting[0] !== undefined) Deferred.doneUnsafe(waiting[0], Exit.void);
        }),
    );
};

/** The caller owns which plans are suitable preparation and which event deserves a reveal. */
export const make = Effect.fn("Watched.make")(function* <A, E>(
  sessions: Supervisor.Supervisor<{ readonly browser: Browser.Service; readonly value: A }, E>,
) {
  const stage = yield* Stage.make();
  const reveals = ordered();
  let shown: Prepared<A> | undefined;

  const prepare = Effect.fn("Watched.prepare")(function* (
    id: string,
    walk: Plan.Plan,
    options: Plan.TakeOptions = {},
  ) {
    const owner = yield* Effect.scope;

    const hold = yield* Scope.fork(owner);
    const ended = yield* Deferred.make<void>();

    const ready = yield* Deferred.make<
      Prepared<A>,
      | Plan.ReplayError
      | BrowserError
      | Supervisor.Unavailable<E>
      | Supervisor.InvalidWait
      | Supervisor.Superseded
      | Cause.TimeoutError
    >();

    yield* Scope.addFinalizer(hold, Deferred.succeed(ended, undefined));
    // A prepared page is live work. Rotation revokes it; the consumer opens a new view.
    yield* Effect.forkIn(
      sessions
        .use((lease) =>
          Effect.gen(function* () {
            const page = yield* Effect.acquireRelease(lease.value.browser.newPage(), (page) =>
              Effect.ignore(page.close),
            );

            yield* Plan.restore(page, walk, options);
            yield* Deferred.succeed(ready, {
              id,
              page,
              hold,
              browser: lease.value.browser,
              value: lease.value.value,
              generation: lease.generation,
            });
            yield* Deferred.await(ended);
          }).pipe(Scope.provide(hold)),
        )
        .pipe(
          Effect.ensuring(Scope.close(hold, Exit.void)),
          Effect.onExit((exit) =>
            Exit.isFailure(exit) ? Deferred.failCause(ready, exit.cause) : Effect.void,
          ),
          Effect.exit,
        ),
      owner,
    );

    return yield* Deferred.await(ready);
  });

  const reveal = Effect.fn("Watched.reveal")(
    <E, R>(next: Prepared<A>, sent: Effect.Effect<Option.Option<number>, E, R>) =>
      Effect.scoped(
        Effect.gen(function* () {
          const cue = yield* stage.cue(next.page);

          // Capture is running while the application waits for its actual send/drop event.
          yield* cue.ready;
          const event = yield* sent.pipe(Effect.timeout("20 seconds"));

          if (Option.isNone(event)) return Option.none<Stage.Presented>();

          // Once the event has gone out, commit and the consumer's hold transfer finish together.
          // Stage bounds capture/input draining; cancellation still works while awaiting the event.
          return yield* reveals(
            Effect.gen(function* () {
              const presented = yield* cue.commit({ at: event.value });
              const previous = shown;

              shown = next;
              if (previous !== undefined && previous !== next)
                yield* Scope.close(previous.hold, Exit.void);

              return Option.some(presented);
            }),
          );
        }),
      ),
  );

  const perform = Effect.fn("Watched.perform")(function* (
    prepared: Prepared<A>,
    plan: Plan.Plan,
    from: number | Plan.Stopped,
    stop: Deferred.Deferred<void>,
    options: Plan.TakeOptions = {},
  ) {
    const receipts: Array<Plan.Receipt> = [];
    let at = from;

    while ((typeof at === "number" ? at : at.step) < plan.steps.length) {
      const index = typeof at === "number" ? at : at.step;

      if (yield* Deferred.isDone(stop))
        return {
          receipts,
          stopped: Option.some(
            typeof at === "number" ? new Plan.Stopped({ step: index, input: "unsent" }) : at,
          ),
        };

      const receipt = yield* Plan.take(prepared.page, plan, at, options).pipe(
        Effect.mapError(
          (error) => new Plan.ReplayError({ ...error, receipts: [...receipts, ...error.receipts] }),
        ),
      );

      receipts.push(receipt);
      at = index + 1;
    }

    return { receipts, stopped: Option.none<Plan.Stopped>() };
  });

  return {
    prepare,
    reveal,
    perform,
    current: stage.current,
    output: stage.shown({ hold: "1 second" }),
  };
});
