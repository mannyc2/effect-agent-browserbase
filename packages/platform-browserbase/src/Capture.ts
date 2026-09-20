import { Effect, Schema, type Scope } from "effect";

import type { BrowserbaseSession } from "./InteractiveBrowser.ts";
import { captureParent } from "./internal/Association.ts";
import { startCapture } from "./internal/Capture.ts";
import type { CaptureInterval, CaptureOptions } from "./internal/CaptureTypes.ts";
import { BrowserbaseError, PageInfo } from "./Types.ts";

export {
  CapturedFrame,
  CaptureOptions,
  CaptureSize,
  CaptureSummary,
} from "./internal/CaptureTypes.ts";

export type { CaptureInterval } from "./internal/CaptureTypes.ts";

/**
 * Capture one remote page independently of the session's selected page.
 *
 * Requires the exact live session returned by the host; copying a session object or decoding
 * a durable reference cannot copy its capture authority. The private owner is not frame data.
 * `CapturedFrame` and `CaptureOptions` are Schema values as well as structural types. Frame
 * decoding checks binary/metadata fields, not the complete JPEG bitstream or target authority,
 * and does not copy bytes. Options decoding preserves omissions; admission applies defaults.
 * `CaptureInterval` remains a live scoped capability, not a schema or JSON/Tool value.
 */
export const start = (
  session: BrowserbaseSession,
  options: CaptureOptions = {},
): Effect.Effect<CaptureInterval, BrowserbaseError, Scope.Scope> =>
  Effect.suspend(() => {
    const parent = captureParent(session);

    if (parent === undefined)
      return Effect.fail(BrowserbaseError.make({ operation: "capture", reason: "closed" }));
    if (options.target === undefined) return startCapture(parent, options);

    return Schema.decodeEffect(PageInfo)(options.target, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() =>
        BrowserbaseError.make({
          operation: "capture",
          reason: "configuration",
          outcome: "undispatched",
        }),
      ),
      Effect.flatMap((target) => startCapture(parent, { ...options, target })),
    );
  });
