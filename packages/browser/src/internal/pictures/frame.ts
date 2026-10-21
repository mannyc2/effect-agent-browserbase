/** Native frame timing and monotonic evidence across clock recalibration. */
import type { Clock } from "effect";

import { type Estimate, monotonicMillis, toHostTime, uncertaintyAt } from "../../Clock.ts";
import { BrowserPaint, Frame } from "../../Frame.ts";
import type { NativeFrame, Transport } from "./transport.ts";

/**
 * A native frame as readers get it: its picture's size, else the capture's or its device's, and
 * its paint mapped by the browser's newest estimate, which may be older than the frame and says
 * less about later paint.
 */
export const timed = (
  options: {
    readonly id: string;
    readonly clock: Clock.Clock;
    readonly imageSize: (
      data: Uint8Array,
    ) => { readonly width: number; readonly height: number } | undefined;
    readonly latest: () => Estimate | undefined;
  },
  native: NativeFrame,
  timestamp: number,
  generation: {
    readonly id: number;
    readonly sequence: number;
    readonly calibration: Estimate;
    readonly size: { readonly width: number; readonly height: number } | null;
    readonly transport: Pick<Transport, "frameTag">;
  },
  data: Uint8Array,
) => {
  const image = options.imageSize(data);
  const device = { width: native.metadata.deviceWidth, height: native.metadata.deviceHeight };
  const size = image ?? generation.size ?? device;
  const estimate = options.latest() ?? generation.calibration;
  const hostTime = toHostTime(estimate, timestamp);

  const frame = new Frame({
    page: options.id,
    capture: { generation: generation.id, sequence: generation.sequence },
    data,
    timing: new BrowserPaint({
      timestamp,
      hostTime,
      uncertaintyMillis: uncertaintyAt(estimate, hostTime),
    }),
    receivedAt: monotonicMillis(options.clock),
    width: size.width,
    height: size.height,
    ...generation.transport.frameTag(),
  });

  return { frame, image, device };
};

/** Clamp only the estimate's centre, widening its interval by the correction. */
export const orderedFrame = (frame: Frame, previous: number): Frame =>
  frame.hostTime < previous && frame.timing._tag === "BrowserPaint"
    ? new Frame({
        ...frame,
        timing: new BrowserPaint({
          ...frame.timing,
          hostTime: previous,
          uncertaintyMillis: frame.timing.uncertaintyMillis + previous - frame.hostTime,
        }),
      })
    : frame;
