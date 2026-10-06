import { Effect, Schema, Semaphore } from "effect";
import {
  Action,
  ActionResult,
  BrowserActions,
  BrowserUseError,
  Observation as ModelObservation,
} from "effect-agent/browser-use";
import type { Frame, Page } from "effect-browser/browser";
import type { Observation, ObservedControl } from "effect-browser/browser-data";

import { type Call, failureFrom, type Hooks, makeOperations } from "./tools/Handlers.ts";
import type { BrowserFormFailure, BrowserToolFailure, FillFormParameters } from "./tools/Model.ts";
import type { ResolvedOptions } from "./tools/Options.ts";
import { boundary, continuationFor, largest, measure, prefixWithin } from "./tools/Results.ts";

type Failure = Pick<BrowserToolFailure, "reason" | "outcome">;

/** One option of a select, as the model names it and as the browser issued it. */
interface Choice {
  readonly label: string;
  readonly elementId: string;
}

/** One control the model was shown, and the issued element it names. */
interface Issued {
  readonly elementId: string;
  readonly kind: string;
  /** The select's enabled options, in the order observed. */
  readonly options: ReadonlyArray<Choice>;
}

/** The only observation whose refs actions may name. Every dispatch retires it. */
interface Latest {
  readonly generation: number;
  readonly observationId: string;
  readonly controls: ReadonlyMap<string, Issued>;
}

/** A ref names its observation and the control's position in it, so an older one never resolves. */
const ref = (generation: number, index: number) => `o${generation}-e${index}`;

/**
 * The last observation generation issued over each borrowed session, whichever `BrowserActions`
 * issued it. A Layer built again over the same session, as one per `AgentRuntime.run` on a thread
 * that persists, continues the count, so a ref an earlier instance showed the model never names a
 * control of a later one, on that page or any other the session issued.
 */
const generations = new WeakMap<object, number>();

const nextGeneration = (session: object): number => {
  const generation = (generations.get(session) ?? 0) + 1;

  generations.set(session, generation);

  return generation;
};

const issuedRef = /^o([1-9][0-9]*)-e(?:0|[1-9][0-9]*)$/;

const buttonInputs: ReadonlySet<string> = new Set(["submit", "button", "reset", "image"]);

/** Effect Agent's control vocabulary, with checkboxes and radios named for what they are. */
const kindOf = (control: ObservedControl): string =>
  control.kind !== "input"
    ? control.kind
    : control.inputType === "checkbox" || control.inputType === "radio"
      ? control.inputType
      : control.inputType !== undefined && buttonInputs.has(control.inputType)
        ? "button"
        : "input";

/** Controls that may take text; the browser still refuses one that cannot. */
const fillable: ReadonlySet<string> = new Set(["input", "textarea", "other"]);

/** The most controls one effect-browser reading issues; every reading asks for all of them. */
const readingControls = 64;

/** One control the model may be shown, and what its ref resolves to. */
interface Entry {
  readonly shown: (typeof ModelObservation.Type)["controls"][number];
  readonly issued: Issued;
}

/** A reading projected for the model, before it is fitted to the result bound. */
interface Projected {
  readonly generation: number;
  readonly observationId: string;
  readonly text: string;
  readonly textTruncated: boolean;
  readonly entries: ReadonlyArray<Entry>;
  readonly controlsTruncated: boolean;
}

/**
 * The model's observation: enabled controls only, each select with its enabled options' labels,
 * in document order until `maxControls` of them, options included, are shown, and at most
 * `maxTextBytes` of its text. Disabled controls and options are dropped first, so they never spend
 * that budget. effect-browser never reads a field's value, so a text field's `value` is always
 * empty; a select's is its selected options' labels and a toggle's says whether it is checked.
 */
const project = (
  observation: Observation,
  generation: number,
  maxControls: number,
  maxTextBytes: number,
): Projected => {
  const choices = new Map<
    string,
    Array<{ readonly control: ObservedControl; readonly label: string }>
  >();

  for (const control of observation.controls) {
    if (control.selectElementId === undefined) continue;
    const list = choices.get(control.selectElementId) ?? [];

    list.push({ control, label: control.label });
    choices.set(control.selectElementId, list);
  }
  const entries: Array<Entry> = [];
  let budget = maxControls;
  let truncated = observation.controlsTruncated;

  for (const [index, control] of observation.controls.entries()) {
    if (control.disabled || control.selectElementId !== undefined) continue;
    if (budget < 1) {
      truncated = true;
      break;
    }
    const kind = kindOf(control);
    const all = control.kind === "select" ? (choices.get(control.elementId) ?? []) : [];
    const enabled = all.filter((choice) => !choice.control.disabled);

    // A select keeps the options that still fit; a value naming another one is refused.
    const options = enabled
      .slice(0, budget - 1)
      .map((choice) => ({ label: choice.label, elementId: choice.control.elementId }));

    budget -= 1 + options.length;
    if (options.length < enabled.length || control.optionsTruncated === true) truncated = true;

    const value =
      control.kind === "select"
        ? all
            .filter((choice) => choice.control.selected === true)
            .map((choice) => choice.label)
            .join(", ")
        : control.checked === undefined
          ? ""
          : control.checked
            ? "checked"
            : "unchecked";

    const name = ref(generation, index);

    entries.push({
      shown: {
        ref: name,
        kind,
        name: control.label,
        value,
        options: options.map((option) => option.label),
      },
      issued: { elementId: control.elementId, kind, options },
    });
  }

  // A host's own `observe` may return more text than it was asked for; the model never sees it.
  const text = prefixWithin(observation.text, maxTextBytes);

  return {
    generation,
    observationId: observation.observationId,
    text,
    textTruncated: observation.textTruncated || text.length < observation.text.length,
    entries,
    controlsTruncated: truncated,
  };
};

/**
 * The projection within the result bound, as the Tools fit theirs: text first, then trailing
 * controls, and a note for what was left out. Only the refs it shows resolve. `size` measures
 * the whole result that carries it.
 */
const fit = (
  projected: Projected,
  maxBytes: number,
  size: (observation: typeof ModelObservation.Type) => number,
): { readonly latest: Latest; readonly shown: typeof ModelObservation.Type } => {
  const { text, entries } = projected;

  const shape = (length: number, count: number): typeof ModelObservation.Type => ({
    text: [
      text.slice(0, length),
      ...(projected.textTruncated || length < text.length
        ? ["[Some page text was left out of this observation.]"]
        : []),
      ...(projected.controlsTruncated || count < entries.length
        ? ["[Some controls were left out of this observation.]"]
        : []),
    ]
      .filter((line) => line.length > 0)
      .join("\n"),
    controls: entries.slice(0, count).map((entry) => entry.shown),
  });

  const fits = (length: number, count: number) => size(shape(length, count)) <= maxBytes;

  const [length, count] = fits(text.length, entries.length)
    ? [text.length, entries.length]
    : fits(0, entries.length)
      ? [
          boundary(
            text,
            largest(text.length, (n) => fits(boundary(text, n), entries.length)),
          ),
          entries.length,
        ]
      : [0, largest(entries.length, (n) => fits(0, n))];

  return {
    latest: {
      generation: projected.generation,
      observationId: projected.observationId,
      controls: new Map(entries.slice(0, count).map((entry) => [entry.shown.ref, entry.issued])),
    },
    shown: shape(length, count),
  };
};

const outcomes = {
  undispatched: "Nothing was sent.",
  rejected: "Its input was not sent, though preparation such as scrolling or focus may have run.",
  performed: "Its input was sent before a later step failed: never repeat it.",
  unknown: "It may have happened: observe before anything else, and never repeat it blindly.",
} as const satisfies Record<Failure["outcome"], string>;

/**
 * Fixed sentences over the projected reason and outcome of work on the bound target; nothing
 * native reaches the model. There, `closed` means that target is gone for good.
 */
const described = (what: string, failure: Failure, then: string = outcomes[failure.outcome]) =>
  [
    `${what} failed (${failure.reason}, ${failure.outcome}).`,
    then,
    ...(failure.reason === "closed" ? ["The page is gone: stop using the browser."] : []),
  ]
    .filter((part) => part.length > 0)
    .join(" ");

/**
 * A host that is busy, closed or failed refused the call before it ran, so nothing was sent. A
 * closed or failed host refuses every later call too, but says nothing about the page itself.
 */
const unavailable = (failure: BrowserToolFailure) =>
  new BrowserUseError({
    code: "browser",
    message: `The browser host did not run this call (${failure.reason}, ${failure.outcome}). Nothing was sent.${
      failure.reason === "closed" || failure.reason === "failed"
        ? " These browser tools are no longer available."
        : ""
    }`,
  });

const invalid = (message: string) => new BrowserUseError({ code: "invalid", message });

const batchRule =
  "A batch here is one form: fills and selects on distinct controls of the latest observation, optionally followed by one final click. Nothing was sent; send other actions one at a time.";

/** One validated action on the issued element its ref names; a select names its one option. */
type Step = { readonly ref: string; readonly elementId: string } & (
  | { readonly kind: "click" }
  | { readonly kind: "fill"; readonly value: string }
  | { readonly kind: "select"; readonly option: string }
);

const Actions = Schema.Array(Action).check(Schema.isMinLength(1), Schema.isMaxLength(8));

/** Resolves and checks every action against the latest observation before anything is sent. */
const validate = (
  latest: Latest | undefined,
  actions: ReadonlyArray<Action>,
): Effect.Effect<
  { readonly latest: Latest; readonly steps: ReadonlyArray<Step> },
  BrowserUseError
> =>
  Effect.gen(function* () {
    if (latest === undefined)
      return yield* invalid(
        "There is no current observation. Nothing was sent; call observe, then act on a ref it lists.",
      );
    const steps: Array<Step> = [];

    for (const action of actions) {
      const control = latest.controls.get(action.ref);

      if (control === undefined) {
        const generation = issuedRef.exec(action.ref)?.[1];

        return yield* invalid(
          generation !== undefined && Number(generation) < latest.generation
            ? `Ref ${action.ref} is from an earlier observation. Nothing was sent; act only on refs from the latest observation.`
            : `Ref ${action.ref} is not in the latest observation. Nothing was sent; act only on refs it lists.`,
        );
      }
      if (action.kind === "click") {
        if (control.kind === "select")
          return yield* invalid(
            `Ref ${action.ref} is a select. Nothing was sent; choose one of its options with select.`,
          );
        steps.push({ kind: "click", ref: action.ref, elementId: control.elementId });
      } else if (action.kind === "fill") {
        if (!fillable.has(control.kind))
          return yield* invalid(
            `Ref ${action.ref} is a ${control.kind}. Nothing was sent; fill takes an input or a textarea.`,
          );
        steps.push({
          kind: "fill",
          ref: action.ref,
          elementId: control.elementId,
          value: action.value,
        });
      } else {
        if (control.kind !== "select")
          return yield* invalid(
            `Ref ${action.ref} is a ${control.kind}, not a select. Nothing was sent.`,
          );
        const matches = control.options.filter((option) => option.label === action.value);
        const [option] = matches;

        if (option === undefined || matches.length > 1)
          return yield* invalid(
            matches.length > 1
              ? `Several options of ${action.ref} are labelled “${action.value}”, so none can be chosen by that label. Nothing was sent.`
              : `No observed option of ${action.ref} is labelled “${action.value}”. Nothing was sent; choose one of its options.`,
          );
        steps.push({
          kind: "select",
          ref: action.ref,
          elementId: control.elementId,
          option: option.elementId,
        });
      }
    }
    if (steps.length > 1) {
      const clicks = steps.filter((step) => step.kind === "click").length;
      const elements = new Set(steps.map((step) => step.elementId));

      if (clicks > (steps.at(-1)?.kind === "click" ? 1 : 0) || elements.size !== steps.length)
        return yield* invalid(batchRule);
    }

    return { latest, steps };
  });

/** What dispatch acknowledged, and the model's account of where it stopped. */
interface Dispatched {
  readonly completed: number;
  readonly error: string | null;
}

/**
 * `BrowserActions` over one issued Page or Frame and the maintained operations: the same exact
 * references, policy, execution, receipts and failure record as this package's Tools. Calls are
 * serialized, and each runs whole inside the host's lane, so no other Tool call can retire the
 * observation between an action and the reading after it.
 */
export const makeActions = Effect.fnUntraced(function* (
  session: object,
  page: Page | Frame,
  options: ResolvedOptions,
  hooks: Hooks,
) {
  const operations = makeOperations(page, options, hooks, continuationFor(page));
  const permit = yield* Semaphore.make(1);
  let latest: Latest | undefined;

  const call = (tool: "observe" | "act"): Call => ({ tool, id: undefined });

  const observationSize = measure(ModelObservation);
  const resultSize = measure(ActionResult);

  /**
   * A fresh reading, fitted within the result that carries it, replaces the latest observation;
   * a failed one leaves none.
   */
  const read = (current: Call, size: (observation: typeof ModelObservation.Type) => number) =>
    Effect.suspend(() => {
      latest = undefined;

      return operations
        .observe({
          scope: options.observationScope,
          maxTextBytes: options.maxTextBytes,
          maxControls: readingControls,
        })
        .pipe(
          Effect.catch(failureFrom(hooks, current, page)),
          Effect.map((observation) => {
            const fitted = fit(
              project(
                observation,
                nextGeneration(session),
                options.maxControls,
                options.maxTextBytes,
              ),
              options.resultMaxBytes,
              size,
            );

            latest = fitted.latest;

            return fitted.shown;
          }),
        );
    });

  const single = (step: Step, observationId: string, current: Call) => {
    const reference = { observationId, elementId: step.elementId };

    const dispatched =
      step.kind === "click"
        ? operations.click(reference, current)
        : step.kind === "fill"
          ? operations.fill({ reference, value: step.value }, current)
          : operations.selectOption({ reference, options: [step.option] }, current);

    return dispatched.pipe(
      Effect.as<Dispatched>({ completed: 1, error: null }),
      Effect.catch((failure) =>
        Effect.succeed<Dispatched>({
          completed: failure.outcome === "performed" ? 1 : 0,
          error: described(`${step.kind} on ${step.ref}`, failure),
        }),
      ),
    );
  };

  /** Fills and selects, then at most one click, as one form the browser keeps its references for. */
  const form = (steps: ReadonlyArray<Step>, observationId: string, current: Call) => {
    const last = steps.at(-1);
    const submit = last?.kind === "click" ? last : undefined;
    const fields = submit === undefined ? steps : steps.slice(0, -1);
    const byElement = new Map(steps.map((step) => [step.elementId, step]));

    const request: FillFormParameters = {
      observationId,
      fields: fields.flatMap((step): FillFormParameters["fields"] =>
        step.kind === "fill"
          ? [{ elementId: step.elementId, value: step.value }]
          : step.kind === "select"
            ? [{ elementId: step.elementId, options: [step.option] }]
            : [],
      ),
      ...(submit === undefined ? {} : { submit: submit.elementId }),
    };

    const at = (elementId: string | undefined) => {
      const step = elementId === undefined ? undefined : byElement.get(elementId);

      return step === undefined ? "The form" : `${step.kind} on ${step.ref}`;
    };

    /** Acknowledged actions: those the form completed, and a stopped step whose input was sent. */
    const stopped = (failure: BrowserFormFailure): Dispatched => {
      const done = failure.completed.length;
      const sent = failure.outcome === "performed" ? 1 : 0;

      if (failure.stage === undefined)
        // A form that completed nothing failed as its first step did. One that completed its
        // fields failed after it ran, in a host callback (`performed`, so its click, if any, was
        // sent too) or reading its result (`unknown`, so its click may have been).
        return done === 0
          ? { completed: sent, error: described(at(fields[0]?.elementId), failure) }
          : {
              completed: done + (submit === undefined ? 0 : sent),
              error: described("Completing the form", failure),
            };
      // Verification runs once every field is filled, and only reads them back.
      if (failure.stage === "verify")
        return {
          completed: done,
          error: `${described(
            "Checking the filled fields",
            failure,
            "Every field was filled: observe before filling any again.",
          )}${submit === undefined ? "" : " The click was not sent."}`,
        };

      return {
        completed:
          done +
          (failure.completed.some((field) => field.elementId === failure.elementId) ? 0 : sent),
        error: described(at(failure.elementId), failure),
      };
    };

    return operations.fillForm(request, current).pipe(
      Effect.map((result): Dispatched => ({
        completed: result.fields.length + (result.submitted ? 1 : 0),
        error: null,
      })),
      Effect.catch((failure) => Effect.succeed(stopped(failure))),
    );
  };

  const act = (actions: ReadonlyArray<Action>) =>
    Effect.gen(function* () {
      const current = call("act");

      const { latest: observed, steps } = yield* Schema.decodeEffect(Actions)(actions).pipe(
        Effect.mapError(() => invalid("Expected 1–8 actions. Nothing was sent.")),
        Effect.flatMap((decoded) => validate(latest, decoded)),
      );

      // Any dispatch retires the observation its references came from, however it ends.
      latest = undefined;

      const [first] = steps;

      const dispatched = yield* first !== undefined && steps.length === 1
        ? single(first, observed.observationId, current)
        : form(steps, observed.observationId, current);

      const after = yield* Effect.result(
        read(current, (observation) =>
          resultSize({ completed: dispatched.completed, error: dispatched.error, observation }),
        ),
      );

      const error =
        after._tag === "Success"
          ? dispatched.error
          : [
              dispatched.error,
              described(
                "The observation after acting",
                after.failure,
                "Call observe, and never repeat an acknowledged action.",
              ),
            ]
              .filter((part) => part !== null)
              .join(" ");

      return {
        completed: dispatched.completed,
        error,
        observation: after._tag === "Success" ? after.success : null,
      } satisfies typeof ActionResult.Type;
    });

  // Inside the lane, a failure is the reading's own; anything the lane itself returns is a refusal.
  const observe = read(call("observe"), observationSize).pipe(
    Effect.mapError(
      (failure) =>
        new BrowserUseError({
          code: "browser",
          message: described(
            "Observing the page",
            failure,
            failure.reason === "closed" ? "" : "Observe again before acting.",
          ),
        }),
    ),
  );

  return BrowserActions.of({
    observe: hooks
      .run(permit.withPermit(observe))
      .pipe(Effect.catchTag("BrowserToolFailure", (failure) => Effect.fail(unavailable(failure)))),
    act: (actions) =>
      hooks
        .run(permit.withPermit(act(actions)))
        .pipe(
          Effect.catchTag("BrowserToolFailure", (failure) => Effect.fail(unavailable(failure))),
        ),
  });
});
