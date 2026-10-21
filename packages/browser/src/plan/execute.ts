/** Replay and restore with durable read-back before repeating uncertain consequential input. */
import { Clock, Duration, Effect, Exit, Option, Schedule, Schema } from "effect";

import { type Action } from "../Action.ts";
import { type BrowserError, InvalidRequest, undispatched } from "../BrowserError.ts";
import type { Page, ReadyOptions, Target } from "../Page.ts";
import * as Stillness from "../stillness/Stillness.ts";
import { type Ambiguous, Drifted, type Missing } from "./choose.ts";
import { type Plan, Step, Receipt, Stopped, Uncertain, ReplayError } from "./data.ts";
import { aim, locate } from "./targets.ts";

const invalid = (detail: string) => undispatched("replay", new InvalidRequest({ detail }));

const dispatch = (
  page: Page,
  step: Step,
  text: string,
): Effect.Effect<void, Missing | Ambiguous | Drifted | BrowserError> => {
  const action = step.action;
  const point = (target: Target) => (typeof target === "object" ? target : undefined);

  const resolved: Effect.Effect<Action, Missing | Ambiguous | Drifted | BrowserError> = Effect.gen(
    function* () {
      switch (action._tag) {
        case "Goto":
          return { ...action, url: step.input === undefined ? action.url : text };
        case "Back":
        case "Reload":
          return action;
        case "Press":
          return {
            ...action,
            options: {
              ...action.options,
              on: step.subject === undefined ? undefined : (yield* locate(page, step.subject)).ref,
            },
          };
        case "Click":
        case "Hover":
          return {
            ...action,
            target: yield* aim(page, step.subject, point(action.target), step.box),
          };
        case "Drag":
          return {
            ...action,
            from: yield* aim(page, step.subject, point(action.from)),
            to: yield* aim(page, step.to, point(action.to)),
          };
        case "Select":
          return {
            ...action,
            ref: (yield* locate(
              page,
              step.subject ?? (yield* invalid("a selection needs a subject")),
            )).ref,
          };
        case "Scroll":
          return step.subject === undefined
            ? action
            : {
                ...action,
                options: {
                  ...action.options,
                  at: yield* aim(
                    page,
                    step.subject,
                    action.options?.at === undefined ? undefined : point(action.options.at),
                    step.box,
                  ),
                },
              };
        case "Type":
          return {
            ...action,
            text: step.input === undefined ? action.text : text,
            options: {
              ...action.options,
              into:
                step.subject === undefined ? undefined : (yield* locate(page, step.subject)).ref,
            },
          };
      }
    },
  );

  return Effect.flatMap(resolved, page.perform).pipe(Effect.asVoid);
};

export interface TakeOptions {
  /** How each step waits first, except an opening navigation, or false. No final-step wait. */
  readonly settle?: ReadyOptions | false | undefined;
  readonly inputs?: Readonly<Record<string, string>> | undefined;
  /**
   * Bound for recorded arrival and expected effect, each. Defaults to 5 seconds. Zero makes one
   * read without polling; that read retains the page operation's timeout.
   */
  readonly arrival?: Duration.Input | undefined;
}

export interface ReplayOptions extends TakeOptions {
  readonly from?: number | Stopped | undefined;
}

/**
 * Input that can be repeated without repeating a commitment. `take` also validates a Checked
 * target's boolean state before input. Back/reload can resubmit a form.
 */
export const repeatable = (step: Step): boolean =>
  ["Goto", "Hover", "Scroll", "Select"].includes(step.action._tag) ||
  (step.action._tag === "Type" &&
    step.subject !== undefined &&
    step.action.options?.replace !== false &&
    step.action.options?.submit !== true) ||
  (step.action._tag === "Click" && step.expect?._tag === "Checked");

type StepError = Missing | Ambiguous | Drifted | BrowserError | Uncertain;

// Zero waits make one read; positive waits bound all reads and never repeat input.
const within = (check: Effect.Effect<boolean, StepError>, millis: number) =>
  millis === 0
    ? check
    : check.pipe(
        Effect.repeat({ until: (held) => held, schedule: Schedule.spaced(Duration.millis(25)) }),
        Effect.timeoutOrElse({
          duration: Duration.millis(millis),
          orElse: () => Effect.succeed(false),
        }),
      );

const sameSite = (url: string, recorded: string) => {
  const origin = URL.parse(recorded)?.origin;

  return (
    recorded === "" ||
    (origin === undefined || origin === "null"
      ? url === recorded
      : URL.parse(url)?.origin === origin)
  );
};

const arrived = (page: Page, urls: ReadonlyArray<string>, millis: number) =>
  within(
    Effect.map(page.url, (url) => urls.some((recorded) => sameSite(url, recorded))),
    millis,
  ).pipe(
    Effect.filterOrFail(
      (held) => held,
      () =>
        new Drifted({ detail: "the page did not reach the recorded site within the arrival wait" }),
    ),
    Effect.asVoid,
  );

const checkEffect = (
  page: Page,
  step: Step,
  first?: { readonly url: string; readonly document: number; readonly connection: string },
  millis = 0,
) => {
  const expected = step.expect;

  if (expected === undefined) return Effect.succeed(false);
  switch (expected._tag) {
    case "Checked":
      return step.subject === undefined
        ? Effect.fail(invalid("a checked effect needs a subject"))
        : Effect.flatMap(locate(page, step.subject), (found) =>
            found.state.checked === undefined
              ? Effect.fail(invalid("a checked effect needs a checkable subject"))
              : Effect.succeed(found.state.checked === expected.checked),
          );
    case "Navigated":
      if (expected.url === undefined && first === undefined) return Effect.succeed(false);

      return Effect.map(page.state, (now) =>
        expected.url === undefined
          ? now.url !== first?.url ||
            (now.connection === first?.connection && now.document !== first?.document)
          : now.url === expected.url,
      );
    case "Appeared":
    case "Gone":
      return Effect.map(
        page.until(
          { ...expected.query, scope: "document" },
          expected._tag === "Appeared" ? "some" : "none",
          millis,
        ),
        ({ met }) => met,
      );
  }
};

/**
 * Take one step. Unknown non-repeatable input is never resent: only positive durable read-back
 * can skip it. An interrupted call remains interrupted; persist begun-before-call in the consumer
 * and treat a missing receipt as Stopped{input: "unknown"}, including after process restart.
 */
export const take = Effect.fn("Plan.take")(function* (
  page: Page,
  plan: Plan,
  at: number | Stopped,
  options: TakeOptions = {},
): Effect.fn.Return<Receipt, ReplayError> {
  const index = typeof at === "number" ? at : at.step;
  let input: Stopped["input"] = typeof at === "number" ? "unsent" : at.input;

  const work = Effect.gen(function* (): Effect.fn.Return<Receipt, StepError> {
    const step = plan.steps[index];

    if (!Number.isInteger(index) || index < 0 || step === undefined)
      return yield* invalid("the step index is outside the plan");
    if (!Schema.is(Step.fields.action)(step.action))
      return yield* invalid("the step action cannot be replayed");
    const duration = Duration.fromInput(options.arrival ?? Duration.seconds(5));

    if (
      Option.isNone(duration) ||
      Duration.isNegative(duration.value) ||
      !Duration.isFinite(duration.value)
    )
      return yield* invalid("arrival must be a finite nonnegative duration");
    const millis = Duration.toMillis(duration.value);
    const first = yield* page.state;

    const uncertain = new Uncertain({
      detail: "the step may have been sent; reconcile its durable effect before continuing",
    });

    const unresolved = input === "unknown" && !repeatable(step);
    const expected = step.expect;

    const durable =
      expected !== undefined &&
      (expected._tag === "Appeared" ||
        (expected._tag === "Navigated" && typeof expected.url === "string")) &&
      expected.durable === true;

    if (
      !durable &&
      (unresolved || (expected !== undefined && "durable" in expected && expected.durable === true))
    )
      return yield* uncertain;
    if (
      options.settle !== false &&
      (index > 0 || !["Goto", "Back", "Reload"].includes(step.action._tag))
    )
      yield* options.settle?.quietMillis === undefined
        ? page.ready(options.settle)
        : Stillness.wait(page, {
            ...options.settle,
            still: "content",
            quietMillis: options.settle.quietMillis,
          });
    const before = plan.steps[index - 1]?.url;

    if (before !== undefined)
      yield* arrived(page, unresolved ? [before, step.url] : [before], millis);
    const check = checkEffect(page, step);

    const read =
      millis === 0
        ? check
        : check.pipe(
            Effect.timeoutOrElse({
              duration: Duration.millis(millis),
              orElse: () =>
                Effect.fail(new Drifted({ detail: "the expected-effect read timed out" })),
            }),
          );

    const held = yield* read.pipe(Effect.mapError((error) => (unresolved ? uncertain : error)));

    const receipt = (outcome: Receipt["outcome"]) =>
      Effect.gen(function* () {
        yield* arrived(page, [step.url], millis);
        const now = yield* page.state;

        return new Receipt({ step: index, outcome, startedAt: first.at, at: now.at });
      });

    if (held) return yield* receipt("skipped");
    if (unresolved) return yield* uncertain;
    const text = step.input === undefined ? "" : options.inputs?.[step.input];

    if (text === undefined) return yield* invalid(`no text for the input "${step.input ?? ""}"`);
    const baseline = yield* page.state;

    const verify = within(checkEffect(page, step, baseline, millis), millis);

    const acted = yield* Effect.exit(dispatch(page, step, text));

    if (Exit.isFailure(acted)) {
      const error = Exit.findErrorOption(acted);

      if (Option.isSome(error) && error.value._tag === "BrowserError" && error.value.dispatched) {
        input = "unknown";
        if (expected !== undefined && (repeatable(step) || durable)) {
          const observed = yield* Effect.exit(verify);

          if (Exit.isSuccess(observed) && observed.value) return yield* receipt("verified");
        }
      }

      return yield* Effect.failCause(acted.cause);
    }
    input = "unknown";
    if (expected !== undefined && !(yield* verify))
      return yield* new Drifted({ detail: "the step's expected effect did not arrive" });

    return yield* receipt(expected === undefined ? "taken" : "verified");
  });

  return yield* work.pipe(
    Effect.provideService(Clock.Clock, page.clock),
    Effect.mapError(
      (reason) =>
        new ReplayError({
          step: index,
          reason,
          input,
          receipts: [],
        }),
    ),
  );
});

const run = Effect.fnUntraced(function* (
  page: Page,
  plan: Plan,
  options: TakeOptions,
  from: number | Stopped,
  until: number,
  restoring: boolean,
) {
  const receipts: Array<Receipt> = [];
  const start = typeof from === "number" ? from : from.step;

  if (
    !Number.isInteger(start) ||
    start < 0 ||
    start > plan.steps.length ||
    !Number.isInteger(until) ||
    until < start ||
    until > plan.steps.length
  )
    return yield* new ReplayError({
      step: start,
      input: "unsent",
      receipts,
      reason: invalid("the run bounds are outside the plan"),
    });
  // Fresh runs still ask for all input slots before changing the page. Restoration checks first.
  if (!restoring && typeof from === "number") {
    const unfilled = plan.steps.findIndex(
      (step, index) =>
        index >= start && step.input !== undefined && options.inputs?.[step.input] === undefined,
    );

    if (unfilled !== -1)
      return yield* new ReplayError({
        step: start,
        input: "unsent",
        receipts,
        reason: invalid(`no text for the input "${plan.steps[unfilled]?.input ?? ""}"`),
      });
  }
  for (let index = start; index < until; index++) {
    const at = restoring
      ? new Stopped({ step: index, input: "unknown" })
      : index === start
        ? from
        : index;

    const receipt = yield* take(page, plan, at, options).pipe(
      Effect.mapError((error) => new ReplayError({ ...error, receipts: [...receipts] })),
    );

    receipts.push(receipt);
  }

  return receipts;
});

/** Take a plan's steps from a fresh index or durable stopping point, returning completed receipts. */
export const replay = (page: Page, plan: Plan, options: ReplayOptions = {}) =>
  run(page, plan, options, options.from ?? 0, plan.steps.length, false).pipe(
    Effect.withSpan("Plan.replay"),
  );

/** Restore prior steps on a fresh page; unresolved commitments require positive durable evidence. */
export const restore = (
  page: Page,
  plan: Plan,
  options: TakeOptions & { readonly upTo?: number | undefined } = {},
) =>
  run(page, plan, options, 0, options.upTo ?? plan.steps.length, true).pipe(
    Effect.withSpan("Plan.restore"),
  );
