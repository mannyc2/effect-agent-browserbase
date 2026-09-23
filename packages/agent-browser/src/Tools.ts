import { Effect, Layer } from "effect";
import type { BrowserSession } from "effect-browser/browser";

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
  observedSelectionToolkit,
  observedToolkit,
  readingToolkit,
  selectionToolkit,
  toolkit,
  toolNames,
  waitToolkit,
  type FormToolHandlers,
  type KeyboardToolHandlers,
  type NativeToolHandlers,
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

/** Layers over one borrowed session with no host; options are checked when a Layer is built. */
const unhosted = <E>(browser: BrowserSession<E>, options: HandlerOptions) =>
  Effect.map(resolveOptions(options), (resolved) =>
    makeLayers(browser, resolved, direct, continuationFor(browser)),
  );

/** Borrow one execution-owned session for the default Tools, with caller-managed sequencing. */
export const handlers = <E>(browser: BrowserSession<E>, options: HandlerOptions = {}) =>
  Layer.unwrap(Effect.map(unhosted(browser, options), (layers) => layers.handlers));

/** Continuation of the latest reading's text, over the same session. */
export const readingHandlers = <E>(browser: BrowserSession<E>, options: HandlerOptions = {}) =>
  Layer.unwrap(Effect.map(unhosted(browser, options), (layers) => layers.readingHandlers));

/** Opt-in native tools using the same session, exact-node policy and input budgets. */
export const nativeHandlers = <E>(browser: BrowserSession<E>, options: HandlerOptions = {}) =>
  Layer.unwrap(Effect.map(unhosted(browser, options), (layers) => layers.nativeHandlers));

/** Opt-in real keyboard tools using exact observed nodes and the same admission policy. */
export const keyboardHandlers = <E>(browser: BrowserSession<E>, options: HandlerOptions = {}) =>
  Layer.unwrap(Effect.map(unhosted(browser, options), (layers) => layers.keyboardHandlers));

/** Opt-in exact option selection with caller-managed sequencing and lifetime. */
export const selectionHandlers = <E>(browser: BrowserSession<E>, options: HandlerOptions = {}) =>
  Layer.unwrap(Effect.map(unhosted(browser, options), (layers) => layers.selectionHandlers));

/** Pure bounded waits with caller-managed sequencing; scoped hosts use the same invocation lane. */
export const waitHandlers = <E>(browser: BrowserSession<E>) =>
  Layer.unwrap(Effect.map(unhosted(browser, {}), (layers) => layers.waitHandlers));

/** Opt-in form filling over the same session and admission policy. */
export const formHandlers = <E>(browser: BrowserSession<E>, options: HandlerOptions = {}) =>
  Layer.unwrap(Effect.map(unhosted(browser, options), (layers) => layers.formHandlers));

/** Handlers for opt-in result variants; each agent still declares its own permitted toolkit groups. */
export const observedHandlers = <E>(browser: BrowserSession<E>, options: HandlerOptions = {}) =>
  Layer.unwrap(Effect.map(unhosted(browser, options), (layers) => layers.observedHandlers));
