import { Effect } from "effect";
import type { BrowserSession, TargetOperations } from "effect-browser/browser";
import { BrowserDiagnostics, SessionStatus } from "effect-browser/browser-data";

/** Typed operation double for adapter/Toolkit tests; it issues no native or capture authority. */
export const scriptedSession = (overrides: Partial<BrowserSession> = {}): BrowserSession => {
  const unexpected = Effect.die("Unexpected scripted session operation");

  const operations: TargetOperations = {
    navigate: () => unexpected,
    startNavigation: () => unexpected,
    readText: () => unexpected,
    click: () => unexpected,
    fill: () => unexpected,
    scroll: () => unexpected,
    pointerMove: () => unexpected,
    hover: () => unexpected,
    wheel: () => unexpected,
    press: () => unexpected,
    type: () => unexpected,
    screenshot: () => unexpected,
  };

  return {
    ...operations,
    implementation: "scripted-browser",
    status: Effect.sync(() =>
      Object.freeze(
        SessionStatus.make({
          phase: "open",
          reason: null,
          generation: 1,
          busy: false,
          unresolvedDispatch: false,
          actions: { used: 0, maximum: 100 },
        }),
      ),
    ),
    diagnostics: Effect.sync(() =>
      Object.freeze(
        BrowserDiagnostics.make({
          records: Object.freeze([]),
          total: 0,
          dropped: 0,
          truncated: false,
        }),
      ),
    ),
    closeChecked: Effect.void,
    failure: Effect.never,
    bindingDiagnostics: unexpected,
    retain: Effect.succeed(operations),
    target: unexpected,
    observe: () => unexpected,
    checkpoint: () => unexpected,
    controlFacts: () => unexpected,
    revalidateElement: () => unexpected,
    clickElement: () => unexpected,
    fillElement: () => unexpected,
    selectOption: () => unexpected,
    fillForm: () => unexpected,
    hoverElement: () => unexpected,
    pressElement: () => unexpected,
    typeElement: () => unexpected,
    pages: unexpected,
    frames: unexpected,
    framesOf: () => unexpected,
    pinPage: () => unexpected,
    pinFrame: () => unexpected,
    selectPage: () => unexpected,
    selectFrame: () => unexpected,
    createPage: unexpected,
    closePage: () => unexpected,
    resizeViewport: () => unexpected,
    waitFor: () => unexpected,
    waitForElement: () => unexpected,
    clickAndWait: () => unexpected,
    ready: unexpected,
    ...overrides,
  };
};
