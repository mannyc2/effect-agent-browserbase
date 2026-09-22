import { Effect, Schema, type Scope } from "effect";

import type { BrowserSession } from "./Browser.ts";
import { PageInfo } from "./BrowserData.ts";
import { BrowserError } from "./Errors.ts";
import { captureParent } from "./internal/browser/Association.ts";
import { startCapture } from "./internal/capture/Capture.ts";
import type { CaptureInterval, CaptureOptions } from "./internal/capture/CaptureTypes.ts";

export {
  CapturedFrame,
  CaptureOptions,
  CaptureSize,
  CaptureSnapshot,
  CaptureSummary,
} from "./internal/capture/CaptureTypes.ts";

export type { CaptureInterval } from "./internal/capture/CaptureTypes.ts";

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
export const start = <E>(
  session: BrowserSession<E>,
  options: CaptureOptions = {},
): Effect.Effect<CaptureInterval, BrowserError, Scope.Scope> =>
  Effect.suspend(() => {
    const parent = captureParent(session);

    if (parent === undefined)
      return Effect.fail(BrowserError.make({ operation: "capture", reason: "closed" }));
    if (options.target === undefined) return startCapture(parent, options);

    return Schema.decodeEffect(PageInfo)(options.target, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() =>
        BrowserError.make({
          operation: "capture",
          reason: "configuration",
          outcome: "undispatched",
        }),
      ),
      Effect.flatMap((target) => startCapture(parent, { ...options, target })),
    );
  });
