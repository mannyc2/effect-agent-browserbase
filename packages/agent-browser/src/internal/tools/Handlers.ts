import { Effect, Schema, type Scope } from "effect";
import {
  BrowserActionResult,
  type BrowserNavigateRequest,
  BrowserNavigationResult,
} from "effect-agent/interactive-browser";
import type { Frame, Page } from "effect-browser/browser";
import {
  ActionResult,
  FillFormResult,
  InputReceipt,
  Observation,
  type KeyStroke,
  type ObservedElement,
} from "effect-browser/browser-data";
import { BrowserError, Reasons } from "effect-browser/errors";
import type { RunOperation, StepFailed } from "effect-browser/plan";
import type { Action, InputBindings, RunReceipt } from "effect-browser/plan-data";

import {
  allObservedTools,
  formToolkit,
  keyboardToolkit,
  nativeToolkit,
  readingToolkit,
  selectionToolkit,
  toolkit,
  waitToolkit,
} from "./Definitions.ts";
import {
  BrowserFormFailure,
  type BrowserToolFailure,
  type FillFormParameters,
  formInputs,
  type FollowUpObservation,
  FormFillResult,
  type InspectRequest,
  NativeInputResult,
  ObservedActionResult,
  ObservedFormResult,
  ObservedInputResult,
  ObservedNavigationResult,
  projectFailure,
  ReadMoreResult,
} from "./Model.ts";
import type { InspectionRequest, ResolvedOptions } from "./Options.ts";
import { type Continuation, fitObservation, measure } from "./Results.ts";

/** One Tool call as the host records it. */
export interface Call {
  readonly tool: string;
  readonly id: string | undefined;
}

/**
 * What a host adds around the maintained operations: its invocation lane, its supervised
 * navigation, its input callback and its failure record. The module-level handlers add none.
 */
export interface Hooks {
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E | BrowserToolFailure>;
  readonly navigate?: (
    request: BrowserNavigateRequest,
    call: Call,
  ) => Effect.Effect<BrowserNavigationResult, BrowserToolFailure>;
  readonly input?: (receipt: InputReceipt, call: Call) => Effect.Effect<void, BrowserToolFailure>;
  readonly failure?: (error: BrowserError, call: Call) => void;
  readonly operation?: (operation: RunOperation, call: Call) => void;
  readonly refused?: (error: StepFailed, call: Call) => void;
}

export const direct: Hooks = { run: (effect) => effect };

/**
 * Whether a refusal came from a bound Page or Frame that is no longer open. Such a target refuses
 * every later call too; a replaced document or reference on an open target stays `stale`, which a
 * fresh inspection answers.
 */
export const retiredBy =
  (target: Page | Frame) =>
  (error: BrowserError): Effect.Effect<boolean> =>
    error.reason._tag === "Stale"
      ? target.status.pipe(
          Effect.map(
            (status) =>
              status.phase === "closed" || status.phase === "closing" || status.phase === "stale",
          ),
        )
      : Effect.succeed(false);

/** Records the original error on the host, then gives the model its compact projection. */
export const failureWith =
  (hooks: Hooks, call: Call) =>
  (error: BrowserError, retired = false) => {
    hooks.failure?.(error, call);

    return projectFailure(error, retired);
  };

/** Fails with the model's projection of an error from work on `target`, recorded on the host. */
export const failureFrom =
  (hooks: Hooks, call: Call, target: Page | Frame) =>
  (error: BrowserError): Effect.Effect<never, BrowserToolFailure> =>
    retiredBy(target)(error).pipe(
      Effect.flatMap((retired) => Effect.fail(failureWith(hooks, call)(error, retired))),
    );

const malformed = (operation: BrowserError["operation"]) =>
  BrowserError.make({ operation, reason: Reasons.Malformed.make({}), outcome: "unknown" });

const decoded =
  <A>(schema: Schema.Codec<A, unknown, never, never>, operation: BrowserError["operation"]) =>
  (value: unknown) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(() => malformed(operation)));

export const actionResult = (url: string) => decoded(BrowserActionResult, "action-result")({ url });

export const navigationResult = (url: string) =>
  decoded(BrowserNavigationResult, "navigate")({ url });

const observationSize = measure(Observation);
const readMoreSize = measure(ReadMoreResult);

/** A form that did not complete, with what it completed before it stopped. */
const stopped = (
  failure: BrowserToolFailure,
  completed: ReadonlyArray<{ readonly elementId: string; readonly status: "set" | "unchanged" }>,
) => BrowserFormFailure.make({ reason: failure.reason, outcome: failure.outcome, completed });

const oversized = (maximum: number, observed: number) =>
  BrowserError.make({
    operation: "observe",
    reason: Reasons.Limit.make({ dimension: "returned-bytes", maximum, observed }),
    outcome: "undispatched",
  });

/**
 * The maintained operations, each defined once. A plain Tool runs one inside the host's lane;
 * its `_and_inspect` variant runs the same operation and then one fitted reading in that lane.
 */
export const makeOperations = (
  page: Page | Frame,
  options: ResolvedOptions,
  hooks: Hooks,
  continuation: Continuation,
) => {
  const { policy } = options;
  const failure = (call: Call) => failureFrom(hooks, call, page);
  let runs = 0n;

  /**
   * A fixed performed seed is the base of a sequence: the nth run these handlers start uses
   * `seed + n - 1`, so every call draws its own timing and the same calls reproduce it. Past the
   * largest safe integer the sequence continues from the smallest, so every seed stays valid.
   */
  const execution = (): ResolvedOptions["execution"] => {
    const { style } = options.execution;

    if (style === undefined || style === "plain" || style.seed === undefined)
      return options.execution;
    const smallest = BigInt(Number.MIN_SAFE_INTEGER);
    const span = BigInt(Number.MAX_SAFE_INTEGER) - smallest + 1n;
    const seed = Number(smallest + ((BigInt(style.seed) - smallest + runs++) % span));

    return { ...options.execution, style: { ...style, seed } };
  };

  /** One original executor owns authority, recording, attempts and interruption evidence. */
  const execute = Effect.fnUntraced(function* (
    intent: Action,
    call: Call,
    inputs: InputBindings = {},
  ): Effect.fn.Return<RunReceipt, BrowserError, Scope.Scope> {
    const operation = yield* page
      .start(
        { version: 1, steps: [{ id: call.tool, action: intent }] },
        { ...execution(), inputs, ...(policy === undefined ? {} : { policy }) },
      )
      .pipe(
        Effect.tapError((error) => Effect.sync(() => hooks.refused?.(error, call))),
        Effect.mapError((error) => error.error),
      );

    hooks.operation?.(operation, call);

    return yield* operation.completed.pipe(
      Effect.flatMap((ran) =>
        ran.steps[0] === undefined
          ? Effect.fail(malformed("run"))
          : Effect.succeed(ran.steps[0].receipt),
      ),
      Effect.catchTag("StepFailed", (error) =>
        intent._tag === "FillForm" &&
        error.attempt?.receipt !== undefined &&
        "stopped" in error.attempt.receipt
          ? Effect.succeed(error.attempt.receipt)
          : Effect.fail(error.error),
      ),
    );
  }, Effect.scoped);

  const observe = (request: InspectionRequest) =>
    options.observe(request, page).pipe(Effect.flatMap(decoded(Observation, "observe")));

  /** A reading, with the continuation read beside it; a policy that returns less reads less. */
  const reading = (choice: InspectRequest) => {
    const request: InspectionRequest = {
      scope: choice.scope ?? options.observationScope,
      ...(choice.find === undefined ? {} : { match: choice.find }),
      maxTextBytes: options.continuationBytes,
      maxControls: options.maxControls,
    };

    return observe(request).pipe(
      Effect.catchIf(
        (error) =>
          request.maxTextBytes > options.maxTextBytes &&
          error.outcome === "undispatched" &&
          error.reason._tag === "Configuration",
        () => observe({ ...request, maxTextBytes: options.maxTextBytes }),
      ),
    );
  };

  /** What the model is shown of a reading, fitted to the result bound, and remembered. */
  const shown = (observation: Observation, size: (candidate: Observation) => number) => {
    const fitted = fitObservation(observation, options.maxTextBytes, options.resultMaxBytes, size);

    if (fitted !== undefined) continuation.remember(observation, fitted.shown);

    return fitted;
  };

  const inspect = (choice: InspectRequest, call: Call) =>
    reading(choice).pipe(
      Effect.flatMap((observation) => {
        const fitted = shown(observation, observationSize);

        return fitted === undefined
          ? Effect.fail(oversized(options.resultMaxBytes, observationSize(observation)))
          : Effect.succeed(fitted.observation);
      }),
      Effect.catch(failure(call)),
    );

  const readMore = (observationId: string, call: Call) =>
    Effect.suspend(() => {
      const part = continuation.next(
        observationId,
        options.maxTextBytes,
        options.resultMaxBytes,
        readMoreSize,
      );

      return part === undefined
        ? Effect.fail(
            failureWith(
              hooks,
              call,
            )(
              BrowserError.make({
                operation: "observe",
                reason: Reasons.Stale.make({}),
                outcome: "undispatched",
              }),
            ),
          )
        : Effect.succeed(part);
    });

  const navigate = (request: BrowserNavigateRequest, call: Call) =>
    hooks.navigate === undefined
      ? execute({ _tag: "Navigate", ...request }, call).pipe(
          Effect.flatMap(decoded(ActionResult, "navigate")),
          Effect.flatMap((result) => navigationResult(result.url)),
          Effect.catch(failure(call)),
        )
      : hooks.navigate(request, call);

  const action = (intent: Action, call: Call, inputs?: InputBindings) =>
    execute(intent, call, inputs).pipe(
      Effect.flatMap(decoded(ActionResult, "action-result")),
      Effect.catch(failure(call)),
      Effect.flatMap((result) =>
        (result.input === undefined
          ? Effect.void
          : (hooks.input?.(result.input, call) ?? Effect.void)
        ).pipe(Effect.andThen(actionResult(result.url).pipe(Effect.catch(failure(call))))),
      ),
    );

  const input = (intent: Action, call: Call, inputs?: InputBindings) =>
    execute(intent, call, inputs).pipe(
      Effect.flatMap(decoded(InputReceipt, "action-result")),
      Effect.catch(failure(call)),
      Effect.tap((receipt) => hooks.input?.(receipt, call) ?? Effect.void),
      Effect.as(NativeInputResult.make({ dispatched: true })),
    );

  /** A stopped form lists what it completed, and records the original stop on the host. */
  const fillForm = (request: FillFormParameters, call: Call) =>
    execute(
      {
        _tag: "FillForm",
        fields: request.fields.map((field, index) => {
          const target = {
            _tag: "Ref" as const,
            reference: {
              observationId: request.observationId,
              elementId: field.elementId,
            },
          };

          return field.value !== undefined
            ? {
                _tag: "Value" as const,
                target,
                value: { _tag: "Input" as const, name: `field-${index}` },
              }
            : field.checked !== undefined
              ? { _tag: "Checked" as const, target, checked: field.checked }
              : {
                  _tag: "Options" as const,
                  target,
                  options: (field.options ?? []).map((elementId) => ({
                    _tag: "Ref" as const,
                    reference: { observationId: request.observationId, elementId },
                  })),
                };
        }),
        ...(request.submit === undefined
          ? {}
          : {
              submit: {
                _tag: "Ref" as const,
                reference: { observationId: request.observationId, elementId: request.submit },
              },
            }),
        options: options.form,
      },
      call,
      formInputs(request.fields),
    ).pipe(
      Effect.flatMap(decoded(FillFormResult, "fill-form")),
      Effect.catch((error) =>
        failure(call)(error).pipe(Effect.mapError((projected) => stopped(projected, []))),
      ),
      Effect.flatMap((result) =>
        result.stopped === undefined
          ? Effect.succeed({ result, retired: false })
          : retiredBy(page)(result.stopped.error).pipe(
              Effect.map((retired) => ({ result, retired })),
            ),
      ),
      Effect.flatMap(({ result, retired }) => {
        const completed = result.fields.map(({ elementId, status }) => ({ elementId, status }));

        const stoppedForm =
          result.stopped === undefined
            ? undefined
            : {
                facts: result.stopped,
                projected: failureWith(hooks, call)(result.stopped.error, retired),
              };

        return Effect.forEach(
          [
            ...result.fields.flatMap((field) => (field.input === undefined ? [] : [field.input])),
            ...(result.submitInput === undefined ? [] : [result.submitInput]),
          ],
          (receipt) => hooks.input?.(receipt, call) ?? Effect.void,
          { discard: true },
        ).pipe(
          Effect.mapError((callbackFailure) => {
            const projected = stoppedForm?.projected ?? callbackFailure;

            return BrowserFormFailure.make({
              reason: projected.reason,
              outcome: projected.outcome,
              ...(stoppedForm === undefined
                ? {}
                : {
                    stage: stoppedForm.facts.stage,
                    ...(stoppedForm.facts.elementId === undefined
                      ? {}
                      : { elementId: stoppedForm.facts.elementId }),
                  }),
              completed,
            });
          }),
          Effect.andThen(Effect.succeed({ result, completed, stoppedForm })),
        );
      }),
      Effect.flatMap(({ result, completed, stoppedForm }) => {
        if (stoppedForm === undefined)
          return decoded(
            FormFillResult,
            "fill-form",
          )({ fields: completed, submitted: result.submitted, url: result.url }).pipe(
            Effect.mapError((error) => stopped(failureWith(hooks, call)(error), completed)),
          );
        const { facts, projected } = stoppedForm;
        const { stage, elementId } = facts;

        return Effect.fail(
          BrowserFormFailure.make({
            reason: projected.reason,
            outcome: projected.outcome,
            stage,
            ...(elementId === undefined ? {} : { elementId }),
            completed,
          }),
        );
      }),
    );

  /**
   * The operation, then one reading fitted beside its result. The reading is separate evidence:
   * its failure never turns a successful action into a failed or undispatched one.
   */
  const followed = <A, F>(
    effect: Effect.Effect<A, F>,
    call: Call,
    size: (result: { readonly action: A; readonly observation: FollowUpObservation }) => number,
  ) =>
    Effect.gen(function* () {
      const result = yield* effect;
      const observed = yield* Effect.result(reading({}));

      const unavailable = (error: BrowserError, retired = false) => {
        const { reason, outcome } = failureWith(hooks, call)(error, retired);

        return {
          action: result,
          observation: { _tag: "Unavailable" as const, failure: { reason, outcome } },
        };
      };

      if (observed._tag === "Failure")
        return unavailable(observed.failure, yield* retiredBy(page)(observed.failure));

      const available = (observation: Observation) => ({
        action: result,
        observation: { _tag: "Available" as const, observation },
      });

      const fitted = shown(observed.success, (candidate) => size(available(candidate)));

      return fitted === undefined
        ? unavailable(oversized(options.resultMaxBytes, size(available(observed.success))))
        : available(fitted.observation);
    });

  return {
    navigate,
    inspect,
    readMore,
    click: (
      reference: { readonly observationId: string; readonly elementId: string },
      call: Call,
    ) => action({ _tag: "Click", target: { _tag: "Ref", reference } }, call),
    fill: (
      request: {
        readonly reference: { readonly observationId: string; readonly elementId: string };
        readonly value: string;
      },
      call: Call,
    ) =>
      action(
        {
          _tag: "Fill",
          target: { _tag: "Ref", reference: request.reference },
          value: { _tag: "Input", name: "value" },
        },
        call,
        { value: request.value },
      ),
    scroll: (request: { readonly deltaX: number; readonly deltaY: number }, call: Call) =>
      action({ _tag: "Scroll", mode: { _tag: "By", ...request } }, call),
    selectOption: (
      request: {
        readonly reference: { readonly observationId: string; readonly elementId: string };
        readonly options: ReadonlyArray<string>;
      },
      call: Call,
    ) =>
      action(
        {
          _tag: "Select",
          target: { _tag: "Ref", reference: request.reference },
          options: request.options.map((elementId) => ({
            _tag: "Ref",
            reference: { observationId: request.reference.observationId, elementId },
          })),
        },
        call,
      ),
    pointerMove: (request: Parameters<Frame["pointerMove"]>[0], call: Call) =>
      input({ _tag: "PointerMove", ...request }, call),
    hover: (reference: ObservedElement, call: Call) =>
      input({ _tag: "Hover", target: { _tag: "Ref", reference } }, call),
    wheel: (request: Parameters<Frame["wheel"]>[0], call: Call) =>
      input({ _tag: "Wheel", ...request }, call),
    press: (request: KeyStroke & { readonly reference: ObservedElement }, call: Call) => {
      const { reference, ...stroke } = request;

      return input({ _tag: "Press", target: { _tag: "Ref", reference }, ...stroke }, call);
    },
    type: (request: { readonly reference: ObservedElement; readonly text: string }, call: Call) =>
      input(
        {
          _tag: "Type",
          target: { _tag: "Ref", reference: request.reference },
          text: { _tag: "Input", name: "text" },
        },
        call,
        { text: request.text },
      ),
    wait: (request: Parameters<Frame["waitForElement"]>[0], call: Call) =>
      execute(
        {
          _tag: "Wait",
          mode: {
            _tag: "Element",
            target: { _tag: "Ref", reference: request.reference },
            state: request.state,
            ...(request.timeoutMillis === undefined
              ? {}
              : { timeoutMillis: request.timeoutMillis }),
          },
        },
        call,
      ).pipe(Effect.as({ satisfied: true as const }), Effect.catch(failure(call))),
    fillForm,
    input,
    followed,
    sizes: {
      action: measure(ObservedActionResult),
      navigation: measure(ObservedNavigationResult),
      input: measure(ObservedInputResult),
      form: measure(ObservedFormResult),
    },
  };
};

/** Every maintained handler Layer over one bound target, one resolved configuration and one host. */
export const makeLayers = (
  page: Page | Frame,
  options: ResolvedOptions,
  hooks: Hooks,
  continuation: Continuation,
) => {
  const operations = makeOperations(page, options, hooks, continuation);
  const { followed, sizes } = operations;

  const call = (tool: string, context: { readonly toolCallId?: string | undefined }): Call => ({
    tool,
    id: context.toolCallId,
  });

  /** The lane refuses in the common vocabulary; a form states that it completed nothing. */
  const form = <A>(effect: Effect.Effect<A, BrowserFormFailure | BrowserToolFailure>) =>
    effect.pipe(
      Effect.catchTag("BrowserToolFailure", ({ reason, outcome }) =>
        Effect.fail(BrowserFormFailure.make({ reason, outcome, completed: [] })),
      ),
    );

  return {
    handlers: toolkit.toLayer({
      browser_navigate: (request, context) =>
        hooks.run(operations.navigate(request, call("browser_navigate", context))),
      browser_inspect: (request, context) =>
        hooks.run(operations.inspect(request, call("browser_inspect", context))),
      browser_click: (reference, context) =>
        hooks.run(operations.click(reference, call("browser_click", context))),
      browser_fill: (request, context) =>
        hooks.run(operations.fill(request, call("browser_fill", context))),
      browser_scroll: (request, context) =>
        hooks.run(operations.scroll(request, call("browser_scroll", context))),
    }),
    readingHandlers: readingToolkit.toLayer({
      browser_read_more: ({ observationId }, context) =>
        hooks.run(operations.readMore(observationId, call("browser_read_more", context))),
    }),
    nativeHandlers: nativeToolkit.toLayer({
      browser_pointer_move: (request, context) =>
        hooks.run(operations.pointerMove(request, call("browser_pointer_move", context))),
      browser_hover: (reference, context) =>
        hooks.run(operations.hover(reference, call("browser_hover", context))),
      browser_wheel: (request, context) =>
        hooks.run(operations.wheel(request, call("browser_wheel", context))),
    }),
    keyboardHandlers: keyboardToolkit.toLayer({
      browser_press: ({ reference, key, modifiers }, context) =>
        hooks.run(
          operations.press(
            { reference, key, ...(modifiers === undefined ? {} : { modifiers }) },
            call("browser_press", context),
          ),
        ),
      browser_type: ({ reference, text }, context) =>
        hooks.run(operations.type({ reference, text }, call("browser_type", context))),
    }),
    selectionHandlers: selectionToolkit.toLayer({
      browser_select_option: (request, context) =>
        hooks.run(operations.selectOption(request, call("browser_select_option", context))),
    }),
    waitHandlers: waitToolkit.toLayer({
      browser_wait_for: (request, context) =>
        hooks.run(operations.wait(request, call("browser_wait_for", context))),
    }),
    formHandlers: formToolkit.toLayer({
      browser_fill_form: (request, context) =>
        form(hooks.run(operations.fillForm(request, call("browser_fill_form", context)))),
    }),
    observedHandlers: allObservedTools.toLayer({
      browser_inspect: (request, context) =>
        hooks.run(operations.inspect(request, call("browser_inspect", context))),
      browser_navigate_and_inspect: (request, context) => {
        const current = call("browser_navigate_and_inspect", context);

        return hooks.run(
          followed(operations.navigate(request, current), current, sizes.navigation),
        );
      },
      browser_click_and_inspect: (reference, context) => {
        const current = call("browser_click_and_inspect", context);

        return hooks.run(followed(operations.click(reference, current), current, sizes.action));
      },
      browser_fill_and_inspect: (request, context) => {
        const current = call("browser_fill_and_inspect", context);

        return hooks.run(followed(operations.fill(request, current), current, sizes.action));
      },
      browser_scroll_and_inspect: (request, context) => {
        const current = call("browser_scroll_and_inspect", context);

        return hooks.run(followed(operations.scroll(request, current), current, sizes.action));
      },
      browser_select_option_and_inspect: (request, context) => {
        const current = call("browser_select_option_and_inspect", context);

        return hooks.run(
          followed(operations.selectOption(request, current), current, sizes.action),
        );
      },
      browser_pointer_move_and_inspect: (request, context) => {
        const current = call("browser_pointer_move_and_inspect", context);

        return hooks.run(followed(operations.pointerMove(request, current), current, sizes.input));
      },
      browser_hover_and_inspect: (reference, context) => {
        const current = call("browser_hover_and_inspect", context);

        return hooks.run(followed(operations.hover(reference, current), current, sizes.input));
      },
      browser_wheel_and_inspect: (request, context) => {
        const current = call("browser_wheel_and_inspect", context);

        return hooks.run(followed(operations.wheel(request, current), current, sizes.input));
      },
      browser_press_and_inspect: ({ reference, key, modifiers }, context) => {
        const current = call("browser_press_and_inspect", context);

        return hooks.run(
          followed(
            operations.press(
              { reference, key, ...(modifiers === undefined ? {} : { modifiers }) },
              current,
            ),
            current,
            sizes.input,
          ),
        );
      },
      browser_type_and_inspect: ({ reference, text }, context) => {
        const current = call("browser_type_and_inspect", context);

        return hooks.run(
          followed(operations.type({ reference, text }, current), current, sizes.input),
        );
      },
      browser_fill_form_and_inspect: (request, context) => {
        const current = call("browser_fill_form_and_inspect", context);

        return form(
          hooks.run(followed(operations.fillForm(request, current), current, sizes.form)),
        );
      },
    }),
  };
};
