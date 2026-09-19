import { Effect, type Scope } from "effect";

import type { BrowserbaseSession } from "./InteractiveBrowser.ts";
import { captureParent } from "./internal/Association.ts";
import { startCapture } from "./internal/Capture.ts";
import type { CaptureInterval, CaptureOptions } from "./internal/CaptureTypes.ts";
import { BrowserbaseError } from "./Types.ts";

export { CaptureSummary } from "./internal/CaptureTypes.ts";
export type { CaptureInterval, CaptureOptions, CapturedFrame } from "./internal/CaptureTypes.ts";

/**
 * Capture an explicit session page, or the selected page when target is omitted.
 * No encoder, filesystem, or audio source is owned.
 */
export const start = (
  session: BrowserbaseSession,
  options: CaptureOptions = {},
): Effect.Effect<CaptureInterval, BrowserbaseError, Scope.Scope> =>
  Effect.suspend(() => {
    const parent = captureParent(session);

    return parent === undefined
      ? Effect.fail(BrowserbaseError.make({ operation: "capture", reason: "closed" }))
      : startCapture(parent, options);
  });
