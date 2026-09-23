import { Effect, Schema } from "effect";
import {
  BrowserActionResult,
  type BrowserNavigateRequest,
  BrowserNavigationResult,
} from "effect-agent/interactive-browser";
import type { BrowserSession } from "effect-browser/browser";
import { InputReceipt, Observation } from "effect-browser/browser-data";
import { BrowserError, Reasons } from "effect-browser/errors";

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
}

export const direct: Hooks = { run: (effect) => effect };

/** Records the original error on the host, then gives the model its compact projection. */
export const failureWith = (hooks: Hooks, call: Call) => (error: BrowserError) => {
  hooks.failure?.(error, call);

  return projectFailure(error);
};

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
export const makeOperations = <E>(
  browser: BrowserSession<E>,
  options: ResolvedOptions,
  hooks: Hooks,
  continuation: Continuation,
) => {
  const { admission } = options;

  const observe = (request: InspectionRequest) =>
    options.observe(request, browser).pipe(Effect.flatMap(decoded(Observation, "observe")));

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
      Effect.mapError(failureWith(hooks, call)),
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
      ? browser.navigate(request).pipe(
          Effect.flatMap((result) => navigationResult(result.url)),
          Effect.mapError(failureWith(hooks, call)),
        )
      : hooks.navigate(request, call);

  const action = (effect: Effect.Effect<{ readonly url: string }, BrowserError>, call: Call) =>
    effect.pipe(
      Effect.flatMap((result) => actionResult(result.url)),
      Effect.mapError(failureWith(hooks, call)),
    );

  const input = (effect: Effect.Effect<InputReceipt, BrowserError>, call: Call) =>
    effect.pipe(
      Effect.tap((receipt) => decoded(InputReceipt, "action-result")(receipt)),
      Effect.mapError(failureWith(hooks, call)),
      Effect.tap((receipt) => hooks.input?.(receipt, call) ?? Effect.void),
      Effect.as(NativeInputResult.make({ dispatched: true })),
    );

  /** A stopped form lists what it completed, and records the original stop on the host. */
  const fillForm = (request: FillFormParameters, call: Call) =>
    browser.fillForm(request, admission, options.form).pipe(
      Effect.mapError((error) => stopped(failureWith(hooks, call)(error), [])),
      Effect.flatMap((result) => {
        const completed = result.fields.map(({ elementId, status }) => ({ elementId, status }));

        if (result.stopped === undefined)
          return decoded(
            FormFillResult,
            "fill-form",
          )({ fields: completed, submitted: result.submitted, url: result.url }).pipe(
            Effect.mapError((error) => stopped(failureWith(hooks, call)(error), completed)),
          );
        const { stage, elementId, error } = result.stopped;
        const projected = failureWith(hooks, call)(error);

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

      const unavailable = (error: BrowserError) => {
        const { reason, outcome } = failureWith(hooks, call)(error);

        return {
          action: result,
          observation: { _tag: "Unavailable" as const, failure: { reason, outcome } },
        };
      };

      if (observed._tag === "Failure") return unavailable(observed.failure);

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
    ) => action(browser.clickElement(reference, admission), call),
    fill: (
      request: {
        readonly reference: { readonly observationId: string; readonly elementId: string };
        readonly value: string;
      },
      call: Call,
    ) => action(browser.fillElement(request.reference, request.value, admission), call),
    scroll: (request: { readonly deltaX: number; readonly deltaY: number }, call: Call) =>
      action(browser.scroll(request), call),
    selectOption: (
      request: {
        readonly reference: { readonly observationId: string; readonly elementId: string };
        readonly options: ReadonlyArray<string>;
      },
      call: Call,
    ) => action(browser.selectOption(request.reference, request.options, admission), call),
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

/** Every maintained handler Layer over one browser, one resolved configuration and one host. */
export const makeLayers = <E>(
  browser: BrowserSession<E>,
  options: ResolvedOptions,
  hooks: Hooks,
  continuation: Continuation,
) => {
  const operations = makeOperations(browser, options, hooks, continuation);
  const { input, followed, sizes } = operations;

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
        hooks.run(input(browser.pointerMove(request), call("browser_pointer_move", context))),
      browser_hover: (reference, context) =>
        hooks.run(
          input(browser.hoverElement(reference, options.admission), call("browser_hover", context)),
        ),
      browser_wheel: (request, context) =>
        hooks.run(input(browser.wheel(request), call("browser_wheel", context))),
    }),
    keyboardHandlers: keyboardToolkit.toLayer({
      browser_press: ({ reference, key, modifiers }, context) =>
        hooks.run(
          input(
            browser.pressElement(
              reference,
              modifiers === undefined ? { key } : { key, modifiers },
              options.admission,
            ),
            call("browser_press", context),
          ),
        ),
      browser_type: ({ reference, text }, context) =>
        hooks.run(
          input(
            browser.typeElement(reference, text, options.admission),
            call("browser_type", context),
          ),
        ),
    }),
    selectionHandlers: selectionToolkit.toLayer({
      browser_select_option: (request, context) =>
        hooks.run(operations.selectOption(request, call("browser_select_option", context))),
    }),
    waitHandlers: waitToolkit.toLayer({
      browser_wait_for: (request, context) =>
        hooks.run(
          browser
            .waitForElement(request)
            .pipe(
              Effect.as({ satisfied: true as const }),
              Effect.mapError(failureWith(hooks, call("browser_wait_for", context))),
            ),
        ),
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

        return hooks.run(
          followed(input(browser.pointerMove(request), current), current, sizes.input),
        );
      },
      browser_hover_and_inspect: (reference, context) => {
        const current = call("browser_hover_and_inspect", context);

        return hooks.run(
          followed(
            input(browser.hoverElement(reference, options.admission), current),
            current,
            sizes.input,
          ),
        );
      },
      browser_wheel_and_inspect: (request, context) => {
        const current = call("browser_wheel_and_inspect", context);

        return hooks.run(followed(input(browser.wheel(request), current), current, sizes.input));
      },
      browser_press_and_inspect: ({ reference, key, modifiers }, context) => {
        const current = call("browser_press_and_inspect", context);

        return hooks.run(
          followed(
            input(
              browser.pressElement(
                reference,
                modifiers === undefined ? { key } : { key, modifiers },
                options.admission,
              ),
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
          followed(
            input(browser.typeElement(reference, text, options.admission), current),
            current,
            sizes.input,
          ),
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
