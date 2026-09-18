import { Effect, type Scope } from "effect";
import type { BrowserbaseSession } from "./InteractiveBrowser.ts";
import { BrowserbaseError } from "./Types.ts";
import { captureParent } from "./internal/Association.ts";
import { startCapture } from "./internal/Capture.ts";
import type { CaptureInterval, CaptureOptions } from "./internal/CaptureTypes.ts";

export { CaptureSummary } from "./internal/CaptureTypes.ts";
export type { CaptureInterval, CaptureOptions, CapturedFrame } from "./internal/CaptureTypes.ts";

/** Capture the same selected remote page. The package owns no encoder, filesystem, or audio source. */
export const start = (
  session: BrowserbaseSession,
  options: CaptureOptions = {},
): Effect.Effect<CaptureInterval, BrowserbaseError, Scope.Scope> => Effect.suspend(() => {
  const parent = captureParent(session);
  return parent === undefined ? Effect.fail(new BrowserbaseError({ operation: "capture", reason: "closed" })) : startCapture(parent, options);
});
