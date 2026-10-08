/**
 * The stage: whichever page's capture feeds a live output, switched between pages in one browser
 * session or across two, each switch stamped with when it took effect on the frame clock. Make one
 * per live output.
 *
 * `present(page, { at })` switches the output to `page` at `at`, host monotonic milliseconds on the
 * clock that times frames, or at once. It starts the new page's capture ahead of `at`, waits for
 * its first frame, waits for any input already under way on the old page, then turns: from then on
 * `frames` carries the new page's frames, beginning with its newest, and the old page's capture
 * stops. Within one session it stops the old page's capture first and turns at the new one's first
 * frame, since a session's captures share its connection. A first frame that does not come in time
 * fails `present` and leaves the old page on the stage. A capture that fails restarts on the same
 * page while its page and browser stand.
 *
 * What a live output does with frames stays the application's: a delay line, a liveness rule,
 * redaction and repeating a held frame. A still page sends no frames until it changes, so the
 * frame a switch begins with may be older than the frames before it; `Presented.at` says when the
 * switch took effect.
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

import { BrowserError, consequence, InvalidRequest, Timeout } from "./BrowserError.ts";
import type { Frame, ScreencastOptions } from "./Frame.ts";
import { internalsOf } from "./internal/page/page.ts";
import type { Page } from "./Page.ts";

export interface Options extends ScreencastOptions {
  /** How long a switch waits for the new page's first frame. Defaults to 5 seconds. */
  readonly firstFrame?: Duration.Input | undefined;
}

/** A switch that took effect. */
export class Presented extends Schema.Class<Presented>("effect-browser/Presented")({
  /** The page presented from then on. */
  page: Schema.String,
  /**
   * When the switch took effect, in host monotonic milliseconds on the frame clock: after the
   * frames it followed, the new page's first frame and the time asked for.
   */
  at: Schema.Finite,
  /** How long after the time asked for it took effect. */
  latency: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
}) {}

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** What the stage carried over a window. */
export class Stats extends Schema.Class<Stats>("effect-browser/StageStats")({
  frames: Count,
  fps: Schema.Finite,
  /** The longest time between consecutive frames' paints, or null with fewer than two. */
  largestGapMillis: Schema.NullOr(Schema.Finite),
  /** Frames the presented page's capture left out, as another capture's or a crop's. */
  filtered: Count,
}) {}

export interface Stage {
  readonly present: (
    page: Page,
    options?: { readonly at?: number | undefined },
  ) => Effect.Effect<Presented, BrowserError>;
  /**
   * The presented page's frames, each naming its page, session, document and address. A reader
   * that falls more than 16 frames behind loses the oldest.
   */
  readonly frames: Stream.Stream<Frame>;
  readonly current: Effect.Effect<Option.Option<Page>>;
  /** Over the latest `window`, at most a minute; one second by default. */
  readonly stats: (options?: {
    readonly window?: Duration.Input | undefined;
  }) => Effect.Effect<Stats, BrowserError>;
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

const invalid = (detail: string) =>
  new BrowserError({ operation: "stage", reason: new InvalidRequest({ detail }), dispatched: false });

const minute = 60_000;

export const make = Effect.fn("Stage.make")(function* (options: Options = {}) {
  const clock = yield* Clock.Clock;
  const scope = yield* Effect.scope;
  const now = () => Number(clock.monotonicTimeNanosUnsafe()) / 1e6;
  const firstFrame = Duration.fromInput(options.firstFrame ?? Duration.seconds(5));

  if (Option.isNone(firstFrame) || !Duration.isPositive(firstFrame.value))
    return yield* invalid("firstFrame must be a positive duration");
  const settings = { quality: options.quality, size: options.size };
  const output = yield* PubSub.sliding<Frame>(16);
  const switching = yield* Semaphore.make(1);
  // What is on the stage. Only `present` changes it.
  let shown: { readonly feed: Feed; readonly presented: Presented } | undefined;
  // The frames sent out in the latest minute: when, and when each was painted.
  const sent: Array<{ readonly at: number; readonly painted: number }> = [];

  const send = (frame: Frame) => {
    const at = now();

    while ((sent[0]?.at ?? at) <= at - minute) sent.shift();
    sent.push({ at, painted: frame.hostTime });
    PubSub.publishUnsafe(output, frame);
  };

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
            Deferred.doneUnsafe(fed.first, Exit.void);
            if (fed.live) send(frame);
          }),
        ),
        Effect.retry({ while: restartable, schedule: Schedule.spaced(Duration.millis(500)) }),
        Effect.forkIn(scope),
      );

      return fed;
    });

  // Its capture stops, and no frame of it goes out once this returns.
  const stop = (fed: Feed) =>
    Effect.suspend(() => {
      fed.live = false;

      return fed.fiber === undefined ? Effect.void : Fiber.interrupt(fed.fiber);
    });

  // The new page's first frame, its capture's own failure, or a timeout.
  const firstOf = (fed: Feed) =>
    Effect.raceFirst(
      Deferred.await(fed.first),
      fed.fiber === undefined ? Effect.never : Fiber.join(fed.fiber).pipe(Effect.andThen(Effect.never)),
    ).pipe(
      Effect.timeoutOrElse({
        duration: firstFrame.value,
        orElse: () =>
          Effect.fail(
            new BrowserError({
              operation: "present",
              reason: new Timeout({ millis: Duration.toMillis(firstFrame.value) }),
              dispatched: false,
            }),
          ),
      }),
    );

  const until = (at: number) =>
    Effect.suspend(() => (at > now() ? Effect.sleep(Duration.millis(at - now())) : Effect.void));

  // Input under way on a page ends before the stage turns from it, within its action timeout.
  const inputEnded = (page: Page) => Effect.ignore(internalsOf(page)?.inputEnded ?? Effect.void);

  const present: Stage["present"] = (page, presentOptions = {}) =>
    switching.withPermits(1)(
      Effect.gen(function* () {
        const asked = presentOptions.at ?? now();
        const old = shown;

        if (old !== undefined && old.feed.page === page) return old.presented;

        // A session's captures share its connection, so there the old one stops first.
        const apart =
          old === undefined || old.feed.page.playwright.context() !== page.playwright.context();

        if (!apart) {
          yield* until(asked);
          yield* inputEnded(old.feed.page);
          yield* stop(old.feed);
        }
        const fed = yield* feed(page);

        // A switch that does not happen leaves the old page on the stage, its capture running.
        const turned = yield* Effect.gen(function* () {
          yield* firstOf(fed);
          if (apart) {
            yield* until(asked);
            if (old !== undefined) yield* inputEnded(old.feed.page);
          }

          return yield* Effect.sync(() => {
            const frame = fed.latest;
            const last = sent.at(-1);
            const at = Math.max(asked, frame?.hostTime ?? asked, last?.painted ?? asked);

            if (old !== undefined) old.feed.live = false;
            fed.live = true;
            if (frame !== undefined) send(frame);
            shown = {
              feed: fed,
              presented: new Presented({ page: page.id, at, latency: at - asked }),
            };

            return shown.presented;
          });
        }).pipe(
          Effect.onError(() =>
            stop(fed).pipe(
              Effect.andThen(
                old === undefined || apart
                  ? Effect.void
                  : feed(old.feed.page).pipe(
                      Effect.tap((again) =>
                        Effect.sync(() => {
                          again.live = true;
                          shown = { feed: again, presented: old.presented };
                        }),
                      ),
                    ),
              ),
            ),
          ),
        );

        if (old !== undefined) yield* stop(old.feed);

        return turned;
      }).pipe(Effect.provideService(Clock.Clock, clock)),
    );

  const stats: Stage["stats"] = (statsOptions = {}) =>
    Effect.gen(function* () {
      const window = Duration.fromInput(statsOptions.window ?? Duration.seconds(1));

      if (
        Option.isNone(window) ||
        !Duration.isPositive(window.value) ||
        Duration.toMillis(window.value) > minute
      )
        return yield* invalid("a window must be positive and at most a minute");
      const millis = Duration.toMillis(window.value);
      const since = now() - millis;
      const painted = sent.filter((each) => each.at > since).map((each) => each.painted);

      const gaps = painted.slice(1).map((paint, index) => paint - (painted[index] ?? paint));
      const page = shown?.feed.page;

      const capture =
        page === undefined ? undefined : yield* page.captureStats({ window: window.value });

      return new Stats({
        frames: painted.length,
        fps: (painted.length * 1000) / millis,
        largestGapMillis: gaps.length === 0 ? null : Math.max(...gaps),
        filtered: (capture?.foreignSize ?? 0) + (capture?.duringPictures ?? 0),
      });
    });

  return {
    present,
    frames: Stream.fromPubSub(output),
    current: Effect.sync(() => Option.fromNullishOr(shown?.feed.page)),
    stats,
  } satisfies Stage;
});
