/** A separate, unwatched consumer: durable step checkpoints and bounded operator assistance. */
import { Effect } from "effect";
import type * as Browser from "effect-browser/Browser";
import type { Page } from "effect-browser/Page";
import * as Plan from "effect-browser/Plan";
import type * as Supervisor from "effect-browser/Supervisor";

/**
 * The consumer supplies durable storage and enforces one runner for each run/plan/input identity.
 * `begun` commits before input; until `done` commits, `read` returns that step as unknown.
 * Fresh/finished checkpoints use unsent at zero/the next step. Never infer unsent from a crash.
 */
export interface Journal<E> {
  readonly read: (run: string) => Effect.Effect<Plan.Stopped, E>;
  readonly begun: (run: string, step: number) => Effect.Effect<void, E>;
  readonly done: (run: string, receipt: Plan.Receipt) => Effect.Effect<void, E>;
}

/** Consumer authentication policy and the human/provider-viewer interaction stay outside the library. */
export interface Operator<E> {
  readonly needed: (page: Page) => Effect.Effect<boolean, E>;
  readonly resolve: (page: Page) => Effect.Effect<void, E>;
}

const assisted = <E>(
  browser: Browser.Service,
  page: Page,
  plan: Plan.Plan,
  at: number | Plan.Stopped,
  options: Plan.TakeOptions & { readonly operator?: Operator<E> },
) =>
  Plan.take(page, plan, at, options).pipe(
    Effect.catchTag("ReplayError", (error) =>
      Effect.gen(function* () {
        const step = plan.steps[error.step];
        const operator = options.operator;

        if (
          operator === undefined ||
          step === undefined ||
          (error.input === "unknown" && !Plan.repeatable(step)) ||
          !(yield* operator.needed(page))
        )
          return yield* error;

        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* browser.suspend({ drain: "5 seconds" });
            yield* operator.resolve(page).pipe(Effect.timeout("2 minutes"));
          }),
        );

        // Preserve the original stopping point. Operator assistance cannot authorize a duplicate.
        return yield* Plan.take(page, plan, error.stopped, options);
      }),
    ),
  );

export const run = Effect.fn("Workflow.run")(function* <A, E, O = never>(
  sessions: Supervisor.Supervisor<{ readonly browser: Browser.Service; readonly value: A }>,
  journal: Journal<E>,
  run: string,
  plan: Plan.Plan,
  options: Plan.TakeOptions & { readonly operator?: Operator<O> } = {},
) {
  const checkpoint = yield* journal.read(run);

  if (checkpoint.step >= plan.steps.length) return;

  yield* sessions.use((lease) =>
    Effect.gen(function* () {
      const page = yield* Effect.acquireRelease(lease.value.browser.newPage(), (page) =>
        Effect.ignore(page.close),
      );

      yield* Plan.restore(page, plan, { ...options, upTo: checkpoint.step });
      let at: number | Plan.Stopped = checkpoint;

      while ((typeof at === "number" ? at : at.step) < plan.steps.length) {
        const index: number = typeof at === "number" ? at : at.step;

        // If interruption, revocation, a lost acknowledgement or a journal failure follows this
        // write, recovery treats the input as unknown. No catch/retry discards that evidence.
        yield* journal.begun(run, index);
        const receipt = yield* assisted(lease.value.browser, page, plan, at, options);

        yield* journal.done(run, receipt);
        at = index + 1;
      }
    }),
  );
});
