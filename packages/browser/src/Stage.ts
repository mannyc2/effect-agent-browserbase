/**
 * The stage: whichever page's capture feeds a live output, switched between pages in one browser
 * session or across two, each switch stamped with when it took effect on the frame clock. Make one
 * per live output.
 *
 * `present(page, { at })` switches the output to `page` at `at`, host monotonic milliseconds on the
 * clock that times frames, or at once. It starts the new page's capture ahead, waits for its first
 * frame, then for any input already under way on the old page, and turns: from then on `frames`
 * carries the new page's frames, its newest first, and the old page's capture stops. The captures
 * overlap, so a switch shows no dark spell; on Browserbase two ran in one session at the frame
 * rate of one. A first frame that does not come in time fails `present`, and the old page stays. A
 * capture that fails restarts on the same page while its page and browser stand.
 *
 * What a live output does with frames stays the application's: a delay line, a liveness rule,
 * redaction and repeating a held frame. A still page sends no frames until it changes, so the frame
 * a switch begins with may be older than the frames before it; `Presented.at` says when it took
 * effect.
 *
 * @since 0.3.0
 */
import {
  Clock,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Option,
  PubSub,
  Schedule,
  Schema,
  Semaphore,
  Stream,
} from "effect";

import { type BrowserError, consequence, InvalidRequest, Timeout } from "./BrowserError.ts";
import type { CaptureStats, Frame, ScreencastOptions } from "./Frame.ts";
import { failWith } from "./internal/page/context.ts";
import { internalsOf } from "./internal/page/page.ts";
import type { Page } from "./Page.ts";

export interface Options extends ScreencastOptions {
  /** How long a switch waits for the new page's first frame. Defaults to 5 seconds. */
  readonly firstFrame?: Duration.Input | undefined;
}

/** A switch that took effect. */
export class Presented extends Schema.Class<Presented>("effect-browser/Presented")({
  page: Schema.String,
  /**
   * When it took effect, in host monotonic milliseconds on the frame clock: no earlier than the
   * time asked for, the frames it followed or the new page's first.
   */
  at: Schema.Finite,
  /** How long after the time asked for it took effect. */
  latency: Schema.Finite,
}) {}

export interface Stage {
  readonly present: (
    page: Page,
    options?: { readonly at?: number | undefined },
  ) => Effect.Effect<Presented, BrowserError>;
  /**
   * The presented page's frames, each naming its page, session, document and address. A reader
   * more than 16 frames behind loses the oldest.
   */
  readonly frames: Stream.Stream<Frame>;
  readonly current: Effect.Effect<Option.Option<Page>>;
  /**
   * The presented page's capture counts over the latest `window`, at most a minute: its frames,
   * their largest gap, and those filtered out, as another capture's or a crop's.
   */
  readonly stats: (options?: {
    readonly window?: Duration.Input | undefined;
  }) => Effect.Effect<Option.Option<CaptureStats>, BrowserError>;
}

/** A page's capture for the stage: its newest frame, and whether its frames go out. */
interface Feed {
  readonly page: Page;
  readonly first: Deferred.Deferred<void>;
  latest: Frame | undefined;
  live: boolean;
  fiber: Fiber.Fiber<void, BrowserError> | undefined;
}

// A capture restarts unless its page or browser is gone, or it would fail the same way again.
const restartable = (error: BrowserError) => {
  const { lost, repeat } = consequence(error);

  return lost === "nothing" && repeat !== "pointless";
};

export const make = Effect.fn("Stage.make")(function* (options: Options = {}) {
  const clock = yield* Clock.Clock;
  const scope = yield* Effect.scope;
  const now = () => Number(clock.monotonicTimeNanosUnsafe()) / 1e6;
  const waited = Duration.fromInput(options.firstFrame ?? Duration.seconds(5));

  if (Option.isNone(waited) || !Duration.isPositive(waited.value))
    return yield* failWith(
      "stage",
      new InvalidRequest({ detail: "firstFrame must be a positive duration" }),
    );
  const firstFrame = waited.value;
  const settings = { quality: options.quality, size: options.size };
  const output = yield* PubSub.sliding<Frame>(16);
  const switching = yield* Semaphore.make(1);
  // What is on the stage, which only `present` changes, and the paint of the latest frame out.
  let shown: { readonly feed: Feed; readonly presented: Presented } | undefined;
  let painted = Number.NEGATIVE_INFINITY;

  const feed = (page: Page) =>
    Effect.gen(function* () {
      const fed: Feed = {
        page,
        first: yield* Deferred.make<void>(),
        latest: undefined,
        live: false,
        fiber: undefined,
      };

      fed.fiber = yield* page.screencast(settings).pipe(
        Stream.runForEach((frame) =>
          Effect.sync(() => {
            fed.latest = frame;
            if (fed.live) {
              painted = frame.hostTime;
              PubSub.publishUnsafe(output, frame);
            }
            // Last: a switch waiting for this frame may turn, and send it, at once.
            Deferred.doneUnsafe(fed.first, Exit.void);
          }),
        ),
        Effect.retry({ while: restartable, schedule: Schedule.spaced(Duration.millis(500)) }),
        Effect.forkIn(scope),
      );

      return fed;
    });

  // No frame of it goes out once this returns, and its capture stops.
  const stop = (fed: Feed) =>
    Effect.suspend(() => {
      fed.live = false;

      return fed.fiber === undefined ? Effect.void : Fiber.interrupt(fed.fiber);
    });

  // The new page's first frame; its capture's own failure, or `Timeout`.
  const firstOf = (fed: Feed) =>
    Effect.raceFirst(
      Deferred.await(fed.first),
      fed.fiber === undefined ? Effect.never : Effect.andThen(Fiber.join(fed.fiber), Effect.never),
    ).pipe(
      Effect.timeoutOrElse({
        duration: firstFrame,
        orElse: () => failWith("present", new Timeout({ millis: Duration.toMillis(firstFrame) })),
      }),
    );

  // A timer can fire a fraction of a millisecond early, so the wait looks again.
  const until = (at: number): Effect.Effect<void> =>
    Effect.suspend(() =>
      at > now()
        ? Effect.andThen(Effect.sleep(Duration.millis(Math.ceil(at - now()))), until(at))
        : Effect.void,
    );

  const present: Stage["present"] = (page, presentOptions = {}) =>
    switching.withPermits(1)(
      Effect.gen(function* () {
        const asked = presentOptions.at ?? now();
        const old = shown;

        if (old?.feed.page === page) return old.presented;
        const fed = yield* feed(page);

        yield* Effect.gen(function* () {
          yield* firstOf(fed);
          yield* until(asked);
          // Input under way on the old page ends first, within its action timeout.
          if (old !== undefined)
            yield* Effect.ignore(internalsOf(old.feed.page)?.inputEnded ?? Effect.void);
        }).pipe(Effect.onError(() => stop(fed)));

        const presented = yield* Effect.sync(() => {
          const frame = fed.latest;
          const at = Math.max(asked, frame?.hostTime ?? asked, painted);

          if (old !== undefined) old.feed.live = false;
          fed.live = true;
          if (frame !== undefined) {
            painted = frame.hostTime;
            PubSub.publishUnsafe(output, frame);
          }
          shown = {
            feed: fed,
            presented: new Presented({ page: page.id, at, latency: at - asked }),
          };

          return shown.presented;
        });

        if (old !== undefined) yield* stop(old.feed);

        return presented;
      }).pipe(Effect.provideService(Clock.Clock, clock)),
    );

  return {
    present,
    frames: Stream.fromPubSub(output),
    current: Effect.sync(() => Option.fromNullishOr(shown?.feed.page)),
    stats: (statsOptions = {}) =>
      shown === undefined
        ? Effect.succeedNone
        : Effect.asSome(
            shown.feed.page.captureStats({ window: statsOptions.window ?? "1 second" }),
          ),
  } satisfies Stage;
});
