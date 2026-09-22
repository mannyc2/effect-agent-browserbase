import { Effect, type Scope } from "effect";
import { dual } from "effect/Function";

import type * as Bootstrap from "./Bootstrap.ts";
import type {
  BrowserDiagnostics,
  Checkpoint,
  CheckpointOptions,
  FillRequest,
  HoverRequest,
  InputReceipt,
  KeyStroke,
  NavigateRequest,
  NavigationResult,
  ObservationOptions,
  ObservedElement,
  PointerMoveRequest,
  PressRequest,
  ReadTextRequest,
  ScreenshotRequest,
  ScreenshotResult,
  ScrollRequest,
  SelectOptions,
  SessionStatus,
  StartNavigationRequest,
  TextResult,
  TypeRequest,
  WheelRequest,
  ControlFacts,
  ActionResult,
  ClickRequest,
  FrameInfo,
  Observation,
  PageInfo,
  Target,
  Viewport,
} from "./BrowserData.ts";
import type { BrowserError, InitializationError } from "./Errors.ts";

/**
 * A host's decision about one control, made on facts read from the exact node immediately
 * before input. Returning anything but `true`, or throwing, sends nothing and fails `denied`.
 * It is a plain synchronous function on purpose: it runs while the owner's permit is held, where
 * waiting on a model or a network call would stall every other operation. It is not an atomic
 * check-and-input transaction, because page script can still run before the native input lands.
 */
export interface ElementAdmission {
  readonly admit: (facts: ControlFacts) => boolean;
}

/**
 * A navigation the browser is still performing. The owner's permit was released when it was
 * dispatched, so while it loads a host may read, `checkpoint`, hold and resume this page, and
 * use any other page. Anything that would change this page fails `busy` until it settles.
 *
 * Leaving its scope unsettled fences the session, exactly as an interrupted mutation does,
 * because nothing then knows what the browser did. It is never replayed.
 */
export interface NavigationOperation {
  /** What was navigated, read before dispatch. */
  readonly target: Target;
  /**
   * The document reached DOMContentLoaded. It belongs to this one navigation: a successor that
   * reaches the same URL fails it instead. Interrupting a waiter stops nothing in the browser.
   */
  readonly completed: Effect.Effect<NavigationResult, BrowserError>;
  /**
   * Asks the browser to stop loading and waits for this navigation to settle, after which
   * `completed` fails `interrupted`. Success is a known outcome and the session stays usable:
   * the page holds whatever had loaded. It does not undo anything the page already did.
   * An already-completed navigation cannot stop a successor. Concurrent callers share their
   * active attempt. Before dispatch, cancellation or a busy refusal permits a later request
   * once native setup has retired. A dispatched attempt's outcome, including failure or
   * interruption, is retained permanently; an uncertain stop is never replayed.
   */
  readonly stop: Effect.Effect<void, BrowserError>;
}

/** Common operations. Direct, retained and pinned views choose their target at different times. */
export interface TargetOperations {
  readonly navigate: (request: NavigateRequest) => Effect.Effect<NavigationResult, BrowserError>;
  /** `navigate`, left in flight: the same single dispatch, completed by the caller. */
  readonly startNavigation: (
    request: StartNavigationRequest,
  ) => Effect.Effect<NavigationOperation, BrowserError, Scope.Scope>;
  readonly readText: (request: ReadTextRequest) => Effect.Effect<TextResult, BrowserError>;
  readonly click: (request: ClickRequest) => Effect.Effect<ActionResult, BrowserError>;
  readonly fill: (request: FillRequest) => Effect.Effect<ActionResult, BrowserError>;
  /** Script in the page: instantaneous, and it raises no wheel event. */
  readonly scroll: (request: ScrollRequest) => Effect.Effect<ActionResult, BrowserError>;
  /** One real pointer move, in main-frame viewport pixels. */
  readonly pointerMove: (request: PointerMoveRequest) => Effect.Effect<InputReceipt, BrowserError>;
  /** Places the pointer on one exact element where it is, or fails `not-visible` unsent. */
  readonly hover: (request: HoverRequest) => Effect.Effect<InputReceipt, BrowserError>;
  /** One real wheel event; the browser decides what under the pointer scrolls. */
  readonly wheel: (request: WheelRequest) => Effect.Effect<InputReceipt, BrowserError>;
  /** One real key stroke to whatever has focus, or fails `not-focused` unsent if `into` lacks it. */
  readonly press: (request: PressRequest) => Effect.Effect<InputReceipt, BrowserError>;
  /** Text as the real key strokes that produce it, under the same focus rule as `press`. */
  readonly type: (request: TypeRequest) => Effect.Effect<InputReceipt, BrowserError>;
  readonly screenshot: (
    request: ScreenshotRequest,
  ) => Effect.Effect<ScreenshotResult, BrowserError>;
}

/**
 * One explicit page/frame target. Selection may move independently; each operation re-resolves
 * this identity inside the same owner and connection. Closing/detaching it or reconnecting makes
 * the handle stale before dispatch.
 */
export interface PinnedTarget extends TargetOperations {
  readonly target: Target;
}

/** A checked selection retained at acquisition; moving selection away and back makes it stale. */
export interface RetainedTarget extends TargetOperations {}

/**
 * Host control over one owned browser. This is not a serializable model value: copying a
 * session object cannot copy its capture, page-control or connection authority.
 *
 * The inherited target operations resolve the selected page/frame when their Effect executes.
 * Use `retain` to retain the current selection with stale-on-selection-change semantics, or
 * `pinPage` / `pinFrame` when work must stay on an explicit target while selection moves.
 */
export interface BrowserSession<E = never> extends TargetOperations {
  /** The implementation which owns this live connection. */
  readonly implementation: string;
  /** Copied host-only state, readable without admission in every lifecycle phase. */
  readonly status: Effect.Effect<SessionStatus>;
  /** Bounded native/policy diagnostics. Typed callback causes remain in bindingDiagnostics. */
  readonly diagnostics: Effect.Effect<BrowserDiagnostics>;
  /** Close this scope and require its own ownership-specific cleanup evidence. */
  readonly closeChecked: Effect.Effect<void, BrowserError>;
  /** First fail-session callback cause, preserving the consumer's error type on the host. */
  readonly failure: Effect.Effect<never, E | InitializationError>;
  /** Bounded host-only evidence; consumer causes are never projected into a page reply. */
  readonly bindingDiagnostics: Effect.Effect<Bootstrap.BindingDiagnostics<E>>;
  /** Resolve, validate and retain the selection under owner admission. */
  readonly retain: Effect.Effect<RetainedTarget, BrowserError>;
  readonly target: Effect.Effect<Target, BrowserError>;
  /**
   * The one observation whose nodes later actions may name. `scope: "viewport"` keeps only text
   * and controls that are on screen and reachable, plus bounded choices of visible native
   * selects; the default reads the whole document. It carries no destination, form or field value.
   */
  readonly observe: (options?: ObservationOptions) => Effect.Effect<Observation, BrowserError>;
  /**
   * Passive evidence for a recorder, with a picture when asked. It issues no references and
   * leaves the observation above exactly as it was. Host-only: it carries control facts.
   */
  readonly checkpoint: (options?: CheckpointOptions) => Effect.Effect<Checkpoint, BrowserError>;
  /** Host-only facts about one observed control, read from that exact node just now. */
  readonly controlFacts: (reference: ObservedElement) => Effect.Effect<ControlFacts, BrowserError>;
  /**
   * After a page hold, nothing observed on that page may be acted on unchecked. This checks one
   * reference: still attached, and still the control that was inspected. It never searches by
   * selector or label for a substitute, and it sends nothing.
   */
  readonly revalidateElement: (
    reference: ObservedElement,
  ) => Effect.Effect<ObservedElement, BrowserError>;
  readonly clickElement: (
    reference: ObservedElement,
    admission?: ElementAdmission,
  ) => Effect.Effect<ActionResult, BrowserError>;
  readonly fillElement: (
    reference: ObservedElement,
    value: string,
    admission?: ElementAdmission,
  ) => Effect.Effect<ActionResult, BrowserError>;
  /** One selection using this exact select and its issued option element IDs, with fresh checks. */
  readonly selectOption: (
    reference: ObservedElement,
    options: SelectOptions,
    admission?: ElementAdmission,
  ) => Effect.Effect<ActionResult, BrowserError>;
  readonly hoverElement: (
    reference: ObservedElement,
    admission?: ElementAdmission,
  ) => Effect.Effect<InputReceipt, BrowserError>;
  /** A key stroke sent only if the exact node an observation named already has focus. */
  readonly pressElement: (
    reference: ObservedElement,
    stroke: KeyStroke,
    admission?: ElementAdmission,
  ) => Effect.Effect<InputReceipt, BrowserError>;
  /** Real typing with `fillElement`'s exactness: that node must already have focus. */
  readonly typeElement: (
    reference: ObservedElement,
    text: string,
    admission?: ElementAdmission,
  ) => Effect.Effect<InputReceipt, BrowserError>;
  readonly pages: Effect.Effect<ReadonlyArray<PageInfo>, BrowserError>;
  readonly frames: Effect.Effect<ReadonlyArray<FrameInfo>, BrowserError>;
  /** List frames on one exact page without selecting it. */
  readonly framesOf: (page: PageInfo) => Effect.Effect<ReadonlyArray<FrameInfo>, BrowserError>;
  /** Pin the page's main frame without changing the session selection. */
  readonly pinPage: (page: PageInfo) => Effect.Effect<PinnedTarget, BrowserError>;
  /** Pin one frame that currently belongs to the exact page, without changing selection. */
  readonly pinFrame: (
    page: PageInfo,
    frame: FrameInfo,
  ) => Effect.Effect<PinnedTarget, BrowserError>;
  readonly selectPage: (page: PageInfo) => Effect.Effect<void, BrowserError>;
  readonly selectFrame: (frameId: string) => Effect.Effect<void, BrowserError>;
  /** Create a tab without selecting it and return that exact tab's checked identity. */
  readonly createPage: Effect.Effect<PageInfo, BrowserError>;
  readonly closePage: (page: PageInfo) => Effect.Effect<void, BrowserError>;
  readonly resizeViewport: (viewport: Viewport) => Effect.Effect<void, BrowserError>;
  readonly waitFor: (request: {
    readonly selector: string;
    readonly state: "visible" | "hidden" | "attached" | "detached";
  }) => Effect.Effect<void, BrowserError>;
  /** Navigation observation is registered before the single click dispatch. */
  readonly clickAndWait: (request: ClickRequest) => Effect.Effect<ActionResult, BrowserError>;
  /**
   * Readiness of the current document only. Dependent operations wait for it themselves;
   * this reports it without charging an action, so a caller can decide what to do about a
   * document that predates the registrations.
   */
  readonly ready: Effect.Effect<Bootstrap.ReadinessOutcome, InitializationError>;
}

/** Helpers that do not supervise callback failures accept any live browser session. */
export type AnySession = BrowserSession<unknown>;

/** Dependencies are captured at acquisition, not erased into an environment-free service Layer. */
export interface OpenOptions<E = never, R = never> {
  readonly bootstrap?: Bootstrap.Plan<E, R>;
}

/**
 * Acquire, supervise and close one browser in a fresh scope. The callback keeps the concrete
 * Chromium or provider session type. Its scoped work is joined before checked browser cleanup,
 * and cleanup failures remain typed even when the callback has already failed or was cancelled.
 * Acquisition is evaluated once; an uncertain result is never retried.
 */
export const scoped: {
  <S extends BrowserSession<unknown>, A, E2, R2>(
    f: (session: S) => Effect.Effect<A, E2, R2>,
  ): <E, AE, AR>(
    open: Effect.Effect<S & BrowserSession<E>, AE, AR>,
  ) => Effect.Effect<
    A,
    AE | E | E2 | InitializationError | BrowserError,
    Exclude<AR | R2, Scope.Scope>
  >;
  <S, E, AE, AR, A, E2, R2>(
    open: Effect.Effect<S & BrowserSession<E>, AE, AR>,
    f: (session: S & BrowserSession<E>) => Effect.Effect<A, E2, R2>,
  ): Effect.Effect<
    A,
    AE | E | E2 | InitializationError | BrowserError,
    Exclude<AR | R2, Scope.Scope>
  >;
} = dual(
  2,
  <S, E, AE, AR, A, E2, R2>(
    open: Effect.Effect<S & BrowserSession<E>, AE, AR>,
    f: (session: S & BrowserSession<E>) => Effect.Effect<A, E2, R2>,
  ) =>
    Effect.scoped(
      Effect.flatMap(open, (session) =>
        Effect.scoped(
          Effect.raceFirst(
            session.failure,
            Effect.suspend(() => f(session)),
          ),
        ).pipe(Effect.onExit(() => session.closeChecked)),
      ),
    ),
);
