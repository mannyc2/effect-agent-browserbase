/** Suspended test ports expose unfinished work and error logs in one explicit end check. */
import { Effect, Logger, Ref } from "effect";

import { ScriptError } from "./TestModel.ts";

export interface ErrorLog {
  readonly id: number;
  readonly options: Logger.Options<unknown>;
}

/** One story owns its ports and logger; interruption still removes the held invocation. */
export const make = Effect.gen(function* () {
  const checks = yield* Ref.make<ReadonlyArray<Effect.Effect<ReadonlyArray<string>>>>([]);
  const logged: Array<ErrorLog> = [];
  const asserted = yield* Ref.make<ReadonlyArray<number>>([]);

  const logger = Logger.layer([
    Logger.make((options) => {
      if (options.logLevel === "Error" || options.logLevel === "Fatal")
        logged.push({ id: logged.length + 1, options });
    }),
  ]);

  const port = <I, A, E = never>(
    name: string,
    steps: ReadonlyArray<(input: I) => Effect.Effect<A, E>>,
  ) =>
    Effect.gen(function* () {
      const state = yield* Ref.make({ next: 0, active: 0, unexpected: 0 });

      yield* Ref.update(checks, (known) => [
        ...known,
        Effect.map(Ref.get(state), (current) => [
          ...(current.active === 0 ? [] : [`${current.active} held ${name}`]),
          ...(current.next >= steps.length
            ? []
            : [`${steps.length - current.next} unused ${name}`]),
          ...(current.unexpected === 0 ? [] : [`${current.unexpected} unexpected ${name}`]),
        ]),
      ]);

      return (input: I) =>
        Effect.gen(function* () {
          const step = yield* Ref.modify(state, (current) => {
            const step = steps[current.next];

            return [
              step,
              {
                next: current.next + 1,
                active: current.active + (step === undefined ? 0 : 1),
                unexpected: current.unexpected + (step === undefined ? 1 : 0),
              },
            ];
          });

          if (step === undefined)
            return yield* new ScriptError({ detail: `unexpected ${name} call` });

          return yield* step(input).pipe(
            Effect.ensuring(
              Ref.update(state, (current) => ({ ...current, active: current.active - 1 })),
            ),
          );
        });
    });

  return {
    port,
    logger,
    logs: Effect.sync(() => [...logged]),
    assertLog: (id: number) =>
      Effect.gen(function* () {
        if (!logged.some((log) => log.id === id))
          return yield* new ScriptError({ detail: `unknown error log ${id}` });
        yield* Ref.update(asserted, (known) => [...known, id]);
      }),
    assertFinished: Effect.gen(function* () {
      const messages = (yield* Effect.all(yield* Ref.get(checks))).flat();
      const known = yield* Ref.get(asserted);
      const unseen = logged.filter((log) => !known.includes(log.id));

      if (unseen.length > 0) messages.push(`${unseen.length} unasserted error log`);
      if (messages.length > 0) return yield* new ScriptError({ detail: messages.join("; ") });
    }),
  };
});
