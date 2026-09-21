import {
  Context,
  Deferred,
  Effect,
  Layer,
  Option,
  Ref,
  Stream,
  SubscriptionRef,
  type Duration,
} from "effect";

import { type Answer, type Cue, PollMillis, type Report } from "./Cues.ts";
import { FootageError } from "./FootageError.ts";

/** A distributive `Omit`, so each cue keeps its own fields once its id is removed. */
type WithoutId<C> = C extends { readonly id: number } ? Omit<C, "id"> : never;

export type CueRequest = WithoutId<Cue>;

interface Pending {
  readonly id: number;
  readonly cue: Cue;
  readonly answer: Deferred.Deferred<Answer>;
}

/** Longer than any single track, shorter than a viewer's patience. */
const CueDeadline: Duration.Input = "30 seconds";

/**
 * The host's half of the cue exchange.
 *
 * One cue is outstanding at a time and it stays in its slot until a page
 * reports it finished. Handing a cue over does not consume it, so a call left
 * behind by a replaced document can take a cue without losing it: that reply is
 * discarded by the library, and the live document is given the same cue.
 */
export class Director extends Context.Service<
  Director,
  {
    /** The binding's handler: settle what the page reports, then wait for its next cue. */
    readonly exchange: (report: Report) => Effect.Effect<Cue>;
    /** Give the page one cue and wait for the report that answers it. */
    readonly perform: (request: CueRequest) => Effect.Effect<Answer, FootageError>;
  }
>()("effect-browserbase/examples/realistic-footage/Director") {
  static readonly layer = Layer.effect(
    Director,
    Effect.gen(function* () {
      const slot = yield* SubscriptionRef.make(Option.none<Pending>());
      const lastId = yield* Ref.make(0);

      const settle = (report: Report) =>
        report._tag === "Waiting"
          ? Effect.void
          : SubscriptionRef.modify(slot, (pending) =>
              Option.isSome(pending) && pending.value.id === report.id
                ? [Deferred.succeed(pending.value.answer, report), Option.none<Pending>()]
                : [Effect.succeed(false), pending],
            ).pipe(Effect.flatten);

      const exchange = Effect.fnUntraced(function* (report: Report) {
        yield* settle(report);

        const next = yield* SubscriptionRef.changes(slot).pipe(
          Stream.filter(Option.isSome),
          Stream.runHead,
          Effect.timeoutOption(PollMillis),
        );

        return Option.match(Option.flatten(Option.flatten(next)), {
          onNone: (): Cue => ({ _tag: "Idle" }),
          onSome: (pending) => pending.cue,
        });
      });

      const perform = Effect.fn("Director.perform")(function* (request: CueRequest) {
        const id = yield* Ref.updateAndGet(lastId, (previous) => previous + 1);
        const answer = yield* Deferred.make<Answer>();

        yield* Effect.annotateCurrentSpan({ cue: request._tag, id });
        yield* SubscriptionRef.set(slot, Option.some({ id, cue: { ...request, id }, answer }));

        return yield* Deferred.await(answer).pipe(
          Effect.timeoutOrElse({
            duration: CueDeadline,
            orElse: () =>
              Effect.fail(FootageError.make({ reason: "stagehand-silent", detail: request._tag })),
          }),
          // An abandoned cue must not be played by whichever document asks next.
          Effect.ensuring(
            SubscriptionRef.update(
              slot,
              Option.filter((pending) => pending.id !== id),
            ),
          ),
        );
      });

      return Director.of({ exchange, perform });
    }),
  );
}
