/** Viewport evidence and bounded foreign-picture filtering for one capture. */
import { Clock, Duration, Effect, Queue } from "effect";

import type { BrowserError } from "../../BrowserError.ts";
import { monotonicMillis } from "../../Clock.ts";
import type { Frame } from "../../Frame.ts";

export interface Size {
  readonly width: number;
  readonly height: number;
}

interface Options {
  readonly clock: Clock.Clock;
  readonly viewport: Effect.Effect<Size, BrowserError>;
}
const deadline = Duration.seconds(2);

interface Held {
  readonly frame: Frame;
  readonly timestamp: number;
}

/** Consecutive frames of one device size other than the expected one, oldest first. */
interface Run {
  readonly device: Size;
  /** When its first frame arrived, on the owner's monotonic clock. */
  readonly since: number;
  readonly frames: Array<Held>;
}

// Device sizes can be fractional at some scale factors; the page reports whole pixels.
const sameSize = (left: Size, right: Size) =>
  Math.abs(left.width - right.width) < 1 && Math.abs(left.height - right.height) < 1;

// A frame is its device scaled to fit, so it keeps the device's shape to within a pixel a side.
const sameShape = (image: Size, device: Size) =>
  Math.abs(image.width * device.height - image.height * device.width) <
  device.width + device.height;

// Another capture's frames last only as long as it does; a run of frames that lasts longer is
// the page's own.
const outlasting = Duration.seconds(1);

// A page too busy to report its viewport in time reads as null.
export const readViewport = (options: Options) =>
  options.viewport.pipe(
    Effect.interruptible,
    Effect.timeoutOrElse({ duration: deadline, orElse: () => Effect.succeed(null) }),
    Effect.orElseSucceed(() => null),
    Effect.provideService(Clock.Clock, options.clock),
  );

/**
 * Keeps other captures' frames from readers. A clipped or scaled screenshot of the page, taken
 * from any session, draws frames into its running screencast without resizing the page, until
 * Chromium returns to the page's size. Either their picture has another shape than their device,
 * and they are dropped, or their device has another size than the page's frames.
 *
 * A frame of the expected device size goes to readers at once and drops any run of frames of
 * another size before it, as another capture's. A run waits, in order, until the page reports a
 * viewport of its size or until it outlasts any capture: then it was a real resize, so it goes to
 * readers and its size is expected. The page's report only shortens the wait, so a page too busy
 * to answer, or one measuring in other units as under browser zoom, never stalls the stream.
 */
export const sizeFilter = (
  options: Options,
  deliver: (frame: Frame, timestamp: number) => void,
  drop: (frames: number) => void,
  resized: (size: Size) => void,
) =>
  Effect.gen(function* () {
    // Until a capture reads its viewport or delivers a frame, its first frame stands in.
    let expected: Size | null = null;
    let run: Run | undefined;
    // Wakes the decider for a new run or an ended one; wakes while it is busy coalesce.
    const wake = yield* Queue.sliding<void>(1);

    const end = () => {
      if (run === undefined) return;
      drop(run.frames.length);
      run = undefined;
      Queue.offerUnsafe(wake, undefined);
    };

    const now = () => monotonicMillis(options.clock);

    const adopt = (adopted: Run) => {
      run = undefined;
      expected = adopted.device;
      resized(adopted.device);
      for (const held of adopted.frames) deliver(held.frame, held.timestamp);
    };

    const decide: Effect.Effect<void> = Effect.suspend(() => {
      const deciding = run;

      if (deciding === undefined) return Effect.void;

      return readViewport(options).pipe(
        Effect.flatMap((viewport) => {
          if (run !== deciding) return decide;
          if (viewport !== null && sameSize(viewport, deciding.device))
            return Effect.sync(() => adopt(deciding));

          return outlast(deciding);
        }),
      );
    });

    // Waits until the run outlasts any capture, unless a newer frame decides it first.
    const outlast = (waiting: Run): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (run !== waiting) return decide;
        const remaining = waiting.since + Duration.toMillis(outlasting) - now();

        if (remaining <= 0) return Effect.sync(() => adopt(waiting));

        return Effect.sleep(Duration.millis(remaining)).pipe(
          Effect.provideService(Clock.Clock, options.clock),
          Effect.race(Queue.take(wake)),
          Effect.andThen(outlast(waiting)),
        );
      });

    yield* Queue.take(wake).pipe(Effect.andThen(decide), Effect.forever, Effect.forkScoped);

    return {
      /** Drops the frames still waiting; their capture has stopped. */
      end,
      /** A new capture expects the viewport it read, if any. */
      restart: (viewport: Size | null) => {
        end();
        expected = viewport;
      },
      /** Whether a frame of this device size shows the page, as far as the capture knows. */
      offer: (frame: Frame, timestamp: number, image: Size | undefined, device: Size) => {
        if (image !== undefined && !sameShape(image, device)) {
          drop(1);

          return;
        }
        expected ??= device;
        if (sameSize(device, expected)) {
          end();
          deliver(frame, timestamp);

          return;
        }
        if (run !== undefined && !sameSize(run.device, device)) end();
        if (run === undefined) {
          run = { device, since: now(), frames: [] };
          Queue.offerUnsafe(wake, undefined);
        }
        run.frames.push({ frame, timestamp });
        if (run.frames.length > 16) {
          run.frames.shift();
          drop(1);
        }
      },
    };
  });
