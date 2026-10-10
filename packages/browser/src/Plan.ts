/**
 * A walk recorded once from a page's events and replayed later, on a fresh page, with no model
 * call.
 *
 * `fromEvents` keeps one page's completed actions with their subjects and the options they were
 * given, its navigations with both the address asked for and the one reached, and what was typed
 * as a named input slot, never the text itself. A navigation to an address whose credentials the
 * events withheld is an input slot too, so replay goes where the caller says, or nowhere, and
 * never to the address without them. `replay` takes the steps in turn. Before a step
 * that acts on the page, it waits for `Page.ready`; then it finds the one element the step's
 * subject names, by role and name among those that repeat all its recorded context, and acts on
 * it. Text typed into focus was typed into the focused field, which replay finds the same way, and
 * text typed into a secret field goes into nothing else. An element step never falls back to
 * coordinates, and a step recorded at a point acts there only while the element found for it still
 * covers that point. `take` and `replay` return receipts; failure preserves a stopping point and
 * earlier receipts. Unknown consequential input is never resent. Only a positive durable read-back
 * can reconcile it; restoration follows the same rule. The consumer journals begun steps before
 * calling, treating interruption or a missing receipt as unknown. Plain recordings use version 1;
 * authored expected effects use version 2. Old 0.2 plans and unknown versions do not decode.
 *
 * @since 0.3.0
 */
import { Duration, Effect, Exit, Option, Schedule, Schema } from "effect";

import { BrowserError, InvalidRequest } from "./BrowserError.ts";
import {
  type Action,
  ActionOptions,
  Box,
  type BrowserEvent,
  type Navigated,
  Subject,
} from "./BrowserEvent.ts";
import { undispatched } from "./internal/page/context.ts";
import { Ambiguous, choose, Drifted, Missing } from "./internal/reading/choose.ts";
import {
  type Found,
  type Page,
  type Point,
  type ReadyOptions,
  redacted,
  type Target,
} from "./Page.ts";

export { Ambiguous, Drifted, Missing } from "./internal/reading/choose.ts";

const ViewportPoint = Schema.Struct({ x: Schema.Finite, y: Schema.Finite });

export const StepAction = Schema.Literals([
  "navigate",
  "back",
  "reload",
  "click",
  "hover",
  "drag",
  "type",
  "press",
  "scroll",
  "select",
]);

export type StepAction = typeof StepAction.Type;

const Query = Schema.Struct({
  role: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
});

/**
 * What a step leaves. `durable` asserts an author-chosen, lasting read-back of this operation,
 * such as its uniquely named saved receipt. A toast or an intermediate address is not durable.
 * Even a durable check's absence never authorizes repeating unknown consequential input.
 */
export const Expected = Schema.Union([
  Schema.TaggedStruct("Checked", { checked: Schema.Boolean }),
  Schema.TaggedStruct("Appeared", {
    query: Query,
    durable: Schema.optional(Schema.Literal(true)),
  }),
  Schema.TaggedStruct("Gone", {
    query: Query,
    durable: Schema.optional(Schema.Literal(true)),
  }),
  Schema.TaggedStruct("Navigated", {
    url: Schema.optional(Schema.String),
    durable: Schema.optional(Schema.Literal(true)),
  }),
]);

export type Expected = typeof Expected.Type;

/** One recorded step: the action, what it acted on, and what else it was asked. */
export class Step extends Schema.Class<Step>("effect-browser/Plan/Step")({
  action: StepAction,
  /** Where the page was once the step was done, as recorded; empty when unknown. */
  url: Schema.String,
  /** A navigation's requested address, or the keys a press pressed. */
  target: Schema.optional(Schema.String),
  subject: Schema.optional(Subject),
  /** Where a drag ended. */
  to: Schema.optional(Subject),
  /** The viewport point a step aimed at, when it aimed at a point, and a drag's end point. */
  point: Schema.optional(ViewportPoint),
  toPoint: Schema.optional(ViewportPoint),
  /** The box of what a step aimed at by point found there, so replay aims at the same place in it. */
  box: Schema.optional(Box),
  /**
   * The input slot whose text a `type` step types, or whose address a `navigate` step goes to, as
   * its recorded address had a credential withheld.
   */
  input: Schema.optional(Schema.String),
  /** The slot's text went into a secret field, so replay types it into nothing else. */
  secret: Schema.optional(Schema.Literal(true)),
  options: Schema.optional(ActionOptions),
  expect: Schema.optional(Expected),
}) {}

const PlanData = Schema.Struct({
  version: Schema.Literals([1, 2]),
  steps: Schema.Array(Step),
}).check(
  Schema.makeFilter((plan) =>
    plan.version === (plan.steps.some((step) => step.expect !== undefined) ? 2 : 1)
      ? undefined
      : "only plans with expected effects use version 2",
  ),
);

export class Plan extends Schema.Class<Plan>("effect-browser/Plan")(PlanData) {
  /** Choose the encoding version from the steps; simple recordings remain version 1. */
  static new(steps: ReadonlyArray<Step>): Plan {
    return new Plan({ version: steps.some((step) => step.expect !== undefined) ? 2 : 1, steps });
  }

  /** The input slots its steps type, in order; replay needs text for each. */
  get inputs(): ReadonlyArray<string> {
    return this.steps.flatMap((step) => (step.input === undefined ? [] : [step.input]));
  }
}

/** One completed step, on the page's host clock. `verified` means its expected effect was seen. */
export class Receipt extends Schema.Class<Receipt>("effect-browser/Plan/Receipt")({
  step: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  outcome: Schema.Literals(["taken", "verified", "skipped"]),
  startedAt: Schema.Finite,
  at: Schema.Finite,
}) {}

/** Durable stopping data. A begun step without a receipt must be restored as `unknown`. */
export class Stopped extends Schema.Class<Stopped>("effect-browser/Plan/Stopped")({
  step: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  input: Schema.Literals(["unsent", "unknown"]),
}) {}

/** Repeating this step could repeat an unresolved effect; the consumer must reconcile it. */
export class Uncertain extends Schema.TaggedError<Uncertain>()("Uncertain", {
  detail: Schema.String,
}) {
  override get message() {
    return this.detail;
  }
}

/** Where replay stopped, counting steps from 0, why, and the steps that completed before it. */
export class ReplayError extends Schema.TaggedError<ReplayError>()("ReplayError", {
  step: Schema.Int,
  reason: Schema.Union([Missing, Ambiguous, Drifted, BrowserError, Uncertain]),
  input: Schema.Literals(["unsent", "unknown"]),
  receipts: Schema.Array(Receipt),
}) {
  get stopped(): Stopped {
    return new Stopped({ step: this.step, input: this.input });
  }

  override get message() {
    return `step ${this.step} failed: ${this.reason.message}`;
  }
}

const isStep = (event: BrowserEvent): event is Action & { readonly name: StepAction } =>
  event._tag === "Action" &&
  event.ok &&
  (StepAction.literals as ReadonlyArray<string>).includes(event.name);

// A point target reads `x,y`, as `{"x":…,"y":…}` inside a drag's; a ref reads like e12.
const pointIn = (target: string | undefined): Point | undefined => {
  const parsed = /^\{?(?:"x":)?(-?[\d.]+),(?:"y":)?(-?[\d.]+)\}?$/.exec(target ?? "");

  return parsed === null ? undefined : { x: Number(parsed[1]), y: Number(parsed[2]) };
};

/** A slot named for the field it fills, such as `email`, unique within the plan. */
const slotFor = (taken: Set<string>, field: string | undefined) => {
  const base =
    field
      ?.toLowerCase()
      .match(/[\p{L}\p{N}]+/gu)
      ?.join("-") ?? "input";

  let slot = base;

  for (let count = 2; taken.has(slot); count++) slot = `${base}-${count}`;
  taken.add(slot);

  return slot;
};

/**
 * The walk one page's events record: the completed actions of the page that acted first, in
 * order. `page.recentEvents` gives them, or `browser.events()` read until the walk ends.
 */
export const fromEvents = (events: Iterable<BrowserEvent>): Plan => {
  const all = Array.from(events);
  const page = all.find((event) => event._tag === "Action")?.page;
  const mine = all.filter((event) => "page" in event && event.page === page);
  const steps = mine.filter(isStep);
  const opened = mine.find((event) => event._tag === "PageOpened")?.url ?? "";
  const moves = mine.filter((event): event is Navigated => event._tag === "Navigated");
  const taken = new Set<string>();

  // Where the page was just before a time: the last address it reached by then.
  const before = (time: number) => moves.findLast((move) => move.at <= time)?.url ?? opened;

  return new Plan({
    version: 1,
    steps: steps.map((action, index) => {
      const drag = action.name === "drag" ? (action.target ?? "").split(" -> ") : undefined;
      const point = pointIn(drag === undefined ? action.target : drag[0]);

      // Only a navigation and a press keep their target: an address, or keys.
      return new Step({
        action: action.name,
        url: action.url ?? before(steps[index + 1]?.startedAt ?? Number.POSITIVE_INFINITY),
        target: action.name === "navigate" || action.name === "press" ? action.target : undefined,
        subject: action.subject,
        to: action.to,
        point,
        toPoint: pointIn(drag?.[1]),
        box: point === undefined ? undefined : action.box,
        input:
          action.name === "type"
            ? slotFor(taken, action.subject?.name)
            : action.name === "navigate" && action.target?.includes(redacted) === true
              ? slotFor(taken, "address")
              : undefined,
        secret: action.name === "type" && action.text === redacted ? true : undefined,
        options: action.options,
      });
    }),
  });
};

/**
 * The one element on the page that a subject names, by role, name and context (see `Plan`),
 * looking again for two seconds while the page may still be drawing it.
 */
export const locate = (page: Page, subject: Subject) =>
  page
    .find({
      name: subject.name,
      scope: "document",
      ...(subject.role === null ? {} : { role: subject.role }),
    })
    .pipe(
      Effect.flatMap((found) => choose(subject, found)),
      Effect.retry({
        schedule: Schedule.spaced(Duration.millis(250)),
        times: 8,
        while: (error) => error._tag !== "BrowserError",
      }),
      Effect.withSpan("Plan.locate", { attributes: { role: subject.role ?? "" } }),
    );

const invalid = (detail: string) => undispatched("replay", new InvalidRequest({ detail }));

/**
 * Where the step acts: the element its subject names, or, for a step recorded at a point, the same
 * place within that element, as long as a press there reaches that element and not one over it.
 * An element out of view is first brought into it, by hovering it, as a press by ref would be.
 */
const aim = (page: Page, subject: Subject | undefined, point?: Point, recorded?: Box) => {
  if (subject === undefined) return Effect.fail(invalid("the step names no element"));
  if (point === undefined) return Effect.map(locate(page, subject), ({ ref }): Target => ref);

  const reach = ({ ref, box }: Found) => {
    const at =
      recorded === undefined || recorded.width <= 0 || recorded.height <= 0
        ? point
        : {
            x: box.x + ((point.x - recorded.x) / recorded.width) * box.width,
            y: box.y + ((point.y - recorded.y) / recorded.height) * box.height,
          };

    return Effect.map(page.find({ at }), ([reached]) => (reached?.ref === ref ? at : undefined));
  };

  const missed = new Drifted({ detail: "a press at the subject's point reaches another element" });

  return locate(page, subject).pipe(
    Effect.flatMap((found) =>
      Effect.flatMap(reach(found), (at) =>
        at !== undefined
          ? Effect.succeed<Target>(at)
          : page.hover(found.ref).pipe(
              Effect.andThen(locate(page, subject)),
              Effect.flatMap(reach),
              Effect.flatMap((again) =>
                again === undefined ? Effect.fail(missed) : Effect.succeed<Target>(again),
              ),
            ),
      ),
    ),
  );
};

const dispatch = (
  page: Page,
  step: Step,
  text: string,
): Effect.Effect<void, Missing | Ambiguous | Drifted | BrowserError> => {
  const options = step.options ?? {};

  switch (step.action) {
    case "navigate":
      return page.goto(step.input === undefined ? (step.target ?? step.url) : text);
    case "back":
      return page.back;
    case "reload":
      return page.reload;
    case "press":
      return step.subject === undefined
        ? page.press(step.target ?? "", options)
        : Effect.flatMap(locate(page, step.subject), ({ ref }) =>
            page.press(step.target ?? "", { ...options, on: ref }),
          );
    case "click":
      return aim(page, step.subject, step.point, step.box).pipe(
        Effect.flatMap((at) => page.click(at, options)),
        Effect.asVoid,
      );
    case "hover":
      return Effect.flatMap(aim(page, step.subject, step.point, step.box), page.hover);
    case "drag":
      return Effect.all([
        aim(page, step.subject, step.point),
        aim(page, step.to, step.toPoint),
      ]).pipe(Effect.flatMap(([from, to]) => page.drag(from, to)));
    case "select":
      return aim(page, step.subject).pipe(
        Effect.flatMap((at) => page.select(typeof at === "string" ? at : "", options.values ?? [])),
        Effect.asVoid,
      );
    // A scroll or a typing step may name no element: the page, or whatever has focus.
    case "scroll":
      return step.subject === undefined
        ? page.scroll(options)
        : Effect.flatMap(aim(page, step.subject, step.point, step.box), (at) =>
            page.scroll({ ...options, at }),
          );
    case "type":
      return step.subject === undefined
        ? page.type(text, { ...options, secret: step.secret })
        : Effect.flatMap(aim(page, step.subject), (into) =>
            page.type(text, {
              ...options,
              into: typeof into === "string" ? into : undefined,
              secret: step.secret,
            }),
          );
  }
};

export interface TakeOptions {
  /** How each step waits for the page first, or false not to wait. */
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

/** Input that can be repeated without repeating a commitment. Back/reload can resubmit a form. */
export const repeatable = (step: Step): boolean =>
  ["navigate", "hover", "scroll", "select"].includes(step.action) ||
  (step.action === "type" &&
    step.subject !== undefined &&
    step.options?.replace !== false &&
    step.options?.submit !== true) ||
  (step.action === "click" && step.expect?._tag === "Checked");

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
  first: { readonly url: string; readonly document: number },
) => {
  const expected = step.expect;

  if (expected === undefined) return Effect.succeed(false);
  switch (expected._tag) {
    case "Checked":
      return step.subject === undefined
        ? Effect.fail(invalid("a checked effect needs a subject"))
        : Effect.map(
            locate(page, step.subject),
            (found) => found.state.checked === expected.checked,
          );
    case "Navigated":
      return Effect.map(page.state, (now) =>
        expected.url === undefined
          ? now.url !== first.url || now.document !== first.document
          : now.url === expected.url,
      );
    case "Appeared":
    case "Gone":
      return Effect.map(page.find({ ...expected.query, scope: "document" }), (found) =>
        expected._tag === "Appeared" ? found.length > 0 : found.length === 0,
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

    if (
      unresolved &&
      (expected === undefined || expected._tag === "Checked" || expected.durable !== true)
    )
      return yield* uncertain;
    const settle = options.settle === false ? Effect.void : page.ready(options.settle);

    if (!["navigate", "back", "reload"].includes(step.action)) yield* settle;
    const before = plan.steps[index - 1]?.url;

    if (before !== undefined)
      yield* arrived(page, unresolved ? [before, step.url] : [before], millis);
    const check = checkEffect(page, step, first);

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
        if (index === plan.steps.length - 1) yield* settle;
        yield* arrived(page, [step.url], millis);
        const now = yield* page.state;

        return new Receipt({ step: index, outcome, startedAt: first.at, at: now.at });
      });

    if (held) return yield* receipt("skipped");
    if (unresolved) return yield* uncertain;
    const text = step.input === undefined ? "" : options.inputs?.[step.input];

    if (text === undefined) return yield* invalid(`no text for the input "${step.input ?? ""}"`);
    const acted = yield* Effect.exit(dispatch(page, step, text));

    if (Exit.isFailure(acted)) {
      const error = Exit.findErrorOption(acted);

      if (Option.isSome(error) && error.value._tag === "BrowserError" && error.value.dispatched) {
        input = "unknown";
        if (
          expected !== undefined &&
          (repeatable(step) || (expected._tag !== "Checked" && expected.durable === true))
        ) {
          const observed = yield* Effect.exit(within(check, millis));

          if (Exit.isSuccess(observed) && observed.value) return yield* receipt("verified");
        }
      }

      return yield* Effect.failCause(acted.cause);
    }
    input = "unknown";
    if (expected !== undefined && !(yield* within(check, millis)))
      return yield* new Drifted({ detail: "the step's expected effect did not arrive" });

    return yield* receipt(expected === undefined ? "taken" : "verified");
  });

  return yield* work.pipe(
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
        step: unfilled,
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
