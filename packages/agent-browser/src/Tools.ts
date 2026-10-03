import { Effect, Layer } from "effect";
import { checkPage, type BrowserSession, type Frame, type Page } from "effect-browser/browser";

import { direct, makeLayers } from "./internal/tools/Handlers.ts";
import { type HandlerOptions, resolveOptions } from "./internal/tools/Options.ts";
import { continuationFor } from "./internal/tools/Results.ts";

export {
  describe,
  formToolkit,
  isBrowserTool,
  keyboardToolkit,
  nativeToolkit,
  observedFormToolkit,
  observedKeyboardToolkit,
  observedNativeToolkit,
  observedPointToolkit,
  observedSelectionToolkit,
  observedToolkit,
  readingToolkit,
  pointToolkit,
  selectionToolkit,
  toolkit,
  toolNames,
  waitToolkit,
  type FormToolHandlers,
  type KeyboardToolHandlers,
  type NativeToolHandlers,
  type PointToolHandlers,
  type ObservedToolHandlers,
  type ReadingToolHandlers,
  type SelectionToolHandlers,
  type ToolHandlers,
  type ToolHostServices,
  type WaitToolHandlers,
} from "./internal/tools/Definitions.ts";

export { instructions, policy, sequentialScheduling } from "./internal/tools/Guidance.ts";

export {
  makeHost,
  run,
  type HostOptions,
  type LaneOptions,
  type ToolFailureDiagnostic,
  type ToolFailureSnapshot,
  type ToolCallRecord,
  type ToolCallSnapshot,
  type ToolHost,
  type ToolHostFailure,
  type ToolRunRequirements,
} from "./internal/tools/Host.ts";

export {
  BrowserFormFailure,
  BrowserToolFailure,
  ElementReference,
  FillFormParameters,
  FollowUpObservation,
  FormFillResult,
  InspectRequest,
  NativeInputResult,
  ObservedActionResult,
  ObservedFormResult,
  ObservedInputResult,
  ObservedNavigationResult,
  ReadMoreRequest,
  ReadMoreResult,
  ResultMaxBytes,
  WaitResult,
} from "./internal/tools/Model.ts";

export type { HandlerOptions, InspectionRequest, Observe } from "./internal/tools/Options.ts";

/**
 * Layers over one issued Page, or one Frame a Page issued, with no host. The target and options
 * are checked when a Layer is built.
 */
const unhosted = <E>(browser: BrowserSession<E>, page: Page | Frame, options: HandlerOptions) =>
  checkPage(browser, page).pipe(
    Effect.andThen(resolveOptions(options)),
    Effect.map((resolved) => makeLayers(page, resolved, direct, continuationFor(page))),
  );

/** Borrow one execution-owned session for the default Tools, with caller-managed sequencing. */
export const handlers = <E>(
  browser: BrowserSession<E>,
  page: Page | Frame,
  options: HandlerOptions = {},
) => Layer.unwrap(Effect.map(unhosted(browser, page, options), (layers) => layers.handlers));

/** Continuation of the latest reading's text, over the same session. */
export const readingHandlers = <E>(
  browser: BrowserSession<E>,
  page: Page | Frame,
  options: HandlerOptions = {},
) => Layer.unwrap(Effect.map(unhosted(browser, page, options), (layers) => layers.readingHandlers));

/** Opt-in native tools using the same session, exact-node policy and input budgets. */
export const nativeHandlers = <E>(
  browser: BrowserSession<E>,
  page: Page | Frame,
  options: HandlerOptions = {},
) => Layer.unwrap(Effect.map(unhosted(browser, page, options), (layers) => layers.nativeHandlers));

/** Opt-in coordinate clicks over one issued Page and its separate coordinate admission policy. */
export const pointHandlers = <E>(
  browser: BrowserSession<E>,
  page: Page | Frame,
  options: HandlerOptions = {},
) => Layer.unwrap(Effect.map(unhosted(browser, page, options), (layers) => layers.pointHandlers));

/** Opt-in real keyboard tools using exact observed nodes and the same admission policy. */
export const keyboardHandlers = <E>(
  browser: BrowserSession<E>,
  page: Page | Frame,
  options: HandlerOptions = {},
) =>
  Layer.unwrap(Effect.map(unhosted(browser, page, options), (layers) => layers.keyboardHandlers));

/** Opt-in exact option selection with caller-managed sequencing and lifetime. */
export const selectionHandlers = <E>(
  browser: BrowserSession<E>,
  page: Page | Frame,
  options: HandlerOptions = {},
) =>
  Layer.unwrap(Effect.map(unhosted(browser, page, options), (layers) => layers.selectionHandlers));

/** Pure bounded waits with caller-managed sequencing; scoped hosts use the same invocation lane. */
export const waitHandlers = <E>(
  browser: BrowserSession<E>,
  page: Page | Frame,
  options: HandlerOptions = {},
) => Layer.unwrap(Effect.map(unhosted(browser, page, options), (layers) => layers.waitHandlers));

/** Opt-in form filling over the same session and admission policy. */
export const formHandlers = <E>(
  browser: BrowserSession<E>,
  page: Page | Frame,
  options: HandlerOptions = {},
) => Layer.unwrap(Effect.map(unhosted(browser, page, options), (layers) => layers.formHandlers));

/** Handlers for opt-in result variants; each agent still declares its own permitted toolkit groups. */
export const observedHandlers = <E>(
  browser: BrowserSession<E>,
  page: Page | Frame,
  options: HandlerOptions = {},
) =>
  Layer.unwrap(Effect.map(unhosted(browser, page, options), (layers) => layers.observedHandlers));
