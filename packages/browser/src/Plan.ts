/**
 * A walk recorded once from a page's events and replayed later, on a fresh page, with no model
 * call.
 *
 * `fromEvents` keeps one page's completed actions with their subjects and the options they were
 * given, its navigations with both the address asked for and the one reached, and what was typed
 * as a named input slot, never the text itself. `replay` takes the steps in turn. Before a step
 * that acts on the page, it waits for `Page.ready`; then it finds the one element the step's
 * subject names, by role, name and context, and acts on it. An element step never falls back to
 * coordinates, and a step recorded at a point acts there only while the element found for it still
 * covers that point. Replay stops at the first step it cannot take and says why: `Missing`,
 * `Ambiguous`, `Drifted`, or the step's own `BrowserError`. Nothing is replayed automatically, and
 * a plan of another version, such as one 0.2 stored, does not decode.
 *
 * @since 0.3.0
 */
import { Duration, Effect, Schedule, Schema } from "effect";

import { BrowserError, InvalidRequest } from "./BrowserError.ts";
import {
  type Action,
  ActionOptions,
  Box,
  type BrowserEvent,
  type Navigated,
  Subject,
} from "./BrowserEvent.ts";
import { Ambiguous, choose, Drifted, Missing } from "./internal/reading/choose.ts";
import type { Found, Page, Point, ReadyOptions, Target } from "./Page.ts";

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
  /** The input slot whose text a `type` step types. */
  input: Schema.optional(Schema.String),
  options: Schema.optional(ActionOptions),
}) {}

export class Plan extends Schema.Class<Plan>("effect-browser/Plan")({
  version: Schema.Literal(1),
  steps: Schema.Array(Step),
}) {
  /** The input slots its steps type, in order; replay needs text for each. */
  get inputs(): ReadonlyArray<string> {
    return this.steps.flatMap((step) => (step.input === undefined ? [] : [step.input]));
  }
}

/** Where replay stopped, counting steps from 0, and why. */
export class ReplayError extends Schema.TaggedError<ReplayError>()("ReplayError", {
  step: Schema.Int,
  reason: Schema.Union([Missing, Ambiguous, Drifted, BrowserError]),
}) {
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
        url: before(steps[index + 1]?.startedAt ?? Number.POSITIVE_INFINITY),
        target: action.name === "navigate" || action.name === "press" ? action.target : undefined,
        subject: action.subject,
        to: action.to,
        point,
        toPoint: pointIn(drag?.[1]),
        box: point === undefined ? undefined : action.box,
        input: action.name === "type" ? slotFor(taken, action.subject?.name) : undefined,
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

const invalid = (detail: string) =>
  new BrowserError({
    operation: "replay",
    reason: new InvalidRequest({ detail }),
    dispatched: false,
  });

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

const take = (
  page: Page,
  step: Step,
  text: string,
): Effect.Effect<void, Missing | Ambiguous | Drifted | BrowserError> => {
  const options = step.options ?? {};

  switch (step.action) {
    case "navigate":
      return page.goto(step.target ?? step.url);
    case "back":
      return page.back;
    case "reload":
      return page.reload;
    case "press":
      return page.press(step.target ?? "", options);
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
        ? page.type(text, options)
        : Effect.flatMap(aim(page, step.subject), (into) =>
            page.type(text, { ...options, into: typeof into === "string" ? into : undefined }),
          );
  }
};

export interface ReplayOptions {
  /** How each step waits for the page first, as `Page.ready` takes it, or false not to wait. */
  readonly settle?: ReadyOptions | false | undefined;
  /** The text for each of the plan's input slots. */
  readonly inputs?: Readonly<Record<string, string>> | undefined;
}

/** Take a plan's steps on a page, in order, stopping at the first that cannot be taken. */
export const replay = (page: Page, plan: Plan, options: ReplayOptions = {}) =>
  Effect.gen(function* () {
    const inputs = options.inputs ?? {};
    const settle = options.settle === false ? Effect.void : page.ready(options.settle);

    const at =
      (step: number) =>
      <A>(effect: Effect.Effect<A, Missing | Ambiguous | Drifted | BrowserError>) =>
        effect.pipe(Effect.mapError((reason) => new ReplayError({ step, reason })));

    // A step arrived where the recording did, on the same site; a moved path is not drift.
    const arrived = (index: number) => {
      const recorded = plan.steps[index]?.url ?? "";

      return page.url.pipe(
        Effect.flatMap((url) =>
          recorded === "" || URL.parse(url)?.origin === URL.parse(recorded)?.origin
            ? Effect.void
            : Effect.fail(
                new Drifted({ detail: `the page is at ${url}, not on ${recorded}'s site` }),
              ),
        ),
        at(index),
      );
    };

    const unfilled = plan.steps.findIndex(
      (step) => step.input !== undefined && inputs[step.input] === undefined,
    );

    if (unfilled !== -1)
      return yield* at(unfilled)(
        Effect.fail(invalid(`no text for the input "${plan.steps[unfilled]?.input ?? ""}"`)),
      );
    for (const [index, step] of plan.steps.entries()) {
      if (step.action !== "navigate" && step.action !== "back" && step.action !== "reload")
        yield* at(index)(settle);
      if (index > 0) yield* arrived(index - 1);
      yield* at(index)(
        take(page, step, step.input === undefined ? "" : (inputs[step.input] ?? "")),
      );
    }
    if (plan.steps.length > 0) {
      yield* at(plan.steps.length - 1)(settle);
      yield* arrived(plan.steps.length - 1);
    }
  }).pipe(Effect.withSpan("Plan.replay", { attributes: { steps: plan.steps.length } }));
