import type {
  FrameInfo,
  ObservedControl,
  ObservedElement,
  PageExecutionState,
  PageInfo,
  PageSuspension,
  Viewport,
} from "../../BrowserData.ts";
import type { InitializationError } from "../../Errors.ts";
import type { CaptureSize } from "../capture/CaptureTypes.ts";
import type { NativeBinding } from "./Bindings.ts";
import type { CompiledBootstrap } from "./Bootstrap.ts";
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
  readonly url: string;
  readonly text: string;
  readonly textTruncated: boolean;
  readonly controls: ReadonlyArray<ObservedControl>;
  readonly controlsTruncated: boolean;
}

export interface NativeFrame {
  readonly data: Uint8Array;
  /** Playwright presentation timestamp: Unix epoch milliseconds, not a receipt clock. */
  readonly timestamp: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}

export type CaptureInvalidation = "target-changed" | "resized";

export interface CaptureSource {
  readonly start: (
    callback: (frame: NativeFrame) => void,
    quality: number,
    invalidate: (reason: CaptureInvalidation) => void,
    size?: CaptureSize,
  ) => Promise<void>;
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
    readonly checkSelected: (ticket: Ticket) => Promise<void>;
  };
  readonly selected: () => { readonly pageId: string; readonly frameId: string };
  readonly selectedTargetId: () => Promise<string>;
  readonly listPages: (ticket: Ticket) => Promise<ReadonlyArray<PageInfo>>;
  readonly selectPage: (id: string, ticket: Ticket) => Promise<void>;
  readonly newPage: (ticket: Ticket) => Promise<string>;
  readonly closePage: (id: string, ticket: Ticket) => Promise<void>;
  readonly listFrames: (ticket: Ticket) => Promise<ReadonlyArray<FrameInfo>>;
  readonly selectFrame: (id: string, ticket: Ticket) => Promise<void>;
  readonly navigate: (url: string, ticket: Ticket) => Promise<string>;
  readonly readText: (
    selector: string | undefined,
    maximumBytes: number,
    ticket: Ticket,
  ) => Promise<string>;
  readonly observe: (
    maximumBytes: number,
    controls: number,
    ticket: Ticket,
  ) => Promise<NativeObservation>;
  readonly click: (target: string | ObservedElement, ticket: Ticket) => Promise<string>;
  readonly fill: (
    target: string | ObservedElement,
    value: string,
    ticket: Ticket,
  ) => Promise<string>;
  /** Script in the page. It raises no wheel event, which is what tells it from `wheel`. */
  readonly scroll: (deltaX: number, deltaY: number, ticket: Ticket) => Promise<string>;
  readonly pointerMove: (to: NativePoint, ticket: Ticket) => Promise<NativeInput>;
  readonly hover: (target: string | ObservedElement, ticket: Ticket) => Promise<NativeInput>;
  readonly wheel: (
    deltaX: number,
    deltaY: number,
    at: NativePoint | undefined,
    ticket: Ticket,
  ) => Promise<NativeInput>;
  readonly screenshot: (
    fullPage: boolean,
    maximumBytes: number,
    ticket: Ticket,
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
  readonly documentReadiness: (ticket: Ticket) => Promise<ReadinessState>;
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
