/** Screen and foreground stillness over the public page capture and owning clock. */
import { Clock, Duration, Effect, Function, Option, Schedule, Stream } from "effect";

import { type BrowserError, Failed, refuse, Timeout, undispatched } from "../BrowserError.ts";
import type { Box } from "../BrowserEvent.ts";
import * as Change from "../Change.ts";
import type { Frame } from "../Frame.ts";
import { millisOf, monotonicMillis } from "../internal/clock.ts";
import * as Overlay from "../Overlay.ts";
import type { Page } from "../Page.ts";
import * as Motion from "./internal/pixels.ts";

export interface Options {
  readonly still?: "screen" | "content" | "foreground" | undefined;
  /** How long the screen, or the content, must stay still. */
  readonly quiet: Duration.Input;
  /** Defaults to 15 seconds. */
  readonly timeout?: Duration.Input | undefined;
}

const observe = (page: Page, options: Options, quietMillis: number, timeout: Duration.Duration) =>
  Effect.gen(function* () {
    const now = () => monotonicMillis(page.hostClock);
    const deadline = now() + Duration.toMillis(timeout);

    const settled = () =>
      page.ready({
        quiet: quietMillis,
        timeout: Duration.millis(Math.max(0, deadline - now())),
      });

    // A capture the wait starts sends its first frame late, over half a second from a hosted
    // browser, so the spell counts from that frame (#202); Chrome sends one as a capture starts,
    // even of a still page.
    const quiet = (millis: number) =>
      Effect.gen(function* () {
        const capture = yield* page.capture();

        const foreground = options.still === "foreground";
        let counts = yield* capture.stats();
        let stirred = now();
        let reference: Motion.Picture | undefined;

        const decoded = (frame: Frame) =>
          Effect.try({
            try: () => Motion.picture(frame),
            catch: (error) =>
              undispatched("ready", new Failed({ detail: `no picture: ${String(error)}` })),
          });

        // The background: what moved in up to eight frames of the document's 1.5 s before its
        // latest input, as far back as the capture keeps them.
        const inputAt =
          (yield* page.recentEvents).findLast((event) => event._tag === "Action")?.startedAt ??
          Number.NEGATIVE_INFINITY;

        const document = (yield* page.state).document;

        const before = (foreground ? yield* page.recentFrames : []).filter(
          (frame) =>
            frame.hostTime < inputAt &&
            frame.hostTime >= inputAt - 1500 &&
            frame.document === document,
        );

        const sampled = before.filter((_, index) => index % Math.ceil(before.length / 8) === 0);
        const mask = Motion.background(yield* Effect.forEach(sampled, decoded));
        // Where the page's overlay draws is not the page's motion: while it shows, frames are
        // compared, as in the foreground, outside everywhere it has drawn during the wait.
        let width: number | undefined;
        const covered = new Set(mask);

        const outside = (seen: Motion.Picture, overlay: ReadonlyArray<Box> | undefined) =>
          Effect.gen(function* () {
            if (overlay === undefined) return covered;
            width ??= (yield* page.viewport).width;
            for (const block of Motion.covering(overlay, seen.width / width, seen))
              covered.add(block);

            return covered;
          });

        // How long the screen has been still: since a frame, or an unanswered acknowledgement. In
        // the foreground, since a frame moved outside the background, or acknowledgements went
        // unanswered with no frame coming.
        const look = Effect.gen(function* () {
          const stats = yield* capture.stats();
          const { frame: latest } = yield* page.state;
          const overlay = Option.getOrUndefined(yield* Overlay.drawn(page));
          const comparing = foreground || overlay !== undefined;
          const arrived = stats.received !== counts.received;
          const unseen = stats.accepted - counts.accepted;

          counts = stats;
          if (latest === undefined || !capture.isCurrent(latest)) stirred = now();
          else if (!comparing ? arrived || stats.ackBacklog > 0 : !arrived && stats.ackBacklog > 0)
            stirred = now();
          else if (comparing && (unseen > 0 || reference === undefined)) {
            // A move and its return between looks both count. Bound decoding; any frames lost
            // from history, or beyond this batch, deny a quiet spell rather than hiding motion.
            const frames = (yield* page.recentFrames).slice(-Math.max(1, Math.min(8, unseen)));

            if (unseen > frames.length) stirred = now();
            for (const frame of frames) {
              const seen = yield* decoded(frame);

              if (
                reference === undefined ||
                Motion.stirs(reference, seen, yield* outside(seen, overlay))
              ) {
                reference = seen;
                stirred = now();
              }
            }
          }

          return now() - stirred;
        });

        // Decode at a fixed cadence: adding a delay after a full batch lets its backlog grow.
        const spell = Effect.repeat(look, {
          schedule: Schedule.fixed(Duration.millis(foreground ? 100 : 25)),
          until: (still) => still >= millis,
        });

        const still = Effect.gen(function* () {
          for (;;) {
            yield* spell;
            const before = counts.received;

            yield* Effect.all([settled(), capture.sync], { concurrency: 2, discard: true });
            if (
              (yield* look) >= millis &&
              (foreground ||
                Option.isSome(yield* Overlay.drawn(page)) ||
                counts.received === before)
            )
              return;
          }
        });

        return yield* Effect.raceFirst(
          capture.stream.pipe(Stream.runDrain, Effect.andThen(Effect.never)),
          still,
        );
      });

    yield* page.afterInput(Effect.void);
    if (options.still === "content") {
      yield* Change.read(page);
      yield* Effect.sleep(Duration.millis(quietMillis));

      return yield* settled();
    }
    yield* settled();
    yield* quiet(quietMillis);
  });

const waitStill = (page: Page, options: Options) =>
  Effect.gen(function* () {
    const quietMillis = millisOf(options.quiet);

    if (!Number.isFinite(quietMillis) || quietMillis < 0)
      return yield* refuse("stillness", "quiet must be a finite nonnegative duration");
    const timeoutMillis = millisOf(options.timeout ?? Duration.seconds(15));

    if (!Number.isFinite(timeoutMillis) || timeoutMillis < 0)
      return yield* refuse("stillness", "timeout must be a finite nonnegative duration");
    const duration = Duration.millis(timeoutMillis);

    return yield* observe(page, options, quietMillis, duration).pipe(
      Effect.timeoutOrElse({
        duration,
        orElse: () =>
          Effect.fail(
            undispatched("stillness", new Timeout({ millis: Duration.toMillis(duration) })),
          ),
      }),
    );
  }).pipe(
    Effect.scoped,
    Effect.provideService(Clock.Clock, page.hostClock),
    Effect.withSpan("Stillness.wait"),
  );

/**
 * Wait for a ready page to stay still for `quiet`: its screen, by default, with no screencast frame
 * coming; its `"foreground"`, allowing motion it showed before its latest input; or its
 * `"content"`, with no visible change recorded. Fails `Timeout` after `timeout`.
 */
export const wait: {
  (options: Options): (page: Page) => Effect.Effect<void, BrowserError>;
  (page: Page, options: Options): Effect.Effect<void, BrowserError>;
} = Function.dual(2, waitStill);
