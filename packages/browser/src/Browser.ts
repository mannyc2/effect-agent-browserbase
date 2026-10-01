import { type Duration, Effect, type Scope } from "effect";
import { dual } from "effect/Function";

import type * as Bootstrap from "./Bootstrap.ts";
import type {
  BrowserDiagnostics,
  Checkpoint,
  CheckpointOptions,
  FillFormOptions,
  FillFormRequest,
  FillFormResult,
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
  WaitForElementRequest,
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
import type { BrowserError, BrowserOperation, Containment, InitializationError } from "./Errors.ts";
import type { PlanOperations } from "./Plan.ts";
import type { DescriptorEncoded, ResolveGuard, SettledEvidence } from "./PlanData.ts";

/**
 * Host-only ordinary admission. Omission or zero fails immediately; positive finite duration
 * queues FIFO. Page closure uses reserved fail-fast admission and a deadline-bounded shared close.
 */
export interface AdmissionOptions {
  readonly queue?: Duration.Input;
}

/** Explicit host options, separate from request data and exact-element admission callbacks. */
export interface OperationOptions {
  readonly timeoutMillis?: number;
  readonly admission?: AdmissionOptions;
}

/** Explicit descriptor guard and ordinary host admission; no selector or geometry fallback. */
export interface ResolveOptions extends OperationOptions {
  readonly guard?: typeof ResolveGuard.Encoded;
}

/** Named native quiet signals within the original positive finite deadline. */
export interface SettledRequest {
  readonly quiet: Duration.Input;
  readonly within: Duration.Input;
}

/** A bounded host-memory snapshot; it grants no priority or native authority. */
export interface AdmissionStatus {
  readonly active: BrowserOperation | null;
  readonly waiting: number;
  readonly maximum: number;
  readonly oldestWaitMillis: number | null;
  readonly nativePending: number;
  readonly nativeWaitPending: boolean;
  readonly stopSetupPending: boolean;
}

export interface SessionAdmissionStatus {
  readonly waiting: number;
  readonly maximum: number;
  readonly nativePending: number;
  readonly nativeMaximum: number;
  readonly nativeWaits: number;
  readonly stopSetups: number;
  readonly registry: AdmissionStatus;
}

/** Terminal facts remain readable after this page loses live authority. */
export interface PageStatus {
  readonly identity: Target;
  readonly phase: "open" | "paused" | "closing" | "closed" | "stale";
  readonly containment: Containment;
  readonly admission: AdmissionStatus;
}

export type PageOperations = TargetOperations &
  Pick<
    BrowserSession,
    | "observe"
    | "checkpoint"
    | "controlFacts"
    | "revalidateElement"
    | "clickElement"
    | "fillElement"
    | "selectOption"
    | "fillForm"
    | "hoverElement"
    | "pressElement"
    | "typeElement"
    | "waitFor"
    | "waitForElement"
    | "clickAndWait"
  > & {
    readonly ready: (
      options?: OperationOptions,
    ) => Effect.Effect<Bootstrap.ReadinessOutcome, InitializationError>;
  };

/** Issued live authority for one native frame; navigation keeps the frame and retires its references. */
export interface Frame extends PageOperations, PlanOperations {
  readonly identity: Target;
  readonly status: Effect.Effect<PageStatus>;
  /** Resolve full descriptor intent against the complete current native candidate inventory. */
  readonly resolve: (
    descriptor: DescriptorEncoded,
    options?: ResolveOptions,
  ) => Effect.Effect<ObservedElement, BrowserError>;
  /**
   * Quiet DOM mutation, scroll, root geometry and viewport signals in one pinned document.
   * This does not establish network, animation or business completion.
   */
  readonly settled: (
    request: SettledRequest,
    options?: OperationOptions,
  ) => Effect.Effect<SettledEvidence, BrowserError>;
}

/** Issued live authority for one native page on its original connection. */
export interface Page extends Frame {
  readonly describe: (options?: OperationOptions) => Effect.Effect<PageInfo, BrowserError>;
  readonly listFrames: (
    options?: OperationOptions,
  ) => Effect.Effect<ReadonlyArray<FrameInfo>, BrowserError>;
  readonly frame: (
    info: FrameInfo,
    options?: OperationOptions,
  ) => Effect.Effect<Frame, BrowserError>;
  readonly resizeViewport: (
    viewport: Viewport,
    options?: OperationOptions,
  ) => Effect.Effect<void, BrowserError>;
  /** Reserved fail-fast admission; timeoutMillis bounds joining a close, not admission.queue. */
  readonly close: (options?: OperationOptions) => Effect.Effect<void, BrowserError>;
}

/**
 * A host's decision about one control, made on facts read from the exact node immediately
 * before input. Returning anything but `true`, or throwing, sends nothing and fails `denied`.
 * It is a plain synchronous function on purpose: it runs while the owner's permit is held, where
 * waiting on a model or a network call would stall other ordinary operations on that Page. It is not an atomic
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
 * Leaving its scope unsettled revokes and attempts to close its exact page. Positive closure
 * preserves healthy peers; unconfirmed closure fences the session. Its outcome remains unknown
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
  readonly navigate: (
    request: NavigateRequest,
    options?: OperationOptions,
  ) => Effect.Effect<NavigationResult, BrowserError>;
  /** `navigate`, left in flight: the same single dispatch, completed by the caller. */
  readonly startNavigation: (
    request: StartNavigationRequest,
    options?: OperationOptions,
  ) => Effect.Effect<NavigationOperation, BrowserError, Scope.Scope>;
  readonly readText: (
    request: ReadTextRequest,
    options?: OperationOptions,
  ) => Effect.Effect<TextResult, BrowserError>;
  readonly click: (
    request: ClickRequest,
    options?: OperationOptions,
  ) => Effect.Effect<ActionResult, BrowserError>;
  readonly fill: (
    request: FillRequest,
    options?: OperationOptions,
  ) => Effect.Effect<ActionResult, BrowserError>;
  /** Script in the page: instantaneous, and it raises no wheel event. */
  readonly scroll: (
    request: ScrollRequest,
    options?: OperationOptions,
  ) => Effect.Effect<ActionResult, BrowserError>;
  /** One real pointer move, in main-frame viewport pixels. */
  readonly pointerMove: (
    request: PointerMoveRequest,
    options?: OperationOptions,
  ) => Effect.Effect<InputReceipt, BrowserError>;
  /** Places the pointer on one exact element where it is, or fails `not-visible` unsent. */
  readonly hover: (
    request: HoverRequest,
    options?: OperationOptions,
  ) => Effect.Effect<InputReceipt, BrowserError>;
  /** One real wheel event; the browser decides what under the pointer scrolls. */
  readonly wheel: (
    request: WheelRequest,
    options?: OperationOptions,
  ) => Effect.Effect<InputReceipt, BrowserError>;
  /** One real key stroke to whatever has focus, or fails `not-focused` unsent if `into` lacks it. */
  readonly press: (
    request: PressRequest,
    options?: OperationOptions,
  ) => Effect.Effect<InputReceipt, BrowserError>;
  /** Text as the real key strokes that produce it, under the same focus rule as `press`. */
  readonly type: (
    request: TypeRequest,
    options?: OperationOptions,
  ) => Effect.Effect<InputReceipt, BrowserError>;
  readonly screenshot: (
    request: ScreenshotRequest,
    options?: OperationOptions,
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
 * Use issued Page and Frame objects for complete operations on exact targets. `retain` retains
 * the current selection with stale-on-selection-change semantics; selector-only `pinPage` and
 * `pinFrame` remain adapters over the same owner.
 */
export interface BrowserSession<E = never> extends TargetOperations {
  /** The page acquired on the initial connection, independent of later display selection. */
  readonly initialPage: Page;
  readonly page: (info: PageInfo, options?: OperationOptions) => Effect.Effect<Page, BrowserError>;
  readonly listPages: (
    options?: OperationOptions,
  ) => Effect.Effect<ReadonlyArray<PageInfo>, BrowserError>;
  /** The implementation which owns this live connection. */
  readonly implementation: string;
  /** Copied host-only state, readable without admission in every lifecycle phase. */
  readonly status: Effect.Effect<SessionStatus>;
  /** Bounded native/policy diagnostics. Typed callback causes remain in bindingDiagnostics. */
  readonly diagnostics: Effect.Effect<BrowserDiagnostics>;
  readonly admission: Effect.Effect<SessionAdmissionStatus>;
  /** Close this scope and require its own ownership-specific cleanup evidence. */
  readonly closeChecked: Effect.Effect<void, BrowserError>;
  /** First fail-session callback cause, preserving the consumer's error type on the host. */
  readonly failure: Effect.Effect<never, E | InitializationError>;
  /** Bounded host-only evidence; consumer causes are never projected into a page reply. */
  readonly bindingDiagnostics: Effect.Effect<Bootstrap.BindingDiagnostics<E>>;
  /** Resolve, validate and retain the selection under owner admission. */
  readonly retain: (options?: OperationOptions) => Effect.Effect<RetainedTarget, BrowserError>;
  readonly target: (options?: OperationOptions) => Effect.Effect<Target, BrowserError>;
  /**
   * The one observation whose nodes later actions may name. `scope: "viewport"` keeps only text
   * and controls that are on screen and reachable, plus bounded choices of visible native
   * selects; the default reads the whole document. It carries no destination, form or field value.
   */
  readonly observe: (
    options?: ObservationOptions,
    operationOptions?: OperationOptions,
  ) => Effect.Effect<Observation, BrowserError>;
  /**
   * Passive evidence for a recorder, with a picture when asked. It issues no references and
   * leaves the observation above exactly as it was. Host-only: it carries control facts.
   */
  readonly checkpoint: (
    options?: CheckpointOptions,
    operationOptions?: OperationOptions,
  ) => Effect.Effect<Checkpoint, BrowserError>;
  /** Host-only facts about one observed control, read from that exact node just now. */
  readonly controlFacts: (
    reference: ObservedElement,
    options?: OperationOptions,
  ) => Effect.Effect<ControlFacts, BrowserError>;
  /**
   * After a page hold, nothing observed on that page may be acted on unchecked. This checks one
   * reference: still attached, and still the control that was inspected. It never searches by
   * selector or label for a substitute, and it sends nothing.
   */
  readonly revalidateElement: (
    reference: ObservedElement,
    options?: OperationOptions,
  ) => Effect.Effect<ObservedElement, BrowserError>;
  readonly clickElement: (
    reference: ObservedElement,
    admission?: ElementAdmission,
    options?: OperationOptions,
  ) => Effect.Effect<ActionResult, BrowserError>;
  readonly fillElement: (
    reference: ObservedElement,
    value: string,
    admission?: ElementAdmission,
    options?: OperationOptions,
  ) => Effect.Effect<ActionResult, BrowserError>;
  /** One selection using this exact select and its issued option element IDs, with fresh checks. */
  readonly selectOption: (
    reference: ObservedElement,
    options: SelectOptions,
    admission?: ElementAdmission,
    operationOptions?: OperationOptions,
  ) => Effect.Effect<ActionResult, BrowserError>;
  readonly hoverElement: (
    reference: ObservedElement,
    admission?: ElementAdmission,
    options?: OperationOptions,
  ) => Effect.Effect<InputReceipt, BrowserError>;
  /** A key stroke sent only if the exact node an observation named already has focus. */
  readonly pressElement: (
    reference: ObservedElement,
    stroke: KeyStroke,
    admission?: ElementAdmission,
    options?: OperationOptions,
  ) => Effect.Effect<InputReceipt, BrowserError>;
  /** Real typing with `fillElement`'s exactness: that node must already have focus. */
  readonly typeElement: (
    reference: ObservedElement,
    text: string,
    admission?: ElementAdmission,
    options?: OperationOptions,
  ) => Effect.Effect<InputReceipt, BrowserError>;
  /**
   * Set several controls of one observation in order, then optionally click one submit control.
   * Every step acts on the exact observed node after the same fresh checks as `fillElement`,
   * except that a control may have become enabled since it was observed, and each is admitted
   * and charged as its own action. The observation stays usable for this form's own steps only;
   * anything else that changes the page still retires it, and the form retires it when it ends.
   * The first refused or uncertain step ends the form. Submit is sent only after every field
   * succeeded and, unless `verify` is false, still holds what its step left there. Fields set
   * before a stop stay set. It fails only when its first step does; otherwise `stopped` says
   * where it ended and why.
   */
  readonly fillForm: (
    request: FillFormRequest,
    admission?: ElementAdmission,
    options?: FillFormOptions,
    operationOptions?: OperationOptions,
  ) => Effect.Effect<FillFormResult, BrowserError>;
  readonly pages: (
    options?: OperationOptions,
  ) => Effect.Effect<ReadonlyArray<PageInfo>, BrowserError>;
  /**
   * One exact page's address and title as they are now, and whether it is selected, without
   * reading every other page as `pages` does. An identity that no longer names an open page
   * fails undispatched.
   */
  readonly describePage: (
    page: PageInfo,
    options?: OperationOptions,
  ) => Effect.Effect<PageInfo, BrowserError>;
  readonly frames: (
    options?: OperationOptions,
  ) => Effect.Effect<ReadonlyArray<FrameInfo>, BrowserError>;
  /** List frames on one exact page without selecting it. */
  readonly framesOf: (
    page: PageInfo,
    options?: OperationOptions,
  ) => Effect.Effect<ReadonlyArray<FrameInfo>, BrowserError>;
  /** Pin the page's main frame without changing the session selection. */
  readonly pinPage: (
    page: PageInfo,
    options?: OperationOptions,
  ) => Effect.Effect<PinnedTarget, BrowserError>;
  /** Pin one frame that currently belongs to the exact page, without changing selection. */
  readonly pinFrame: (
    page: PageInfo,
    frame: FrameInfo,
    options?: OperationOptions,
  ) => Effect.Effect<PinnedTarget, BrowserError>;
  readonly selectPage: (
    page: PageInfo,
    options?: OperationOptions,
  ) => Effect.Effect<void, BrowserError>;
  readonly selectFrame: (
    frameId: string,
    options?: OperationOptions,
  ) => Effect.Effect<void, BrowserError>;
  /**
   * Open a page in its own window, sized like the others, without selecting it, and return that
   * exact page's checked identity. Chromium paints every window, so any page can be pictured
   * and read at speed, not only the one in front. Registry admission fails immediately by default;
   * pass a positive finite admission.queue to wait FIFO within the operation deadline.
   */
  readonly createPage: (options?: OperationOptions) => Effect.Effect<PageInfo, BrowserError>;
  /** Reserved fail-fast admission; timeoutMillis bounds joining a close, not admission.queue. */
  readonly closePage: (
    page: PageInfo,
    options?: OperationOptions,
  ) => Effect.Effect<void, BrowserError>;
  readonly resizeViewport: (
    viewport: Viewport,
    options?: OperationOptions,
  ) => Effect.Effect<void, BrowserError>;
  /**
   * Wait on the original observed node within the host deadline. Hidden includes its detachment;
   * document replacement is stale. Success observes a condition, without authorizing later input.
   */
  readonly waitForElement: (
    request: WaitForElementRequest,
    options?: OperationOptions,
  ) => Effect.Effect<void, BrowserError>;
  readonly waitFor: (
    request: {
      readonly selector: string;
      readonly state: "visible" | "hidden" | "attached" | "detached";
    },
    options?: OperationOptions,
  ) => Effect.Effect<void, BrowserError>;
  /** Navigation observation is registered before the single click dispatch. */
  readonly clickAndWait: (
    request: ClickRequest,
    options?: OperationOptions,
  ) => Effect.Effect<ActionResult, BrowserError>;
  /**
   * Readiness of the current document only. Dependent operations wait for it themselves;
   * this reports it without charging an action, so a caller can decide what to do about a
   * document that predates the registrations.
   */
  readonly ready: (
    options?: OperationOptions,
  ) => Effect.Effect<Bootstrap.ReadinessOutcome, InitializationError>;
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
