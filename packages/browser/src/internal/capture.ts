/**
 * One CDP screencast per page, with bounded transport replies and per-reader loss accounting.
 * Native callbacks own synchronous bookkeeping; the page scope owns startup and teardown.
 */
import { Clock, Duration, Effect, Exit, Option, Queue, Semaphore, Stream } from "effect";
import type { CDPSession } from "playwright-core";

import { BrowserError, InvalidRequest } from "../BrowserError.ts";
import { BrowserPaint, CaptureStats, Frame, type ScreencastOptions } from "../Frame.ts";
import { type Estimate, toHostTime } from "./clock.ts";

interface Size {
  readonly width: number;
  readonly height: number;
}

interface Options {
  readonly id: string;
  readonly cdp: CDPSession;
  readonly clock: Clock.Clock;
  readonly calibrate: Effect.Effect<Estimate, BrowserError>;
  readonly frameHistory: number;
  readonly viewport: () => Size | null;
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
  readonly stats: Effect.Effect<CaptureStats>;
  readonly active: Effect.Effect<boolean>;
}

const replyCapacity = 32;
const subscriberCapacity = 16;
const deadline = Duration.seconds(2);

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
    let received = 0;
    let accepted = 0;
    let outOfOrder = 0;
    let missingTimestamp = 0;
    let subscriberMissed = 0;
    let gapCount = 0;
    let gapTotal = 0;
    let gapMin: number | null = null;
    let gapMax: number | null = null;
    let gapLast: number | null = null;

    const now = () => Number(options.clock.monotonicTimeNanosUnsafe()) / 1e6;

    const notifyFailure = (current: Generation, failure: BrowserError) => {
      if (current.failure !== undefined) return;
      current.failure = failure;
      for (const subscriber of current.subscribers)
        Queue.offerUnsafe(subscriber, { _tag: "Failure", error: failure });
    };

    const stop = (current: Generation) => {
      if (!current.accepting) return;
      current.accepting = false;
      options.cdp.off("Page.screencastFrame", current.onFrame);
      let response: Promise<unknown>;

      try {
        response = options.cdp.send("Page.stopScreencast");
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

            if (closed) return yield* options.error(new Error("Target page has been closed"));

            const created: Generation = {
              subscribers: new Set(),
              calibration,
              quality: screencast.quality ?? 80,
              size: screencast.size ?? options.viewport(),
              accepting: true,
              predecessor: undefined,
              failure: undefined,
              stopReply: undefined,
              onFrame: (native) => {
                if (!created.accepting) return;
                received++;
                if (replies.size >= replyCapacity) {
                  fail(
                    created,
                    options.error(new Error("screencast acknowledgement capacity exceeded")),
                  );

                  return;
                }
                let response: Promise<unknown>;

                try {
                  response = options.cdp.send("Page.screencastFrameAck", {
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

                if (!Number.isFinite(timestamp)) {
                  missingTimestamp++;

                  return;
                }
                if (created.predecessor !== undefined && timestamp <= created.predecessor) {
                  outOfOrder++;

                  return;
                }
                const receivedAt = now();
                const data = Buffer.from(native.data, "base64");

                const size = options.imageSize(data) ??
                  options.viewport() ?? {
                    width: native.metadata.deviceWidth,
                    height: native.metadata.deviceHeight,
                  };

                const frame = new Frame({
                  page: options.id,
                  data,
                  timing: new BrowserPaint({
                    timestamp,
                    hostTime: toHostTime(created.calibration, timestamp),
                    uncertaintyMillis: created.calibration.uncertaintyMillis,
                  }),
                  receivedAt,
                  width: size.width,
                  height: size.height,
                });

                if (created.predecessor !== undefined) {
                  const gap = timestamp - created.predecessor;

                  gapCount++;
                  gapTotal += gap;
                  gapMin = gapMin === null ? gap : Math.min(gapMin, gap);
                  gapMax = gapMax === null ? gap : Math.max(gapMax, gap);
                  gapLast = gap;
                }
                created.predecessor = timestamp;
                accepted++;
                latest = Option.some(frame);
                history =
                  options.frameHistory <= 0 ? [] : [...history, frame].slice(-options.frameHistory);
                for (const subscriber of created.subscribers)
                  Queue.offerUnsafe(subscriber, { _tag: "Frame", sequence: accepted, frame });
              },
            };

            current = created;
            generation = current;
            latest = Option.none();
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
          const baseline = accepted;

          if (starting) {
            options.cdp.on("Page.screencastFrame", current.onFrame);
            const { quality, size } = current;

            const started = yield* Effect.tryPromise({
              try: () =>
                options.cdp.send("Page.startScreencast", {
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
                  subscriberMissed += Math.max(0, envelope.sequence - previous - 1);
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
      stats: Effect.sync(
        () =>
          new CaptureStats({
            received,
            accepted,
            outOfOrder,
            missingTimestamp,
            subscriberMissed,
            gaps: {
              count: gapCount,
              totalMillis: gapTotal,
              minMillis: gapMin,
              maxMillis: gapMax,
              lastMillis: gapLast,
            },
          }),
      ),
    } satisfies Controller;
  });
