/**
 * One CDP screencast per page, with bounded transport replies and per-reader loss accounting.
 * Native callbacks own synchronous bookkeeping; the page scope owns startup and teardown.
 */
import { Clock, Duration, Effect, Exit, Option, Queue, Semaphore, Stream } from "effect";
import type { CDPSession } from "playwright-core";

import { BrowserError, InvalidRequest } from "../../BrowserError.ts";
import { BrowserPaint, CaptureStats, Frame, type ScreencastOptions } from "../../Frame.ts";
import { type Estimate, toHostTime, uncertaintyAt } from "./clock.ts";

interface Size {
  readonly width: number;
  readonly height: number;
}

interface Options {
  readonly id: string;
  /** The page's own session, for the capture's events. */
  readonly cdp: CDPSession;
  /** Its calls, counted into the operation that sends them. */
  readonly send: CDPSession["send"];
  readonly clock: Clock.Clock;
  readonly calibrate: Effect.Effect<Estimate, BrowserError>;
  /** How long frames are kept, measured back from the newest. */
  readonly frameHistory: Duration.Duration;
  /** The viewport in CSS pixels; a capture is scaled to fit it, as screenshots are. */
  readonly viewport: Effect.Effect<Size, BrowserError>;
  readonly imageSize: (data: Uint8Array) => Size | undefined;
  readonly error: (cause: unknown) => BrowserError;
  readonly onClose: (callback: () => void) => () => void;
}

type Envelope =
  | { readonly _tag: "Frame"; readonly sequence: number; readonly frame: Frame }
  | { readonly _tag: "Failure"; readonly error: BrowserError };

interface NativeFrame {
  readonly data: string;
  readonly metadata: {
    readonly timestamp?: number;
    readonly deviceWidth: number;
    readonly deviceHeight: number;
  };
  readonly sessionId: number;
}

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

interface Generation {
  readonly subscribers: Set<Queue.Queue<Envelope>>;
  readonly calibration: Estimate;
  /** The native capture's settings; every reader of this generation shares them. */
  readonly quality: number;
  readonly size: Size | null;
  readonly onFrame: (frame: NativeFrame) => void;
  accepting: boolean;
  predecessor: number | undefined;
  failure: BrowserError | undefined;
  stopReply: Promise<void> | undefined;
}

export interface Controller {
  readonly stream: (options?: ScreencastOptions) => Stream.Stream<Frame, BrowserError>;
  readonly latest: Effect.Effect<Option.Option<Frame>>;
  readonly recent: Effect.Effect<ReadonlyArray<Frame>>;
  /** Lifetime counts, or those of the latest `windowMillis`, at most `countsKept`. */
  readonly stats: (windowMillis?: number) => Effect.Effect<CaptureStats>;
  readonly active: Effect.Effect<boolean>;
  /** Run a clipped or scaled picture of the page, keeping what it draws out of the capture. */
  readonly excluding: <A, E, R>(picture: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

/** When the library took a clipped picture: from its call to its reply, in host milliseconds. */
interface Excluded {
  readonly from: number;
  until: number;
}

const replyCapacity = 32;
const subscriberCapacity = 16;
const deadline = Duration.seconds(2);

// Device sizes can be fractional at some scale factors; the page reports whole pixels.
const sameSize = (left: Size, right: Size) =>
  Math.abs(left.width - right.width) < 1 && Math.abs(left.height - right.height) < 1;

// A frame is its device scaled to fit, so it keeps the device's shape to within a pixel a side.
const sameShape = (image: Size, device: Size) =>
  Math.abs(image.width * device.height - image.height * device.width) <
  device.width + device.height;

// Paint-time gaps between consecutive delivered frames.
const paintGaps = () => {
  let count = 0;
  let totalMillis = 0;
  let minMillis: number | null = null;
  let maxMillis: number | null = null;
  let lastMillis: number | null = null;

  return {
    add: (gap: number) => {
      count++;
      totalMillis += gap;
      minMillis = minMillis === null ? gap : Math.min(minMillis, gap);
      maxMillis = maxMillis === null ? gap : Math.max(maxMillis, gap);
      lastMillis = gap;
    },
    snapshot: () => ({ count, totalMillis, minMillis, maxMillis, lastMillis }),
  };
};

type Counted =
  | "received"
  | "accepted"
  | "late"
  | "missingTimestamp"
  | "foreignSize"
  | "duringPictures"
  | "lost";

const none = (): Record<Counted, number> => ({
  received: 0,
  accepted: 0,
  late: 0,
  missingTimestamp: 0,
  foreignSize: 0,
  duringPictures: 0,
  lost: 0,
});

/** How far back a window of capture counts can reach. */
export const countsKept = Duration.minutes(1);

/**
 * A capture's counts and paint gaps over its page's life, and each with when it happened on the
 * owner's clock for the latest minute, so a window of them can be read.
 */
const tally = (now: () => number) => {
  const totals = none();
  const gaps = paintGaps();

  let recent: Array<{
    readonly at: number;
    readonly counted: Counted | "gap";
    readonly n: number;
  }> = [];

  let oldest = 0;

  const note = (counted: Counted | "gap", n: number) => {
    const at = now();

    recent.push({ at, counted, n });
    while ((recent[oldest]?.at ?? at) < at - Duration.toMillis(countsKept)) oldest++;
    // Shed what is out of reach once it is half the log.
    if (oldest > recent.length / 2) {
      recent = recent.slice(oldest);
      oldest = 0;
    }
  };

  return {
    count: (counted: Counted, n = 1) => {
      totals[counted] += n;
      note(counted, n);
    },
    gap: (millis: number) => {
      gaps.add(millis);
      note("gap", millis);
    },
    /** Lifetime counts, or those of the latest `windowMillis`, at most a minute. */
    read: (windowMillis?: number) => {
      if (windowMillis === undefined) return { ...totals, gaps: gaps.snapshot() };
      const counts = none();
      const windowed = paintGaps();
      const since = now() - windowMillis;

      for (const { at, counted, n } of recent.slice(oldest)) {
        if (at < since) continue;
        if (counted === "gap") windowed.add(n);
        else counts[counted] += n;
      }

      return { ...counts, gaps: windowed.snapshot() };
    },
  };
};

// Another capture's frames last only as long as it does; a run of frames that lasts longer is
// the page's own.
const outlasting = Duration.seconds(1);

// No frame painted during a picture arrives this long after it.
const excludedFor = Duration.seconds(10);

// Every frame of a crop is painted before Chromium answers the picture, yet each test of it can
// land past the reply: its stamp, because Chromium stamps frames on another clock than the one the
// calibration reads (2 to 3 ms late on an idle machine here), and its arrival, because a frame is
// encoded after it is painted (3 to 6 ms). A frame is kept only when both land this long after.
const settling = Duration.millis(50);

/**
 * Chromium draws the library's own clipped pictures into the running screencast, with the page's
 * device size and shape when the crop has the viewport's proportions, and nothing in a frame tells
 * it apart. A frame painted, or arriving, while one is taken is left out, the page's own included.
 */
const pictureWindows = (now: () => number) => {
  let windows: ReadonlyArray<Excluded> = [];

  return {
    painted: ({ hostTime, timing, receivedAt }: Frame) =>
      windows.some((window) => {
        const until = window.until + Duration.toMillis(settling);

        return (
          (hostTime + timing.uncertaintyMillis >= window.from &&
            hostTime - timing.uncertaintyMillis <= until) ||
          (receivedAt >= window.from && receivedAt <= until)
        );
      }),
    excluding: <A, E, R>(picture: Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const window = { from: now(), until: Number.POSITIVE_INFINITY };
          const since = window.from - Duration.toMillis(excludedFor);

          windows = [...windows.filter((kept) => kept.until > since), window];

          return window;
        }),
        () => picture,
        (window) =>
          Effect.sync(() => {
            window.until = now();
          }),
      ),
  };
};

// A page too busy to report its viewport in time reads as null.
const readViewport = (options: Options) =>
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
const sizeFilter = (
  options: Options,
  deliver: (frame: Frame, timestamp: number) => void,
  drop: (frames: number) => void,
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

    const now = () => Number(options.clock.monotonicTimeNanosUnsafe()) / 1e6;

    const adopt = (adopted: Run) => {
      run = undefined;
      expected = adopted.device;
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
        if (run.frames.length > subscriberCapacity) {
          run.frames.shift();
          drop(1);
        }
      },
    };
  });

export const make = (options: Options) =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1);
    const replies = new Set<Promise<void>>();
    let generation: Generation | undefined;
    let closed = false;
    // The latest stop whose reply has not settled. A new capture waits for it rather than
    // assuming it was lost; it is never submitted again.
    let unsettledStop: Promise<void> | undefined;
    let latest = Option.none<Frame>();
    let history: ReadonlyArray<Frame> = [];
    const keepMillis = Duration.toMillis(options.frameHistory);
    const now = () => Number(options.clock.monotonicTimeNanosUnsafe()) / 1e6;
    const counts = tally(now);
    // Frames delivered, which number them so that a reader can tell what it missed.
    let delivered = 0;
    const pictures = pictureWindows(now);

    // Frames that show the page go to the running capture's readers.
    const deliver = (frame: Frame, timestamp: number) => {
      const current = generation;

      if (current === undefined) return;
      // Held frames are checked again: frames encoded out of order are dropped, never reordered.
      if (current.predecessor !== undefined && timestamp <= current.predecessor)
        return counts.count("late");
      if (current.predecessor !== undefined) counts.gap(timestamp - current.predecessor);
      current.predecessor = timestamp;
      delivered++;
      counts.count("accepted");
      latest = Option.some(frame);
      history = [...history.filter((kept) => kept.hostTime >= frame.hostTime - keepMillis), frame];
      for (const subscriber of current.subscribers)
        Queue.offerUnsafe(subscriber, { _tag: "Frame", sequence: delivered, frame });
    };

    const sizes = yield* sizeFilter(options, deliver, (frames) =>
      counts.count("foreignSize", frames),
    );

    const notifyFailure = (current: Generation, failure: BrowserError) => {
      if (current.failure !== undefined) return;
      current.failure = failure;
      for (const subscriber of current.subscribers)
        Queue.offerUnsafe(subscriber, { _tag: "Failure", error: failure });
    };

    const stop = (current: Generation) => {
      if (!current.accepting) return;
      current.accepting = false;
      sizes.end();
      options.cdp.off("Page.screencastFrame", current.onFrame);
      let response: Promise<unknown>;

      try {
        response = options.send("Page.stopScreencast");
      } catch (cause) {
        notifyFailure(current, options.error(cause));

        return;
      }

      // Attach both handlers in the callback turn. Even a caller that leaves immediately never
      // abandons a rejected native reply, and an uncertain stop is never submitted twice.
      const reply = response.then(
        () => undefined,
        (cause: unknown) => {
          notifyFailure(current, options.error(cause));
        },
      );

      current.stopReply = reply;
      unsettledStop = reply;
      void reply.then(() => {
        if (unsettledStop === reply) unsettledStop = undefined;
      });
    };

    const fail = (current: Generation, failure: BrowserError) => {
      notifyFailure(current, failure);
      stop(current);
    };

    const removeCloseListener = yield* Effect.sync(() =>
      options.onClose(() => {
        closed = true;
        if (generation !== undefined)
          fail(generation, options.error(new Error("Target page has been closed")));
      }),
    );

    const stopDeadline = () => options.error(new Error("screencast stop exceeded its deadline"));

    const awaitStop = (current: Generation) =>
      Effect.suspend(() =>
        current.stopReply === undefined
          ? Effect.void
          : Effect.promise(() => current.stopReply ?? Promise.resolve()).pipe(
              Effect.interruptible,
              Effect.timeoutOrElse({
                duration: deadline,
                orElse: () => Effect.sync(() => notifyFailure(current, stopDeadline())),
              }),
            ),
      ).pipe(Effect.provideService(Clock.Clock, options.clock));

    // A late stop only delays the next capture; once its reply settles, capture can start again.
    const awaitPreviousStop = Effect.suspend(() =>
      unsettledStop === undefined
        ? Effect.void
        : Effect.promise(() => unsettledStop ?? Promise.resolve()).pipe(
            Effect.interruptible,
            Effect.timeoutOrElse({
              duration: deadline,
              orElse: () => Effect.fail(stopDeadline()),
            }),
          ),
    ).pipe(Effect.provideService(Clock.Clock, options.clock));

    const release = (current: Generation, subscription: Queue.Queue<Envelope>) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          current.subscribers.delete(subscription);
          yield* Queue.shutdown(subscription);
          if (current.subscribers.size !== 0) return;
          yield* Effect.sync(() => stop(current));
          yield* awaitStop(current);
          if (generation === current) generation = undefined;
        }),
      );

    const acquire = (screencast: ScreencastOptions) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          if (closed) return yield* options.error(new Error("Target page has been closed"));
          let current = generation;
          const starting = current === undefined;

          if (current === undefined) {
            yield* awaitPreviousStop;
            const calibration = yield* options.calibrate.pipe(Effect.interruptible);

            // A page too busy to report its viewport is still captured, at device size.
            const viewport = screencast.size === undefined ? yield* readViewport(options) : null;
            const size = screencast.size ?? viewport;

            if (closed) return yield* options.error(new Error("Target page has been closed"));

            const created: Generation = {
              subscribers: new Set(),
              calibration,
              quality: screencast.quality ?? 80,
              size,
              accepting: true,
              predecessor: undefined,
              failure: undefined,
              stopReply: undefined,
              onFrame: (native) => {
                if (!created.accepting) return;
                counts.count("received");
                if (replies.size >= replyCapacity) {
                  fail(
                    created,
                    options.error(new Error("screencast acknowledgement capacity exceeded")),
                  );

                  return;
                }
                let response: Promise<unknown>;

                try {
                  response = options.send("Page.screencastFrameAck", {
                    sessionId: native.sessionId,
                  });
                } catch (cause) {
                  fail(created, options.error(cause));

                  return;
                }

                const reply = response.then(
                  () => {
                    replies.delete(reply);
                  },
                  (cause: unknown) => {
                    replies.delete(reply);
                    if (created.accepting) fail(created, options.error(cause));
                  },
                );

                replies.add(reply);
                const browserSeconds = native.metadata.timestamp;
                const timestamp = browserSeconds === undefined ? Number.NaN : browserSeconds * 1000;

                if (!Number.isFinite(timestamp)) return counts.count("missingTimestamp");
                if (created.predecessor !== undefined && timestamp <= created.predecessor)
                  return counts.count("late");
                const receivedAt = now();
                const data = Buffer.from(native.data, "base64");
                const image = options.imageSize(data);
                const { deviceWidth, deviceHeight } = native.metadata;
                const device = { width: deviceWidth, height: deviceHeight };
                const size = image ?? created.size ?? device;

                const hostTime = toHostTime(created.calibration, timestamp);

                // The estimate may be older than the capture, and says less about later paint.
                const frame = new Frame({
                  page: options.id,
                  data,
                  timing: new BrowserPaint({
                    timestamp,
                    hostTime,
                    uncertaintyMillis: uncertaintyAt(created.calibration, hostTime),
                  }),
                  receivedAt,
                  width: size.width,
                  height: size.height,
                });

                if (pictures.painted(frame)) return counts.count("duringPictures");
                sizes.offer(frame, timestamp, image, device);
              },
            };

            current = created;
            generation = current;
            latest = Option.none();
            sizes.restart(viewport);
          } else if (
            (screencast.quality !== undefined && screencast.quality !== current.quality) ||
            (screencast.size !== undefined &&
              (screencast.size.width !== current.size?.width ||
                screencast.size.height !== current.size.height))
          )
            // One native capture serves every reader; silently giving a reader other settings
            // than it asked for would misstate its frames.
            return yield* new BrowserError({
              operation: "screencast",
              reason: new InvalidRequest({
                detail: `a screencast with quality ${current.quality}${
                  current.size === null
                    ? ""
                    : ` and size ${current.size.width}x${current.size.height}`
                } is already running on this page; read it without options or with the same ones`,
              }),
              dispatched: false,
            });
          // The callback API must apply sliding synchronously; PubSub.publishUnsafe skips it.
          const subscription = yield* Queue.sliding<Envelope>(subscriberCapacity);

          if (current.failure !== undefined) {
            yield* Queue.shutdown(subscription);

            return yield* current.failure;
          }
          current.subscribers.add(subscription);
          const baseline = delivered;

          if (starting) {
            options.cdp.on("Page.screencastFrame", current.onFrame);
            const { quality, size } = current;

            const started = yield* Effect.tryPromise({
              try: () =>
                options.send("Page.startScreencast", {
                  format: "jpeg",
                  quality,
                  ...(size === null ? {} : { maxWidth: size.width, maxHeight: size.height }),
                }),
              catch: options.error,
            }).pipe(
              Effect.interruptible,
              Effect.timeoutOrElse({
                duration: deadline,
                orElse: () =>
                  Effect.fail(options.error(new Error("screencast start exceeded its deadline"))),
              }),
              Effect.provideService(Clock.Clock, options.clock),
              Effect.exit,
            );

            if (Exit.isFailure(started)) {
              current.subscribers.delete(subscription);
              yield* Effect.sync(() => stop(current));
              yield* awaitStop(current);
              generation = undefined;
              yield* Queue.shutdown(subscription);

              return yield* Effect.failCause(started.cause);
            }
          }

          return { current, subscription, baseline };
        }),
      );

    const stream: Controller["stream"] = (screencast = {}) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const lease = yield* Effect.acquireRelease(
            acquire(screencast),
            ({ current, subscription }) => release(current, subscription),
          );

          let previous = lease.baseline;

          // Pull one envelope at a time so taking a stream chunk cannot hide a slow reader's loss.
          return Stream.fromEffectRepeat(
            Queue.take(lease.subscription).pipe(
              Effect.flatMap((envelope) => {
                if (envelope._tag === "Failure") return Effect.fail(envelope.error);

                return Effect.sync(() => {
                  if (envelope.sequence > previous + 1)
                    counts.count("lost", envelope.sequence - previous - 1);
                  previous = envelope.sequence;

                  return envelope.frame;
                });
              }),
            ),
          );
        }),
      );

    yield* Effect.addFinalizer(() =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          closed = true;
          removeCloseListener();
          const current = generation;

          if (current === undefined) return;
          yield* Effect.sync(() =>
            fail(current, options.error(new Error("Target page has been closed"))),
          );
          yield* awaitStop(current);
        }),
      ),
    );

    return {
      stream,
      latest: Effect.sync(() => latest),
      recent: Effect.sync(() => history),
      active: Effect.sync(() => generation?.accepting === true),
      excluding: pictures.excluding,
      stats: (windowMillis?: number) =>
        Effect.sync(
          () => new CaptureStats({ ...counts.read(windowMillis), ackBacklog: replies.size }),
        ),
    } satisfies Controller;
  });
