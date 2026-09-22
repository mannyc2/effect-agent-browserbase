import { Effect } from "effect";
import type { BrowserSession, TargetOperations } from "effect-browser/browser";

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
    clickAndWait: () => unexpected,
    ready: unexpected,
    ...overrides,
  };
};
