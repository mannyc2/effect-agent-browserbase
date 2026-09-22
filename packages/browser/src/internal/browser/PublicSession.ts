import { Effect, Schema } from "effect";

import type * as Bootstrap from "../../Bootstrap.ts";
import type { BrowserSession, TargetOperations, PinnedTarget } from "../../Browser.ts";
import {
  ActionResult,
  Checkpoint,
  CheckpointOptions,
  ClickRequest,
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
  InitializationError,
} from "../../Errors.ts";
import { associate } from "./Association.ts";
import type { Bindings } from "./Bindings.ts";
import { associatePageControl } from "./PageControlAssociation.ts";
import { schemaPath } from "./SchemaPath.ts";
import type { TargetControls, SessionControls, SessionLease } from "./Session.ts";

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

export const decoded =
  <A>(
    schema: Schema.Codec<A, unknown, never, never>,
    operation: BrowserOperation,
    outcome: BrowserOutcome,
  ) =>
  (value: unknown) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError((error) =>
        BrowserError.make({
          operation,
          reason: Reasons.Malformed.make(schemaPath(error)),
          outcome,
        }),
      ),
    );

const action = decoded(ActionResult, "action-result", "unknown");
const pointerMoved = decoded(InputReceipt, "pointer-move", "unknown");
const hovered = decoded(InputReceipt, "hover", "unknown");
const wheeled = decoded(InputReceipt, "wheel", "unknown");
const pressed = decoded(InputReceipt, "press", "unknown");
const typed = decoded(InputReceipt, "type", "unknown");

const makeTarget = (bound: TargetControls): TargetOperations => ({
  navigate: (request) =>
    checked(NavigateRequest, request, "navigate").pipe(
      Effect.flatMap((value) => bound.navigate(value.url, value.timeoutMillis)),
      Effect.flatMap((url) => decoded(NavigationResult, "navigate", "unknown")({ url })),
    ),
  startNavigation: (request) =>
    checked(StartNavigationRequest, request, "navigate").pipe(
      Effect.flatMap((value) => bound.startNavigation(value.url, value.timeoutMillis)),
      Effect.map((operation) => ({
        target: operation.target,
        completed: operation.completed.pipe(
          Effect.flatMap((url) => decoded(NavigationResult, "navigate", "unknown")({ url })),
        ),
        stop: operation.stop,
      })),
    ),
  readText: (request) =>
    checked(ReadTextRequest, request, "read-text").pipe(
      Effect.flatMap((value) => bound.readText(value.selector)),
      Effect.flatMap((text) => decoded(TextResult, "read-text", "undispatched")({ text })),
    ),
  click: (request) =>
    checked(ClickRequest, request, "click").pipe(
      Effect.flatMap((value) => bound.click(value.selector)),
      Effect.flatMap((url) => action({ url })),
    ),
  fill: (request) =>
    checked(FillRequest, request, "fill").pipe(
      Effect.flatMap((value) => bound.fill(value.selector, value.value)),
      Effect.flatMap((url) => action({ url })),
    ),
  scroll: (request) =>
    checked(ScrollRequest, request, "scroll").pipe(
      Effect.flatMap((value) => bound.scroll(value.deltaX, value.deltaY)),
      Effect.flatMap((url) => action({ url })),
    ),
  pointerMove: (request) =>
    checked(PointerMoveRequest, request, "pointer-move").pipe(
      Effect.flatMap((value) => bound.pointerMove(value.to)),
      Effect.flatMap((input) => pointerMoved({ ...input, kind: "pointer-move" })),
    ),
  hover: (request) =>
    checked(HoverRequest, request, "hover").pipe(
      Effect.flatMap((value) => bound.hover(value.selector)),
      Effect.flatMap((input) => hovered({ ...input, kind: "hover" })),
    ),
  wheel: (request) =>
    checked(WheelRequest, request, "wheel").pipe(
      Effect.flatMap((value) =>
        bound
          .wheel(value.deltaX, value.deltaY, value.at)
          .pipe(
            Effect.flatMap((input) =>
              wheeled({ ...input, kind: "wheel", delta: { x: value.deltaX, y: value.deltaY } }),
            ),
          ),
      ),
    ),
  press: (request) =>
    checked(PressRequest, request, "press").pipe(
      Effect.flatMap((value) => bound.press(value.key, value.modifiers ?? [], value.into)),
      Effect.flatMap((input) => pressed({ ...input, kind: "press" })),
    ),
  type: (request) =>
    checked(TypeRequest, request, "type").pipe(
      Effect.flatMap((value) => bound.type(value.text, value.into)),
      Effect.flatMap((input) => typed({ ...input, kind: "type" })),
    ),
  screenshot: (request) =>
    checked(ScreenshotRequest, request, "screenshot").pipe(
      Effect.flatMap((value) => bound.screenshot(value.fullPage)),
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
  reason._tag === "Busy"
    ? "busy"
    : reason._tag === "Closed" || reason._tag === "Disconnected"
      ? "closed"
      : reason._tag === "Timeout"
        ? "timeout"
        : reason._tag === "Stale"
          ? "stale"
          : reason._tag === "Unsupported"
            ? "unsupported"
            : reason._tag === "Configuration"
              ? "configuration"
              : "native";

export const makeSession = <E>(
  controls: SessionControls<SessionLease>,
  bindings: Bindings<E>,
): BrowserSession<E> => {
  const Wait = Schema.Struct({
    selector: ClickRequest.fields.selector,
    state: Schema.Literals(["visible", "hidden", "attached", "detached"]),
  });

  const navigate = (url: string) => action({ url });

  const session: BrowserSession<E> = {
    ...makeTarget(controls.operations),
    implementation: controls.implementation,
    status: controls.status,
    diagnostics: controls.diagnostics,
    closeChecked: controls.closeChecked,
    failure: bindings.failure,
    bindingDiagnostics: bindings.diagnostics,
    retain: controls.retain.pipe(Effect.map(makeTarget)),
    target: controls.target,
    observe: (options = {}) =>
      checked(ObservationOptions, options, "observe").pipe(
        Effect.flatMap((value) => controls.observe({ ...value, scope: value.scope ?? "document" })),
      ),
    checkpoint: (options = {}) =>
      checked(CheckpointOptions, options, "checkpoint").pipe(
        Effect.flatMap((value) =>
          controls.checkpoint({ ...value, picture: value.picture ?? false }),
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
    controlFacts: (reference) =>
      checked(ObservedElement, reference, "control-facts").pipe(
        Effect.flatMap(controls.controlFacts),
      ),
    revalidateElement: (reference) =>
      checked(ObservedElement, reference, "revalidate").pipe(
        Effect.flatMap((value) => controls.revalidate(value).pipe(Effect.as(value))),
      ),
    clickElement: (reference, admission) =>
      checked(ObservedElement, reference, "click").pipe(
        Effect.flatMap((value) => controls.operations.click(value, admission?.admit)),
        Effect.flatMap(navigate),
      ),
    fillElement: (reference, value, admission) =>
      checked(ObservedElement, reference, "fill").pipe(
        Effect.flatMap((element) =>
          checked(FillRequest.fields.value, value, "fill").pipe(
            Effect.flatMap((text) => controls.operations.fill(element, text, admission?.admit)),
          ),
        ),
        Effect.flatMap(navigate),
      ),
    selectOption: (reference, options, admission) =>
      checked(ObservedElement, reference, "select-option").pipe(
        Effect.flatMap((element) =>
          checked(SelectOptions, options, "select-option").pipe(
            Effect.flatMap((ids) => controls.selectOption(element, ids, admission?.admit)),
          ),
        ),
        Effect.flatMap(navigate),
      ),
    hoverElement: (reference, admission) =>
      checked(ObservedElement, reference, "hover").pipe(
        Effect.flatMap((value) => controls.operations.hover(value, admission?.admit)),
        Effect.flatMap((input) => hovered({ ...input, kind: "hover" })),
      ),
    pressElement: (reference, stroke, admission) =>
      checked(ObservedElement, reference, "press").pipe(
        Effect.flatMap((element) =>
          checked(KeyStroke, stroke, "press").pipe(
            Effect.flatMap((value) =>
              controls.operations.press(
                value.key,
                value.modifiers ?? [],
                element,
                admission?.admit,
              ),
            ),
          ),
        ),
        Effect.flatMap((input) => pressed({ ...input, kind: "press" })),
      ),
    typeElement: (reference, text, admission) =>
      checked(ObservedElement, reference, "type").pipe(
        Effect.flatMap((element) =>
          checked(TypeRequest.fields.text, text, "type").pipe(
            Effect.flatMap((value) => controls.operations.type(value, element, admission?.admit)),
          ),
        ),
        Effect.flatMap((input) => typed({ ...input, kind: "type" })),
      ),
    pages: controls.pages,
    frames: controls.frames,
    framesOf: (page) =>
      checked(PageInfo, page, "list-frames").pipe(Effect.flatMap(controls.framesOf)),
    pinPage: (page) =>
      checked(PageInfo, page, "target").pipe(
        Effect.flatMap(controls.pinPage),
        Effect.map(makePinnedTarget),
      ),
    pinFrame: (page, frame) =>
      checked(PageInfo, page, "target").pipe(
        Effect.flatMap((checkedPage) =>
          checked(FrameInfo, frame, "target").pipe(
            Effect.flatMap((checkedFrame) => controls.pinFrame(checkedPage, checkedFrame)),
          ),
        ),
        Effect.map(makePinnedTarget),
      ),
    selectPage: (page) =>
      checked(PageInfo, page, "select-page").pipe(Effect.flatMap(controls.selectPage)),
    selectFrame: (id) =>
      checked(Identifier, id, "select-frame").pipe(Effect.flatMap(controls.selectFrame)),
    createPage: controls.createPage(),
    closePage: (page) =>
      checked(PageInfo, page, "close-page").pipe(Effect.flatMap(controls.closePage)),
    resizeViewport: (viewport) =>
      checked(Viewport, viewport, "resize").pipe(Effect.flatMap(controls.resize)),
    waitFor: (request) =>
      checked(Wait, request, "wait").pipe(
        Effect.flatMap((value) => controls.waitFor(value.selector, value.state)),
      ),
    waitForElement: (request) =>
      checked(WaitForElementRequest, request, "wait").pipe(Effect.flatMap(controls.waitForElement)),
    clickAndWait: (request) =>
      checked(ClickRequest, request, "click-and-wait").pipe(
        Effect.flatMap((value) => controls.clickAndWait(value.selector)),
        Effect.flatMap((url) => action({ url })),
      ),
    ready: controls.readiness.pipe(
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

  associate(session, controls.capture);
  associatePageControl(session, controls.pageControl);

  return session;
};
