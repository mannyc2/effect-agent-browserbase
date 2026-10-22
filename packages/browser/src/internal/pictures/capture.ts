/**
 * One CDP screencast per page, with bounded transport replies and per-reader loss accounting.
 * Native callbacks own synchronous bookkeeping; the page scope owns startup and teardown.
 */
import {
  Clock,
  Deferred,
  Duration,
  Effect,
  Exit,
  Option,
  Queue,
  Result,
  type Scope,
  Semaphore,
  Stream,
} from "effect";
import { Base64 } from "effect/encoding";

import { type BrowserError, InvalidRequest } from "../../BrowserError.ts";
import { type Estimate, monotonicMillis } from "../../Clock.ts";
import { CaptureStats, type Frame, type ScreencastOptions, sameCapture } from "../../Frame.ts";
import { undispatched } from "../page/context.ts";
import { tally } from "./counts.ts";
import { readViewport, sizeFilter, type Size } from "./dimensions.ts";
import { orderedFrame, timed } from "./frame.ts";
import * as Quiescence from "./quiescence.ts";
import { failureOf, initial, type State, step } from "./state.ts";
import type { NativeFrame, Transport } from "./transport.ts";

interface Options {
  readonly id: string;
  /** Where each capture's screencast runs, found as it starts. */
  readonly transport: Effect.Effect<Transport, BrowserError>;
  readonly clock: Clock.Clock;
  /** The estimate a capture starts with, once the page can be captured. */
  readonly calibrate: Effect.Effect<Estimate, BrowserError>;
  /** The browser's newest estimate, which times each frame. */
  readonly latest: () => Estimate | undefined;
  /** Measure the clock again if it is due, while frames flow. */
  readonly renew: Effect.Effect<void>;
  /** What the page needs from its own session while frames flow, sent as a capture starts. */
  readonly watch: Effect.Effect<unknown, BrowserError>;
  /** How long frames are kept, measured back from the newest. */
  readonly frameHistory: Duration.Duration;
  /** The viewport in CSS pixels; a capture is scaled to fit it, as screenshots are. */
  readonly viewport: Effect.Effect<Size, BrowserError>;
  /** Copies the restored whole surface before native capture can restart. */
  readonly restore: () => Promise<unknown>;
  readonly imageSize: (data: Uint8Array) => Size | undefined;
  readonly error: (cause: unknown) => BrowserError;
}

type Envelope =
  | { readonly _tag: "Frame"; readonly sequence: number; readonly frame: Frame }
  | { readonly _tag: "Failure"; readonly error: BrowserError };

interface Generation {
  readonly id: number;
  sequence: number;
  readonly subscribers: Set<Queue.Queue<Envelope>>;
  readonly transport: Transport;
  /** Stops handing the transport's frames to this generation. */
  unlisten: () => void;
  readonly calibration: Estimate;
  /** The native capture's settings; every reader of this generation shares them. */
  readonly quality: number;
  size: Size | null;
  readonly explicitSize: boolean;
  state: State;
  predecessor: number | undefined;
}

export interface Controller {
  /** Acquire a running capture now; its stream waits independently for the first frame. */
  readonly open: (options?: ScreencastOptions) => Effect.Effect<
    {
      readonly stream: Stream.Stream<Frame, BrowserError>;
      /** Current before this reader subscribed, never duplicated in its stream. */
      readonly current: Frame | undefined;
    },
    BrowserError,
    Scope.Scope
  >;
  readonly stream: (options?: ScreencastOptions) => Stream.Stream<Frame, BrowserError>;
  readonly latest: Effect.Effect<Option.Option<Frame>>;
  readonly recent: Effect.Effect<ReadonlyArray<Frame>>;
  /** Lifetime counts, or those of the latest `windowMillis`, at most `countsKept`. */
  readonly stats: (windowMillis?: number) => Effect.Effect<CaptureStats>;
  readonly active: Effect.Effect<boolean>;
  /** Once every frame the running capture's connection sent before now has arrived. */
  readonly sync: Effect.Effect<void, BrowserError>;
  /** This exact frame still belongs to the active capture and its current document. */
  readonly current: (frame: Frame) => boolean;
  /** Confirm this exact frame remains current after the capture connection's round trip. */
  readonly confirm: (frame: Frame) => Effect.Effect<boolean, BrowserError>;
  /** Run a clipped or scaled picture of the page, keeping what it draws out of the capture. */
  readonly excluding: <A, E, R>(
    picture: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | BrowserError, R>;
}

const replyCapacity = 32;
const subscriberCapacity = 16;
const deadline = Duration.seconds(2);

/**
 * What a new capture starts with: where it runs, the clock's estimate, and the viewport unless
 * the reader gave a size. A capture connection attaches while the page's own session maps the
 * clock, and a page too busy to report its viewport is still captured, at device size.
 */
const prepare = (options: Options, screencast: ScreencastOptions) =>
  Effect.all(
    [
      options.transport.pipe(Effect.interruptible),
      Effect.gen(function* () {
        const calibration = yield* options.calibrate.pipe(Effect.interruptible);
        const viewport = screencast.size === undefined ? yield* readViewport(options) : null;

        return { calibration, viewport };
      }),
    ],
    { concurrency: 2 },
  );

/**
 * A running capture's failure, told once its page's fate is known. A capture can fail before the
 * page's own session hears why: a capture connection hears the browser's end before the connection
 * that drives the page does, and an acknowledgement can be refused before the browser's loss is
 * known. So the failure waits for the page's scope to close, `closed`, and is then the page's own
 * end or its browser's loss, as `gone` reads it; or, if the page still stands after `deadline`,
 * the capture's own.
 */
const told =
  (closed: Deferred.Deferred<void>, gone: () => BrowserError, clock: Clock.Clock) =>
  (failure: BrowserError) =>
    Deferred.await(closed).pipe(
      Effect.map(gone),
      Effect.timeoutOrElse({ duration: deadline, orElse: () => Effect.succeed(failure) }),
      Effect.provideService(Clock.Clock, clock),
      Effect.flatMap(Effect.fail),
    );

/**
 * Once every frame the running capture's transport sent before now has arrived; a capture that
 * has failed, or whose round trip fails, fails as `why` tells it.
 */
const synced = (
  current: Generation | undefined,
  why: (failure: BrowserError) => Effect.Effect<never, BrowserError>,
  error: (cause: unknown) => BrowserError,
): Effect.Effect<void, BrowserError> => {
  if (current === undefined) return Effect.void;
  const failure = failureOf(current.state);

  if (failure !== undefined) return why(failure);

  return Effect.tryPromise({ try: () => current.transport.sync(), catch: error }).pipe(
    Effect.catch(why),
    Effect.asVoid,
  );
};

const confirmation =
  (
    read: () => {
      readonly generation: Generation | undefined;
      readonly replies: number;
    },
    current: Controller["current"],
    why: (failure: BrowserError) => Effect.Effect<never, BrowserError>,
    error: (cause: unknown) => BrowserError,
  ): Controller["confirm"] =>
  (frame) =>
    Effect.suspend(() => {
      const { generation } = read();

      if (generation === undefined) return Effect.succeed(false);

      return synced(generation, why, error).pipe(
        Effect.map(() => {
          const after = read();

          return after.generation === generation && after.replies === 0 && current(frame);
        }),
      );
    });

const isCurrent = (
  frame: Frame,
  generation: Generation | undefined,
  latest: Option.Option<Frame>,
) =>
  generation !== undefined &&
  generation.state._tag === "Capturing" &&
  frame.capture !== undefined &&
  sameCapture(frame, Option.getOrUndefined(latest)) &&
  generation.transport.frameTag().document === frame.document;

const currentFrame = (generation: Generation, latest: Option.Option<Frame>) =>
  Option.getOrUndefined(Option.filter(latest, (frame) => isCurrent(frame, generation, latest)));

/** One reader counts its own missed envelopes without hiding gaps inside stream chunks. */
const frames = (
  subscription: Queue.Queue<Envelope>,
  baseline: number,
  why: (failure: BrowserError) => Effect.Effect<never, BrowserError>,
  missed: (count: number) => void,
) => {
  let previous = baseline;

  // Pull one envelope at a time so taking a stream chunk cannot hide a slow reader's loss.
  return Stream.fromEffectRepeat(
    Queue.take(subscription).pipe(
      Effect.flatMap((envelope) => {
        if (envelope._tag === "Failure") return why(envelope.error);

        return Effect.sync(() => {
          if (envelope.sequence > previous + 1) missed(envelope.sequence - previous - 1);
          previous = envelope.sequence;

          return envelope.frame;
        });
      }),
    ),
  );
};

const renewals = Effect.fnUntraced(function* (options: Options) {
  const renewing = yield* Queue.sliding<void>(1);

  yield* Queue.take(renewing).pipe(
    Effect.andThen(options.renew),
    Effect.andThen(Effect.sleep(Duration.seconds(1))),
    Effect.provideService(Clock.Clock, options.clock),
    Effect.forever,
    Effect.forkScoped,
  );

  return renewing;
});

const receive =
  (
    options: Options,
    current: Generation,
    replies: Set<Promise<void>>,
    counts: ReturnType<typeof tally>,
    sizes: Effect.Success<ReturnType<typeof sizeFilter>>,
    renewing: Queue.Queue<void>,
    fail: (current: Generation, error: BrowserError) => void,
  ) =>
  (native: NativeFrame) => {
    if (current.state._tag === "Stopped") return;
    counts.count("received");
    if (replies.size >= replyCapacity) {
      fail(current, options.error(new Error("screencast acknowledgement capacity exceeded")));

      return;
    }

    const reply = current.transport
      .acknowledge(native.sessionId)
      .then(
        () => undefined,
        (cause: unknown) => {
          if (current.state._tag !== "Stopped") fail(current, options.error(cause));
        },
      )
      .then(() => void replies.delete(reply));

    replies.add(reply);
    const browserSeconds = native.metadata.timestamp;
    const timestamp = browserSeconds === undefined ? Number.NaN : browserSeconds * 1000;

    if (!Number.isFinite(timestamp)) return counts.count("missingTimestamp");
    if (current.predecessor !== undefined && timestamp <= current.predecessor)
      return counts.count("late");
    Queue.offerUnsafe(renewing, undefined);
    const decoded = Base64.decode(native.data);

    if (Result.isFailure(decoded)) {
      fail(
        current,
        options.error(new Error("the capture connection sent invalid base64 picture data")),
      );

      return;
    }
    current.sequence++;
    const { frame, image, device } = timed(options, native, timestamp, current, decoded.success);

    if (current.state._tag === "Paused") return counts.count("duringPictures");
    sizes.offer(frame, timestamp, image, device);
  };

const settingsOf = (current: Generation) => ({
  format: "jpeg" as const,
  quality: current.quality,
  ...(current.size === null
    ? {}
    : { maxWidth: current.size.width, maxHeight: current.size.height }),
});

const healthy = (current: Generation) =>
  Effect.suspend(() => {
    const failure = failureOf(current.state);

    return failure === undefined ? Effect.void : Effect.fail(failure);
  });

// Native caps must follow implicit viewport growth or every following frame stays scaled down.
const followGrowth = (
  changes: Queue.Queue<Size>,
  lock: Semaphore.Semaphore,
  generation: () => Generation | undefined,
  pictures: ReturnType<typeof Quiescence.make<Generation>>,
  fail: (current: Generation, error: BrowserError) => void,
) =>
  Queue.take(changes).pipe(
    Effect.flatMap((size) =>
      lock.withPermits(1)(
        Effect.suspend(() => {
          const current = generation();

          if (
            current === undefined ||
            current.explicitSize ||
            current.state._tag !== "Capturing" ||
            (current.size !== null &&
              size.width <= current.size.width &&
              size.height <= current.size.height)
          )
            return Effect.void;

          return pictures
            .excluding(
              Effect.sync(() => {
                current.size = size;
              }),
            )
            .pipe(Effect.catch((error) => Effect.sync(() => fail(current, error))));
        }),
      ),
    ),
    Effect.forever,
    Effect.forkScoped,
  );

interface Lease {
  readonly current: Generation;
  readonly subscription: Queue.Queue<Envelope>;
  readonly baseline: number;
  readonly frame: Frame | undefined;
}

/** The first subscription must exist before the native start can emit its only frame. */
const subscribe = (current: Generation) =>
  Effect.gen(function* () {
    const subscription = yield* Queue.sliding<Envelope>(subscriberCapacity);

    current.subscribers.add(subscription);
    const failure = failureOf(current.state);

    if (failure !== undefined) Queue.offerUnsafe(subscription, { _tag: "Failure", error: failure });

    return subscription;
  });

const reader =
  (
    acquire: (options: ScreencastOptions) => Effect.Effect<Lease, BrowserError>,
    leave: (lease: Lease) => Effect.Effect<void>,
    why: (failure: BrowserError) => Effect.Effect<never, BrowserError>,
    lost: (count: number) => void,
  ): Controller["open"] =>
  (settings = {}) =>
    Effect.acquireRelease(acquire(settings).pipe(Effect.interruptible), leave).pipe(
      Effect.map((lease) => ({
        current: lease.frame,
        stream: frames(lease.subscription, lease.baseline, why, lost),
      })),
    );

export const make = (options: Options) =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1);
    const replies = new Set<Promise<void>>();
    let generation: Generation | undefined;
    let generations = 0;
    let lastHostTime = Number.NEGATIVE_INFINITY;
    // Done as the page's scope closes, once the page has gone and its browser's loss, if any, is
    // known.
    const closed = yield* Deferred.make<void>();
    const pageScope = yield* Effect.scope;
    const isClosed = () => pageScope.state._tag === "Closed" || Deferred.isDoneUnsafe(closed);
    let latest = Option.none<Frame>();
    let history: ReadonlyArray<Frame> = [];
    const counts = tally(() => monotonicMillis(options.clock));
    // Frames delivered, which number them so that a reader can tell what it missed.
    let delivered = 0;

    // Frames that show the page go to the running capture's readers.
    const deliver = (frame: Frame, timestamp: number) => {
      const current = generation;

      if (current === undefined) return;
      // Held frames are checked again: frames encoded out of order are dropped, never reordered.
      if (current.predecessor !== undefined && timestamp <= current.predecessor)
        return counts.count("late");
      if (current.predecessor !== undefined) counts.gap(timestamp - current.predecessor);
      current.predecessor = timestamp;
      frame = orderedFrame(frame, lastHostTime);
      lastHostTime = frame.hostTime;
      delivered++;
      counts.count("accepted");
      latest = Option.some(frame);
      history = [
        ...history.filter(
          (kept) => kept.hostTime >= frame.hostTime - Duration.toMillis(options.frameHistory),
        ),
        frame,
      ];
      for (const subscriber of current.subscribers)
        Queue.offerUnsafe(subscriber, { _tag: "Frame", sequence: delivered, frame });
    };

    const resized = yield* Queue.sliding<Size>(1);

    const sizes = yield* sizeFilter(
      options,
      deliver,
      (frames) => counts.count("foreignSize", frames),
      (size) => {
        Queue.offerUnsafe(resized, size);
      },
    );

    // On air a capture runs for hours, and its frames are timed by the browser's newest estimate,
    // so arriving frames renew it: a check at most each second, a measurement once it is due.
    const renewing = yield* renewals(options);

    const notifyFailure = (current: Generation, failure: BrowserError) => {
      if (failureOf(current.state) !== undefined) return;
      for (const subscriber of current.subscribers)
        Queue.offerUnsafe(subscriber, { _tag: "Failure", error: failure });
      stop(current, failure);
    };

    const failed = (current: Generation) => (cause: unknown) =>
      notifyFailure(current, options.error(cause));

    const stopNative = (current: Generation) =>
      pictures.track("screencast stop", current.transport.stop(), failed(current));

    const startNative = (current: Generation) =>
      pictures.track(
        "screencast start",
        current.transport.start(settingsOf(current)),
        failed(current),
      );

    const stop = (current: Generation, failure?: BrowserError) => {
      const stopped = current.state._tag === "Stopped";
      const paused = current.state._tag === "Paused";

      current.state = step(current.state, { _tag: "Stop", failure });
      if (stopped) return;
      sizes.end();
      current.unlisten();
      // A paused capture already owns its stop, including a reply still in flight.
      if (!paused) void stopNative(current);
    };

    const gone = () => options.error(new Error("Target page has been closed"));
    const why = told(closed, gone, options.clock);

    const awaitStop = (current: Generation) =>
      pictures
        .wait("screencast stop")
        .pipe(Effect.catch((error) => Effect.sync(() => notifyFailure(current, error))));

    const pictures = Quiescence.make({
      clock: options.clock,
      error: options.error,
      closed: isClosed,
      current: () => generation,
      fail: (current, error) => {
        if (current !== undefined) notifyFailure(current, error);
      },
      pause: (current): Effect.Effect<void, BrowserError> =>
        Effect.gen(function* () {
          if (current?.state._tag !== "Capturing") return;
          current.state = step(current.state, { _tag: "Pause" });
          latest = Option.none();
          sizes.end();
          void stopNative(current);
          yield* pictures
            .wait("screencast stop")
            .pipe(Effect.tapError((error) => Effect.sync(() => notifyFailure(current, error))));
          yield* healthy(current);
        }),
      resume: (current): Effect.Effect<void, BrowserError> =>
        Effect.gen(function* () {
          const resumable = () => {
            if (current === undefined || generation !== current) return false;
            if (current.subscribers.size === 0) {
              stop(current);
              generation = undefined;
            }

            return current.state._tag !== "Stopped" && !isClosed();
          };

          if (current === undefined || !resumable()) return;
          // Screenshot replies restore emulation before the compositor has necessarily painted
          // it. Copy the whole restored surface while stopped, retaining its actual native reply.
          void pictures.track("picture restoration", options.restore(), failed(current));
          yield* pictures.wait("picture restoration");
          yield* healthy(current);
          const viewport = yield* readViewport(options);

          if (!resumable()) return;
          sizes.restart(viewport);
          // Its only quiet-page frame can precede the native start acknowledgement.
          current.state = step(current.state, { _tag: "Resume" });
          void startNative(current);
          yield* pictures.wait("screencast start");
          yield* healthy(current);
        }),
    });

    yield* followGrowth(resized, lock, () => generation, pictures, notifyFailure);

    // A reader leaves; the last one stops its generation.
    const leave = (current: Generation, subscription: Queue.Queue<Envelope>) =>
      Effect.gen(function* () {
        current.subscribers.delete(subscription);
        yield* Queue.shutdown(subscription);
        if (current.subscribers.size !== 0) return;
        yield* Effect.sync(() => stop(current));
        yield* awaitStop(current);
        if (generation === current) generation = undefined;
      });

    const acquire = (screencast: ScreencastOptions) =>
      lock.withPermits(1)(
        Effect.uninterruptible(
          Effect.gen(function* () {
            if (isClosed()) return yield* gone();
            let current = generation;
            const starting = current === undefined;

            if (current === undefined) {
              yield* pictures.idle;
              const [transport, { calibration, viewport }] = yield* prepare(options, screencast);
              const size = screencast.size ?? viewport;

              if (isClosed()) return yield* gone();

              current = {
                id: ++generations,
                sequence: 0,
                subscribers: new Set(),
                transport,
                unlisten: () => undefined,
                calibration,
                quality: screencast.quality ?? 80,
                size,
                explicitSize: screencast.size !== undefined,
                state: initial,
                predecessor: undefined,
              };

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
              return yield* undispatched(
                "screencast",
                new InvalidRequest({
                  detail: `a screencast with quality ${current.quality}${
                    current.size === null
                      ? ""
                      : ` and size ${current.size.width}x${current.size.height}`
                  } is already running on this page; read it without options or with the same ones`,
                }),
              );
            // The callback API must apply sliding synchronously; PubSub.publishUnsafe skips it.
            const subscription = yield* subscribe(current);
            const baseline = delivered;
            const frame = currentFrame(current, latest);

            if (starting) {
              const listening = current;

              current.unlisten = listening.transport.listen({
                frame: receive(options, current, replies, counts, sizes, renewing, notifyFailure),
                lost: (error) => notifyFailure(listening, error),
              });

              const screencast = Effect.promise(() => startNative(listening)).pipe(
                Effect.andThen(healthy(listening)),
              );

              const started = yield* options.watch.pipe(
                Effect.zip(screencast, { concurrent: true }),
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
                yield* leave(current, subscription);

                return yield* Effect.failCause(started.cause);
              }
            }

            return { current, subscription, baseline, frame };
          }),
        ),
      );

    const open = reader(
      acquire,
      ({ current, subscription }) =>
        Effect.suspend(() => {
          current.subscribers.delete(subscription);

          return current.subscribers.size > 0
            ? Queue.shutdown(subscription)
            : lock.withPermits(1)(leave(current, subscription));
        }),
      why,
      (count) => counts.count("lost", count),
    );

    // The page's scope closes once the page has gone, when its browser's loss, if any, is known.
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => Deferred.doneUnsafe(closed, Exit.void)).pipe(
        Effect.andThen(
          lock.withPermits(1)(
            Effect.suspend(() => {
              const current = generation;

              if (current === undefined) return Effect.void;
              notifyFailure(current, gone());

              return awaitStop(current);
            }),
          ),
        ),
      ),
    );

    return {
      open,
      stream: (options?: ScreencastOptions) =>
        Stream.unwrap(Effect.map(open(options), ({ stream }) => stream)),
      latest: Effect.sync(() => latest),
      recent: Effect.sync(() => history),
      active: Effect.sync(() => generation !== undefined && generation.state._tag !== "Stopped"),
      sync: Effect.suspend(() => synced(generation, why, options.error)),
      current: (frame: Frame) => isCurrent(frame, generation, latest),
      confirm: confirmation(
        () => ({ generation, replies: replies.size }),
        (frame: Frame) => isCurrent(frame, generation, latest),
        why,
        options.error,
      ),
      excluding: (picture) => lock.withPermits(1)(pictures.excluding(picture)),
      stats: (windowMillis?: number) =>
        Effect.sync(
          () => new CaptureStats({ ...counts.read(windowMillis), ackBacklog: replies.size }),
        ),
    } satisfies Controller;
  });
