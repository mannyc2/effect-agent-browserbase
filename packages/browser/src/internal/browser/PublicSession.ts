import { Duration, Effect, Schema } from "effect";

import type * as Bootstrap from "../../Bootstrap.ts";
import type {
  BrowserSession,
  TargetOperations,
  PinnedTarget,
  Page,
  Frame,
  PageOperations,
  OperationOptions,
} from "../../Browser.ts";
import {
  ActionResult,
  Checkpoint,
  CheckpointOptions,
  ClickRequest,
  FillFormOptions,
  FillFormRequest,
  FillFormResult,
  FillRequest,
  FrameInfo,
  HoverRequest,
  InputReceipt,
  KeyStroke,
  NavigateRequest,
  NavigationResult,
  ObservationOptions,
  ObservedElement,
  PageInfo,
  PointerMoveRequest,
  PressRequest,
  ReadTextRequest,
  ScreenshotRequest,
  ScreenshotResult,
  ScrollRequest,
  SelectOptions,
  StartNavigationRequest,
  Target,
  TextResult,
  TypeRequest,
  Viewport,
  WaitForElementRequest,
  WheelRequest,
  Identifier,
} from "../../BrowserData.ts";
import {
  BrowserError,
  Reasons,
  type BrowserOperation,
  type BrowserOutcome,
  type Containment,
  InitializationError,
} from "../../Errors.ts";
import { StepFailed, type RunOptions } from "../../Plan.ts";
import type { LivePlanEncoded, PlanEncoded } from "../../PlanData.ts";
import { associate, associatePageAuthority, forPage } from "./Association.ts";
import type { Bindings } from "./Bindings.ts";
import { OperationOptionsSchema } from "./OperationOptions.ts";
import { associatePageControl } from "./PageControlAssociation.ts";
import {
  checkedDescriptor,
  checkedLivePlan,
  checkedResolveOptions,
  checkedRunOptions,
  checkedSettled,
} from "./PlanOptions.ts";
import { schemaPath } from "./SchemaPath.ts";
import type {
  TargetControls,
  SessionControls,
  SessionLease,
  PageControls,
  FormOutcome,
} from "./Session.ts";

export const checked = <A>(
  schema: Schema.Codec<A, unknown, never, never>,
  value: unknown,
  operation: BrowserOperation,
) =>
  Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }).pipe(
    Effect.mapError((error) =>
      BrowserError.make({
        operation,
        reason: Reasons.Configuration.make(schemaPath(error)),
        outcome: "undispatched",
      }),
    ),
  );

/** Decode when the Effect executes and retain no caller-owned mutable admission data. */
export const checkedOperationOptions = (
  value: unknown,
  operation: BrowserOperation,
): Effect.Effect<OperationOptions, BrowserError> =>
  checked(OperationOptionsSchema, value === undefined ? {} : value, operation).pipe(
    Effect.map((options) =>
      Object.freeze({
        ...(options.timeoutMillis === undefined ? {} : { timeoutMillis: options.timeoutMillis }),
        ...(options.admission === undefined
          ? {}
          : {
              admission: Object.freeze(
                options.admission.queue === undefined
                  ? {}
                  : {
                      queue: Duration.toMillis(Duration.fromInputUnsafe(options.admission.queue)),
                    },
              ),
            }),
      }),
    ),
  );

const withOperationOptions = <A, E, R>(
  options: OperationOptions | undefined,
  operation: BrowserOperation,
  use: (options: OperationOptions) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | BrowserError, R> =>
  checkedOperationOptions(options, operation).pipe(Effect.flatMap(use));

export const decoded =
  <A>(
    schema: Schema.Codec<A, unknown, never, never>,
    operation: BrowserOperation,
    outcome: BrowserOutcome,
    containment?: Containment,
  ) =>
  (value: unknown) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError((error) =>
        BrowserError.make({
          operation,
          reason: Reasons.Malformed.make(schemaPath(error)),
          outcome,
          ...(containment === undefined ? {} : { containment }),
        }),
      ),
    );

const action = decoded(ActionResult, "action-result", "performed");
const pointerMoved = decoded(InputReceipt, "pointer-move", "performed");
const hovered = decoded(InputReceipt, "hover", "performed");
const wheeled = decoded(InputReceipt, "wheel", "performed");
const pressed = decoded(InputReceipt, "press", "performed");
const typed = decoded(InputReceipt, "type", "performed");

const formed = (value: FormOutcome) => {
  const stopped = value.stopped?.error;

  const outcome =
    stopped?.outcome === "unknown"
      ? "unknown"
      : value.submitted ||
          value.fields.some((field) => field.status === "set") ||
          stopped?.outcome === "performed"
        ? "performed"
        : "undispatched";

  return decoded(FillFormResult, "fill-form", outcome, stopped?.containment)(value);
};

const makeTarget = (bound: TargetControls): TargetOperations => ({
  navigate: (request, options) =>
    checked(NavigateRequest, request, "navigate").pipe(
      Effect.flatMap((value) =>
        withOperationOptions(options, "navigate", (options) =>
          bound.navigate(value.url, value.timeoutMillis, options),
        ),
      ),
      Effect.flatMap((url) => decoded(NavigationResult, "navigate", "performed")({ url })),
    ),
  startNavigation: (request, options) =>
    checked(StartNavigationRequest, request, "navigate").pipe(
      Effect.flatMap((value) =>
        withOperationOptions(options, "navigate", (options) =>
          bound.startNavigation(value.url, value.timeoutMillis, options),
        ),
      ),
      Effect.map((operation) => ({
        target: operation.target,
        completed: operation.completed.pipe(
          Effect.flatMap((url) => decoded(NavigationResult, "navigate", "performed")({ url })),
        ),
        stop: operation.stop,
      })),
    ),
  readText: (request, options) =>
    checked(ReadTextRequest, request, "read-text").pipe(
      Effect.flatMap((value) =>
        withOperationOptions(options, "read-text", (options) =>
          bound.readText(value.selector, options),
        ),
      ),
      Effect.flatMap((text) => decoded(TextResult, "read-text", "undispatched")({ text })),
    ),
  click: (request, options) =>
    checked(ClickRequest, request, "click").pipe(
      Effect.flatMap((value) =>
        withOperationOptions(options, "click", (options) =>
          bound.click(value.selector, undefined, options),
        ),
      ),
      Effect.flatMap(({ url, input }) => action({ url, input })),
    ),
  fill: (request, options) =>
    checked(FillRequest, request, "fill").pipe(
      Effect.flatMap((value) =>
        withOperationOptions(options, "fill", (options) =>
          bound.fill(value.selector, value.value, undefined, options),
        ),
      ),
      Effect.flatMap((url) => action({ url })),
    ),
  scroll: (request, options) =>
    checked(ScrollRequest, request, "scroll").pipe(
      Effect.flatMap((value) =>
        withOperationOptions(options, "scroll", (options) =>
          bound.scroll(value.deltaX, value.deltaY, options),
        ),
      ),
      Effect.flatMap((url) => action({ url })),
    ),
  pointerMove: (request, options) =>
    checked(PointerMoveRequest, request, "pointer-move").pipe(
      Effect.flatMap((value) =>
        withOperationOptions(options, "pointer-move", (options) =>
          bound.pointerMove(value.to, options),
        ),
      ),
      Effect.flatMap((input) => pointerMoved({ ...input, kind: "pointer-move" })),
    ),
  hover: (request, options) =>
    checked(HoverRequest, request, "hover").pipe(
      Effect.flatMap((value) =>
        withOperationOptions(options, "hover", (options) =>
          bound.hover(value.selector, undefined, options),
        ),
      ),
      Effect.flatMap((input) => hovered({ ...input, kind: "hover" })),
    ),
  wheel: (request, options) =>
    checked(WheelRequest, request, "wheel").pipe(
      Effect.flatMap((value) =>
        withOperationOptions(options, "wheel", (options) =>
          bound
            .wheel(value.deltaX, value.deltaY, value.at, options)
            .pipe(
              Effect.flatMap((input) =>
                wheeled({ ...input, kind: "wheel", delta: { x: value.deltaX, y: value.deltaY } }),
              ),
            ),
        ),
      ),
    ),
  press: (request, options) =>
    checked(PressRequest, request, "press").pipe(
      Effect.flatMap((value) =>
        withOperationOptions(options, "press", (options) =>
          bound.press(value.key, value.modifiers ?? [], value.into, undefined, options),
        ),
      ),
      Effect.flatMap((input) => pressed({ ...input, kind: "press" })),
    ),
  type: (request, options) =>
    checked(TypeRequest, request, "type").pipe(
      Effect.flatMap((value) =>
        withOperationOptions(options, "type", (options) =>
          bound.type(value.text, value.into, undefined, options),
        ),
      ),
      Effect.flatMap((input) => typed({ ...input, kind: "type" })),
    ),
  screenshot: (request, options) =>
    checked(ScreenshotRequest, request, "screenshot").pipe(
      Effect.flatMap((value) =>
        withOperationOptions(options, "screenshot", (options) =>
          bound.screenshot(value.fullPage, options),
        ),
      ),
      Effect.flatMap((bytes) =>
        decoded(
          ScreenshotResult,
          "screenshot",
          "undispatched",
        )({ mediaType: "image/png", bytes: new Uint8Array(bytes) }),
      ),
    ),
});

const makePinnedTarget = (value: {
  readonly target: Target;
  readonly operations: TargetControls;
}): PinnedTarget =>
  Object.freeze({
    ...makeTarget(value.operations),
    target: Object.freeze(Target.make({ ...value.target })),
  });

/** A browser-operation failure keeps its meaning when it is reported as an initialization one. */
const initialization = (reason: BrowserError["reason"]): InitializationError["reason"] =>
  reason._tag === "Busy" || reason._tag === "QueueFull"
    ? "busy"
    : reason._tag === "Closed" || reason._tag === "Disconnected"
      ? "closed"
      : reason._tag === "Timeout" || reason._tag === "QueueExpired"
        ? "timeout"
        : reason._tag === "Stale"
          ? "stale"
          : reason._tag === "Unsupported"
            ? "unsupported"
            : reason._tag === "Configuration"
              ? "configuration"
              : "native";

const makePageOperations = (controls: PageControls): PageOperations => {
  const Wait = Schema.Struct({
    selector: ClickRequest.fields.selector,
    state: Schema.Literals(["visible", "hidden", "attached", "detached"]),
  });

  const navigate = (url: string) => action({ url });

  return {
    ...makeTarget(controls.operations),
    observe: (options = {}, operationOptions) =>
      checked(ObservationOptions, options, "observe").pipe(
        Effect.flatMap((value) =>
          withOperationOptions(operationOptions, "observe", (options) =>
            controls.observe({ ...value, scope: value.scope ?? "document" }, options),
          ),
        ),
      ),
    checkpoint: (options = {}, operationOptions) =>
      checked(CheckpointOptions, options, "checkpoint").pipe(
        Effect.flatMap((value) =>
          withOperationOptions(operationOptions, "checkpoint", (options) =>
            controls.checkpoint({ ...value, picture: value.picture ?? false }, options),
          ),
        ),
        Effect.flatMap(({ picture, ...sampled }) =>
          decoded(
            Checkpoint,
            "checkpoint",
            "undispatched",
          )({
            ...sampled,
            ...(picture === undefined
              ? {}
              : { picture: { mediaType: "image/png", bytes: new Uint8Array(picture) } }),
          }),
        ),
      ),
    controlFacts: (reference, options) =>
      checked(ObservedElement, reference, "control-facts").pipe(
        Effect.flatMap((value) =>
          withOperationOptions(options, "control-facts", (options) =>
            controls.controlFacts(value, options),
          ),
        ),
      ),
    revalidateElement: (reference, options) =>
      checked(ObservedElement, reference, "revalidate").pipe(
        Effect.flatMap((value) =>
          withOperationOptions(options, "revalidate", (options) =>
            controls.revalidate(value, options).pipe(Effect.as(value)),
          ),
        ),
      ),
    clickElement: (reference, admission, options) =>
      checked(ObservedElement, reference, "click").pipe(
        Effect.flatMap((value) =>
          withOperationOptions(options, "click", (options) =>
            controls.operations.click(value, admission?.admit, options),
          ),
        ),
        Effect.flatMap(({ url, input }) => action({ url, input })),
      ),
    fillElement: (reference, value, admission, options) =>
      checked(ObservedElement, reference, "fill").pipe(
        Effect.flatMap((element) =>
          checked(FillRequest.fields.value, value, "fill").pipe(
            Effect.flatMap((text) =>
              withOperationOptions(options, "fill", (options) =>
                controls.operations.fill(element, text, admission?.admit, options),
              ),
            ),
          ),
        ),
        Effect.flatMap(navigate),
      ),
    selectOption: (reference, options, admission, operationOptions) =>
      checked(ObservedElement, reference, "select-option").pipe(
        Effect.flatMap((element) =>
          checked(SelectOptions, options, "select-option").pipe(
            Effect.flatMap((ids) =>
              withOperationOptions(operationOptions, "select-option", (options) =>
                controls.selectOption(element, ids, admission?.admit, options),
              ),
            ),
          ),
        ),
        Effect.flatMap(navigate),
      ),
    fillForm: (request, admission, options = {}, operationOptions) =>
      checked(FillFormRequest, request, "fill-form").pipe(
        Effect.flatMap((form) =>
          checked(FillFormOptions, options, "fill-form").pipe(
            Effect.flatMap((settings) =>
              withOperationOptions(operationOptions, "fill-form", (options) =>
                controls.fillForm(
                  form,
                  admission?.admit,
                  {
                    verify: settings.verify ?? true,
                    settleMillis: settings.settleMillis ?? 50,
                  },
                  options,
                ),
              ),
            ),
          ),
        ),
        Effect.flatMap(formed),
      ),
    hoverElement: (reference, admission, options) =>
      checked(ObservedElement, reference, "hover").pipe(
        Effect.flatMap((value) =>
          withOperationOptions(options, "hover", (options) =>
            controls.operations.hover(value, admission?.admit, options),
          ),
        ),
        Effect.flatMap((input) => hovered({ ...input, kind: "hover" })),
      ),
    pressElement: (reference, stroke, admission, options) =>
      checked(ObservedElement, reference, "press").pipe(
        Effect.flatMap((element) =>
          checked(KeyStroke, stroke, "press").pipe(
            Effect.flatMap((value) =>
              withOperationOptions(options, "press", (options) =>
                controls.operations.press(
                  value.key,
                  value.modifiers ?? [],
                  element,
                  admission?.admit,
                  options,
                ),
              ),
            ),
          ),
        ),
        Effect.flatMap((input) => pressed({ ...input, kind: "press" })),
      ),
    typeElement: (reference, text, admission, options) =>
      checked(ObservedElement, reference, "type").pipe(
        Effect.flatMap((element) =>
          checked(TypeRequest.fields.text, text, "type").pipe(
            Effect.flatMap((value) =>
              withOperationOptions(options, "type", (options) =>
                controls.operations.type(value, element, admission?.admit, options),
              ),
            ),
          ),
        ),
        Effect.flatMap((input) => typed({ ...input, kind: "type" })),
      ),
    waitFor: (request, options) =>
      checked(Wait, request, "wait").pipe(
        Effect.flatMap((value) =>
          withOperationOptions(options, "wait", (options) =>
            controls.waitFor(value.selector, value.state, options),
          ),
        ),
      ),
    waitForElement: (request, options) =>
      checked(WaitForElementRequest, request, "wait").pipe(
        Effect.flatMap((value) =>
          withOperationOptions(options, "wait", (options) =>
            controls.waitForElement(value, options),
          ),
        ),
      ),
    clickAndWait: (request, options) =>
      checked(ClickRequest, request, "click-and-wait").pipe(
        Effect.flatMap((value) =>
          withOperationOptions(options, "click-and-wait", (options) =>
            controls.clickAndWait(value.selector, options),
          ),
        ),
        Effect.flatMap(({ url, input }) => action({ url, input })),
      ),
    ready: (options = {}) =>
      checkedOperationOptions(options, "ready").pipe(
        Effect.flatMap((options) => controls.readiness(options)),
        Effect.mapError((error) =>
          InitializationError.make({
            operation: "ready",
            step: "session",
            reason: initialization(error.reason),
          }),
        ),
        Effect.flatMap((state) =>
          state._tag === "NotReady"
            ? Effect.fail(
                InitializationError.make({
                  operation: "ready",
                  step: state.step,
                  reason: state.reason === "failed" ? "output" : state.reason,
                }),
              )
            : Effect.succeed<Bootstrap.ReadinessOutcome>({ _tag: state._tag }),
        ),
      ),
  };
};

const makePlanOperations = (
  controls: PageControls,
): Pick<Frame, "start" | "run" | "resolve" | "settled"> => {
  const prepare = (plan: LivePlanEncoded | PlanEncoded, options: RunOptions | undefined) =>
    checkedRunOptions(options).pipe(
      Effect.flatMap((options) =>
        checkedLivePlan(plan).pipe(Effect.map((plan) => ({ plan, options }))),
      ),
      Effect.mapError(
        (error) => new StepFailed({ stage: "PreparationFailed", completed: [], error }),
      ),
    );

  return {
    start: (plan, options) =>
      prepare(plan, options).pipe(
        Effect.flatMap(({ plan, options }) => controls.plans.start(plan, options)),
      ),
    run: (plan, options) =>
      prepare(plan, options).pipe(
        Effect.flatMap(({ plan, options }) => controls.plans.run(plan, options)),
      ),
    resolve: (descriptor, options) =>
      checkedResolveOptions(options).pipe(
        Effect.flatMap(({ operationOptions, guard }) =>
          checkedDescriptor(descriptor).pipe(
            Effect.flatMap((descriptor) => controls.resolve(descriptor, guard, operationOptions)),
          ),
        ),
      ),
    settled: (request, options) =>
      checkedSettled(request).pipe(
        Effect.flatMap((request) =>
          withOperationOptions(options, "settled", (options) => controls.settled(request, options)),
        ),
      ),
  };
};

export const makeSession = <E>(
  controls: SessionControls<SessionLease>,
  bindings: Bindings<E>,
): BrowserSession<E> => {
  const issued = new WeakMap<object, Page>();

  const issuedPage = (value: ReturnType<SessionControls["initialPage"]>): Page => {
    const existing = issued.get(value.record);

    if (existing !== undefined) return existing;

    const page: Page = {
      ...makePageOperations(value.controls),
      ...makePlanOperations(value.controls),
      identity: Object.freeze(value.record.identity),
      status: value.status,
      describe: (options = {}) =>
        checkedOperationOptions(options, "describe-page").pipe(
          Effect.flatMap((options) => value.controls.describePage(value.record.info, options)),
        ),
      listFrames: (options = {}) =>
        checkedOperationOptions(options, "list-frames").pipe(
          Effect.flatMap((options) => value.controls.framesOf(value.record.info, options)),
        ),
      frame: (info, options) =>
        checked(FrameInfo, info, "target").pipe(
          Effect.tap(() => value.controls.validate),
          Effect.flatMap((info) =>
            withOperationOptions(options, "target", (options) =>
              controls.frame(value.record.info, info, value.record.identity.generation, options),
            ),
          ),
          Effect.map((frame): Frame => ({
            ...makePageOperations(frame.controls),
            ...makePlanOperations(frame.controls),
            identity: Object.freeze(frame.identity),
            status: value.status.pipe(
              Effect.map((status) =>
                Object.freeze({
                  ...status,
                  identity: frame.identity,
                  phase:
                    status.phase !== "closed" && frame.record.detached ? "stale" : status.phase,
                }),
              ),
            ),
          })),
        ),
      resizeViewport: (viewport, options) =>
        checked(Viewport, viewport, "resize").pipe(
          Effect.flatMap((viewport) =>
            withOperationOptions(options, "resize", (options) =>
              value.controls.resize(viewport, options),
            ),
          ),
        ),
      close: (options = {}) =>
        checkedOperationOptions(options, "close-page").pipe(
          Effect.flatMap((options) => value.controls.closePage(value.record.info, options)),
        ),
    };

    issued.set(value.record, page);
    associate(
      page,
      forPage(controls.capture, value.record.info, value.record.identity, value.controls.validate),
    );
    associatePageAuthority(page, value.controls);
    associatePageControl(page, value.controls.pageControl, value.record.info);

    return page;
  };

  const session: BrowserSession<E> = {
    ...makePageOperations(controls),
    initialPage: issuedPage(controls.initialPage()),
    page: (info, options) =>
      checked(PageInfo, info, "target").pipe(
        Effect.flatMap((info) =>
          withOperationOptions(options, "target", (options) => controls.page(info, options)),
        ),
        Effect.map(issuedPage),
      ),
    listPages: (options = {}) =>
      checkedOperationOptions(options, "list-pages").pipe(
        Effect.flatMap((options) => controls.listPages(options)),
      ),
    implementation: controls.implementation,
    status: controls.status,
    diagnostics: controls.diagnostics,
    admission: controls.admissionStatus,
    closeChecked: controls.closeChecked,
    failure: bindings.failure,
    bindingDiagnostics: bindings.diagnostics,
    retain: (options) =>
      withOperationOptions(options, "target", (options) =>
        controls.retain(options).pipe(Effect.map(makeTarget)),
      ),
    target: (options) =>
      withOperationOptions(options, "target", (options) => controls.target(options)),
    pages: (options) =>
      withOperationOptions(options, "list-pages", (options) => controls.pages(options)),
    describePage: (page, options) =>
      checked(PageInfo, page, "describe-page").pipe(
        Effect.flatMap((page) =>
          withOperationOptions(options, "describe-page", (options) =>
            controls.describePage(page, options),
          ),
        ),
      ),
    frames: (options) =>
      withOperationOptions(options, "list-frames", (options) => controls.frames(options)),
    framesOf: (page, options) =>
      checked(PageInfo, page, "list-frames").pipe(
        Effect.flatMap((page) =>
          withOperationOptions(options, "list-frames", (options) =>
            controls.framesOf(page, options),
          ),
        ),
      ),
    pinPage: (page, options) =>
      checked(PageInfo, page, "target").pipe(
        Effect.flatMap((page) =>
          withOperationOptions(options, "target", (options) => controls.pinPage(page, options)),
        ),
        Effect.map(makePinnedTarget),
      ),
    pinFrame: (page, frame, options) =>
      checked(PageInfo, page, "target").pipe(
        Effect.flatMap((checkedPage) =>
          checked(FrameInfo, frame, "target").pipe(
            Effect.flatMap((checkedFrame) =>
              withOperationOptions(options, "target", (options) =>
                controls.pinFrame(checkedPage, checkedFrame, options),
              ),
            ),
          ),
        ),
        Effect.map(makePinnedTarget),
      ),
    selectPage: (page, options) =>
      checked(PageInfo, page, "select-page").pipe(
        Effect.flatMap((page) =>
          withOperationOptions(options, "select-page", (options) =>
            controls.selectPage(page, options),
          ),
        ),
      ),
    selectFrame: (id, options) =>
      checked(Identifier, id, "select-frame").pipe(
        Effect.flatMap((id) =>
          withOperationOptions(options, "select-frame", (options) =>
            controls.selectFrame(id, options),
          ),
        ),
      ),
    createPage: (options) =>
      withOperationOptions(options, "new-page", (options) => controls.createPage(options)),
    closePage: (page, options) =>
      checked(PageInfo, page, "close-page").pipe(
        Effect.flatMap((page) =>
          withOperationOptions(options, "close-page", (options) =>
            controls.closePage(page, options),
          ),
        ),
      ),
    resizeViewport: (viewport, options) =>
      checked(Viewport, viewport, "resize").pipe(
        Effect.flatMap((viewport) =>
          withOperationOptions(options, "resize", (options) => controls.resize(viewport, options)),
        ),
      ),
  };

  associate(session, controls.capture);
  associatePageControl(session, controls.pageControl);

  return session;
};
