import type { CaptureSize } from "../../CaptureData.ts";
import type { BrowserError } from "../../Errors.ts";

/** Capture transport data has no dependency on a native browser client. */
export interface CaptureFrame {
  readonly data: Uint8Array;
  /** Source presentation timestamp: Unix epoch milliseconds, not a receipt clock. */
  readonly timestamp: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}

export interface CaptureStart {
  readonly receive: (frame: CaptureFrame) => void;
  readonly quality: number;
  readonly size?: CaptureSize;
  readonly invalidate: (reason: "target-changed" | "target-closed" | "resized") => void;
  /** Ends only this interval when its capture transport fails. */
  readonly fail: (error: BrowserError) => void;
  /**
   * The captured frame's address, reported once in the same turn the watch below is installed,
   * so a navigation is either already in it or arrives afterwards as a new document.
   */
  readonly opened?: (url: string) => void;
  /**
   * Present when the interval follows its page across documents. A main-frame navigation then
   * reports a new document here, with the address it committed, instead of ending the interval.
   */
  readonly document?: (url: string, sameDocument: boolean) => void;
}

export interface CaptureTarget {
  readonly pageId: string;
  readonly targetId: string;
}
