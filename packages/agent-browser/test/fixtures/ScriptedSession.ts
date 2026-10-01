import { Effect } from "effect";
import type { BrowserSession, Page, TargetOperations } from "effect-browser/browser";
import { BrowserDiagnostics, SessionStatus, Target } from "effect-browser/browser-data";

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

  // An unused typed operation stub, deliberately absent from the runtime's authority registries.
  const initialPage: Page = {
    ...operations,
    start: () => unexpected,
    run: () => unexpected,
    resolve: () => unexpected,
    settled: () => unexpected,
    identity: Target.make({ generation: 1, pageId: "scripted-page", frameId: "scripted-frame" }),
    status: unexpected,
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
    waitFor: () => unexpected,
    waitForElement: () => unexpected,
    clickAndWait: () => unexpected,
    ready: () => unexpected,
    describe: () => unexpected,
    listFrames: () => unexpected,
    frame: () => unexpected,
    resizeViewport: () => unexpected,
    close: () => unexpected,
  };

  return {
    ...operations,
    initialPage,
    page: () => unexpected,
    listPages: () => unexpected,
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
    admission: Effect.succeed(
      Object.freeze({
        waiting: 0,
        maximum: 128,
        nativePending: 0,
        nativeMaximum: 128,
        nativeWaits: 0,
        stopSetups: 0,
        registry: Object.freeze({
          active: null,
          waiting: 0,
          maximum: 32,
          oldestWaitMillis: null,
          nativePending: 0,
          nativeWaitPending: false,
          stopSetupPending: false,
        }),
      }),
    ),
    closeChecked: Effect.void,
    failure: Effect.never,
    bindingDiagnostics: unexpected,
    retain: () => Effect.succeed(operations),
    target: () => unexpected,
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
    pages: () => unexpected,
    describePage: () => unexpected,
    frames: () => unexpected,
    framesOf: () => unexpected,
    pinPage: () => unexpected,
    pinFrame: () => unexpected,
    selectPage: () => unexpected,
    selectFrame: () => unexpected,
    createPage: () => unexpected,
    closePage: () => unexpected,
    resizeViewport: () => unexpected,
    waitFor: () => unexpected,
    waitForElement: () => unexpected,
    clickAndWait: () => unexpected,
    ready: () => unexpected,
    ...overrides,
  };
};
