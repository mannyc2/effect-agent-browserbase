import type { FrameInfo, ObservedControl, ObservedElement, PageInfo, Viewport } from "../Types.ts";
import type { Invalidation, Ticket } from "./Owner.ts";

/** Private native boundary. Neither this interface nor native objects are public package exports. */
export interface DriverOptions {
  readonly viewport: Viewport;
  readonly initialTargetId?: string;
  readonly newPage?: boolean;
  readonly popupPolicy: "retain" | "close" | "pause";
  readonly dialogPolicy: "dismiss" | "pause";
  readonly maxPages: number;
  readonly preserveViewport?: boolean;
}

export interface DriverEvents {
  readonly invalidate: (reason: Invalidation) => void;
  readonly captureInvalidated: (
    pageId: string,
    reason: Extract<Invalidation, "target-changed" | "resized">,
  ) => void;
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

export interface CaptureSource {
  readonly start: (callback: (frame: NativeFrame) => void, quality: number) => Promise<void>;
  readonly stop: () => Promise<void>;
}

export interface Driver {
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
  readonly scroll: (deltaX: number, deltaY: number, ticket: Ticket) => Promise<string>;
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
  readonly dismissDialogs: (ticket: Ticket) => Promise<void>;
  readonly capture: (
    target: PageInfo | undefined,
    ticket: Ticket,
  ) => Promise<{
    readonly source: CaptureSource;
    readonly pageId: string;
    readonly frameId: string;
  }>;
  readonly invalidateObservation: () => void;
  /** Closes this client connection, not an assertion about remote provider termination. */
  readonly disconnect: () => Promise<void>;
}
