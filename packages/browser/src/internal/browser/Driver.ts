import type {
  ControlFacts,
  FrameInfo,
  KeyModifier,
  ObservedControl,
  ObservedElement,
  PageExecutionState,
  PageInfo,
  PageSuspension,
  Viewport,
  ViewportEvidence,
} from "../../BrowserData.ts";
import type { CaptureSize } from "../../CaptureData.ts";
import type { InitializationError } from "../../Errors.ts";
import type { NativeBinding } from "./Bindings.ts";
import type { CompiledBootstrap } from "./Bootstrap.ts";
import type { AdmissionPolicy } from "./Observation.ts";
import type { Invalidation, Ticket } from "./Owner.ts";
import type { NativeInput, NativePoint } from "./Pointer.ts";

/** Private native boundary. Neither this interface nor native objects are public package exports. */
export interface DriverOptions {
  readonly viewport: Viewport;
  readonly initialTargetId?: string;
  readonly newPage?: boolean;
  readonly popupPolicy: "retain" | "close" | "pause";
  readonly dialogPolicy: "dismiss" | "pause";
  readonly maxPages: number;
  readonly preserveViewport?: boolean;
  readonly pageControl?: boolean;
  /** Installed once per connection, before any document this connection creates. */
  readonly bootstrap?: CompiledBootstrap;
  /** Executable callbacks are connection-scoped; they are not serializable launch options. */
  readonly bindings?: ReadonlyArray<NativeBinding>;
  readonly onBindingFault?: (error: InitializationError) => void;
}

/**
 * Readiness of the currently selected document only. `NotReady` is a reportable state rather
 * than a native failure: the document exists, it simply cannot admit dependent work yet.
 */
export type ReadinessState =
  | { readonly _tag: "Ready" }
  | { readonly _tag: "NotApplicable" }
  | { readonly _tag: "RequiresNavigation" }
  | {
      readonly _tag: "NotReady";
      readonly step: string;
      readonly reason: "timeout" | "failed" | "stale";
    };

export interface DriverEvents {
  readonly invalidate: (reason: Invalidation) => void;
  readonly disconnected: () => void;
  readonly pause: () => void;
  readonly fault: () => void;
}

export interface NativeObservation {
  readonly observationId: string;
  readonly scope: "document" | "viewport";
  readonly url: string;
  readonly text: string;
  readonly textTruncated: boolean;
  readonly controls: ReadonlyArray<ObservedControl>;
  readonly controlsTruncated: boolean;
  readonly viewport: ViewportEvidence;
}

/** Passive evidence: no node is kept for it, and the retained observation is untouched. */
export interface NativeCheckpoint {
  readonly url: string;
  readonly text: string;
  readonly textTruncated: boolean;
  readonly controls: ReadonlyArray<ControlFacts>;
  readonly controlsTruncated: boolean;
  readonly viewport: ViewportEvidence;
  readonly picture?: Uint8Array;
  readonly documentChanged: boolean;
}

export interface NativeFrame {
  readonly data: Uint8Array;
  /** Playwright presentation timestamp: Unix epoch milliseconds, not a receipt clock. */
  readonly timestamp: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}

/**
 * A navigation the browser is still performing. `settled` belongs to that one navigation: it
 * resolves when its document reaches DOMContentLoaded and rejects if it fails, times out or is
 * superseded, so a successor reaching the same URL can never complete it.
 */
export interface NativeNavigation {
  readonly pageId: string;
  readonly settled: Promise<string>;
  /**
   * Asks the browser to stop this navigation only while its owner still admits it as current.
   * The driver rechecks `pending` after native setup and immediately before dispatch.
   * Setup reserves capacity synchronously before opening a port. Its retirement callback runs
   * only when setup failed without a port or the actual port close succeeded, never on timeout.
   */
  readonly stop: (
    ticket: Ticket,
    pending: () => boolean,
    onDispatch: () => void,
    retainSetup: () => () => void,
  ) => Promise<"dispatched" | "settled">;
}

export type CaptureInvalidation = "target-changed" | "resized";

export interface CaptureStart {
  readonly receive: (frame: NativeFrame) => void;
  readonly quality: number;
  readonly size?: CaptureSize;
  readonly invalidate: (reason: CaptureInvalidation) => void;
  /**
   * The captured frame's address, reported once in the same turn the watch below is installed,
   * so a navigation is either already in it or arrives afterwards as a new document.
   */
  readonly opened?: (url: string) => void;
  /**
   * Present when the interval follows its page across documents. A main-frame navigation then
   * reports a new document here, with the address it committed, instead of ending the interval.
   */
  readonly document?: (url: string) => void;
}

export interface CaptureSource {
  readonly start: (options: CaptureStart) => Promise<void>;
  readonly stop: () => Promise<void>;
}

export interface CaptureTarget {
  readonly pageId: string;
  readonly targetId: string;
}

export interface CaptureBinding {
  readonly pageId: string;
  readonly targetId: string;
  readonly frameId: string;
  readonly source: CaptureSource;
}

/** Connection-local page/frame identity. Public handles never expose the native objects behind it. */
export interface DriverTarget {
  readonly pageId: string;
  readonly frameId: string;
}

/** Either bytes the caller holds or a path the provider itself reported; never both. */
export type NativeFileSelection =
  | {
      readonly _tag: "Inline";
      readonly name: string;
      readonly mediaType: string;
      readonly bytes: Uint8Array;
    }
  | { readonly _tag: "Remote"; readonly path: string };

export interface Driver {
  readonly pageControl?: {
    readonly state: (page: PageInfo, ticket: Ticket) => Promise<PageExecutionState>;
    readonly suspend: (page: PageInfo, ticket: Ticket) => Promise<PageSuspension>;
    readonly resume: (receipt: PageSuspension, ticket: Ticket) => Promise<void>;
    readonly checkTarget: (target: DriverTarget | undefined, ticket: Ticket) => Promise<void>;
  };
  readonly selected: () => { readonly pageId: string; readonly frameId: string };
  readonly selectedTargetId: () => Promise<string>;
  readonly listPages: (ticket: Ticket) => Promise<ReadonlyArray<PageInfo>>;
  readonly resolvePage: (page: PageInfo, ticket: Ticket) => Promise<DriverTarget>;
  readonly selectPage: (id: string, ticket: Ticket) => Promise<void>;
  readonly newPage: (ticket: Ticket) => Promise<string>;
  readonly closePage: (id: string, ticket: Ticket) => Promise<void>;
  readonly listFrames: (ticket: Ticket, page?: PageInfo) => Promise<ReadonlyArray<FrameInfo>>;
  readonly resolveFrame: (
    page: PageInfo,
    frame: FrameInfo,
    ticket: Ticket,
  ) => Promise<DriverTarget>;
  readonly selectFrame: (id: string, ticket: Ticket) => Promise<void>;
  /** Issued exactly once; returns while the browser is still loading. The only navigator. */
  readonly beginNavigation: (
    url: string,
    timeoutMillis: number,
    ticket: Ticket,
    target?: DriverTarget,
  ) => Promise<NativeNavigation>;
  readonly readText: (
    selector: string | undefined,
    maximumBytes: number,
    ticket: Ticket,
    target?: DriverTarget,
  ) => Promise<string>;
  readonly observe: (
    scope: "document" | "viewport",
    maximumBytes: number,
    controls: number,
    ticket: Ticket,
  ) => Promise<NativeObservation>;
  readonly checkpoint: (
    maximumBytes: number,
    controls: number,
    /** Absent means no picture is taken. */
    pictureBytes: number | undefined,
    ticket: Ticket,
  ) => Promise<NativeCheckpoint>;
  /** Fresh facts from the exact node an observation named. */
  readonly controlFacts: (target: ObservedElement, ticket: Ticket) => Promise<ControlFacts>;
  /** After a hold: is this still the attached control that was inspected? */
  readonly revalidate: (target: ObservedElement, ticket: Ticket) => Promise<void>;
  readonly click: (
    target: string | ObservedElement,
    ticket: Ticket,
    policy?: AdmissionPolicy,
    browserTarget?: DriverTarget,
  ) => Promise<string>;
  readonly fill: (
    target: string | ObservedElement,
    value: string,
    ticket: Ticket,
    policy?: AdmissionPolicy,
    browserTarget?: DriverTarget,
  ) => Promise<string>;
  /** Script in the page. It raises no wheel event, which is what tells it from `wheel`. */
  readonly scroll: (
    deltaX: number,
    deltaY: number,
    ticket: Ticket,
    target?: DriverTarget,
  ) => Promise<string>;
  readonly pointerMove: (
    to: NativePoint,
    ticket: Ticket,
    target?: DriverTarget,
  ) => Promise<NativeInput>;
  readonly hover: (
    target: string | ObservedElement,
    ticket: Ticket,
    policy?: AdmissionPolicy,
    browserTarget?: DriverTarget,
  ) => Promise<NativeInput>;
  readonly wheel: (
    deltaX: number,
    deltaY: number,
    at: NativePoint | undefined,
    ticket: Ticket,
    target?: DriverTarget,
  ) => Promise<NativeInput>;
  /** One key stroke to whatever has focus, or only to `into` if it already has it. */
  readonly press: (
    key: string,
    modifiers: ReadonlyArray<KeyModifier>,
    into: string | ObservedElement | undefined,
    ticket: Ticket,
    policy?: AdmissionPolicy,
    browserTarget?: DriverTarget,
  ) => Promise<NativeInput>;
  readonly type: (
    text: string,
    into: string | ObservedElement | undefined,
    ticket: Ticket,
    policy?: AdmissionPolicy,
    browserTarget?: DriverTarget,
  ) => Promise<NativeInput>;
  readonly screenshot: (
    fullPage: boolean,
    maximumBytes: number,
    ticket: Ticket,
    target?: DriverTarget,
  ) => Promise<Uint8Array>;
  readonly resize: (viewport: Viewport, ticket: Ticket) => Promise<void>;
  readonly waitFor: (
    selector: string,
    state: "visible" | "hidden" | "attached" | "detached",
    ticket: Ticket,
  ) => Promise<void>;
  readonly clickAndWait: (target: string | ObservedElement, ticket: Ticket) => Promise<string>;
  readonly clickForDownload: (
    target: string | ObservedElement,
    ticket: Ticket,
  ) => Promise<{
    readonly downloadId: string;
    readonly filename: string;
    readonly state: "completed" | "failed";
  }>;
  readonly selectFiles: (
    target: string | ObservedElement,
    files: ReadonlyArray<NativeFileSelection>,
    ticket: Ticket,
  ) => Promise<string>;
  /** The chooser observer is registered before the single click dispatch that opens it. */
  readonly clickForFileSelection: (
    target: string | ObservedElement,
    files: ReadonlyArray<NativeFileSelection>,
    ticket: Ticket,
  ) => Promise<string>;
  /** Evaluated once per document; a later document never inherits an earlier one's result. */
  readonly documentReadiness: (ticket: Ticket, target?: DriverTarget) => Promise<ReadinessState>;
  readonly dismissDialogs: (ticket: Ticket) => Promise<void>;
  readonly capture: (target?: CaptureTarget) => Promise<CaptureBinding>;
  readonly invalidateObservation: () => void;
  /** Synchronous retirement precedes canceling consumer callback fibers. */
  readonly fenceInitialization?: () => void;
  /** Remove this connection's registrations while its native connection is still usable. */
  readonly disposeInitialization?: () => Promise<void>;
  /** Closes this client connection, not an assertion about remote provider termination. */
  readonly disconnect: () => Promise<void>;
}
