/** H1's full hosted capture experiment: 30-second preparations and 20 cuts over five minutes. */
import { Deferred, Duration, Effect, Fiber, Option, Stream } from "effect";
import type * as Browser from "effect-browser/Browser";
import type { CaptureStats } from "effect-browser/Frame";
import * as Stage from "effect-browser/Stage";

import { refuse } from "./Budget.ts";
import * as Fixtures from "./FixtureRoutes.ts";

export const cuts = Array.from({ length: 20 }, (_, index) => ({
  index,
  prepareAtMillis: index * 15_000,
  eventAtMillis: 30_000 + index * 15_000,
}));

const origin = "https://h1.browser.test";

const animated = `<title>H1 canvas</title><canvas width="1280" height="720"></canvas><script>
const canvas = document.querySelector('canvas'), ctx = canvas.getContext('2d');
function paint(at) { ctx.fillStyle='hsl('+(at/30%360)+' 70% 40%)'; ctx.fillRect(0,0,1280,720);
ctx.fillStyle='white'; ctx.font='48px sans-serif'; ctx.fillText(String(Math.floor(at)),80,100);
requestAnimationFrame(paint); } requestAnimationFrame(paint);</script>`;

const loading = `<title>H1 loading work</title>${"<p>Third page load and read: controlled capture contention.</p>".repeat(16_384)}`;

const until = (browser: Browser.Service, at: number): Effect.Effect<void> =>
  browser.now.pipe(
    Effect.flatMap((now) =>
      now >= at
        ? Effect.void
        : Effect.sleep(Duration.millis(Math.ceil(at - now))).pipe(
            Effect.andThen(until(browser, at)),
          ),
    ),
  );

export const make = Effect.fnUntraced(function* (browser: Browser.Service) {
  const started = yield* Deferred.make<number>();

  const commits: Array<{
    index: number;
    readyAt: number;
    eventAt: number;
    shownAt: number;
    latency: number;
    stats: CaptureStats | null;
  }> = [];

  let measurementStart: number | undefined;
  let measurementEnd: number | undefined;
  let frames = 0;
  let previous: number | undefined;
  let maximumGapMillis = 0;
  let maximumPaintAgeMillis = 0;
  let loads = 0;
  const shown = { Painted: 0, Still: 0, Stalled: 0, Gone: 0 };

  const retained: Array<{
    page: number;
    firstAt?: number;
    lastAt?: number;
    frames: number;
    stats: CaptureStats | null;
  }> = [];

  const run = Effect.scoped(
    Effect.gen(function* () {
      yield* Fixtures.serve(origin + "/", (url) => ({
        _tag: "Fulfilled",
        status: 200,
        contentType: "text/html",
        body: url.pathname.includes("/load") ? loading : animated,
      }));
      const first = yield* browser.newPage(`${origin}/one`);
      const second = yield* browser.newPage(`${origin}/two`);
      const third = yield* browser.newPage();
      const stage = yield* Stage.make({ quality: 80, size: { width: 1280, height: 720 } });

      yield* stage.present(second);
      const epoch = yield* browser.now;

      const captures = [first, second].map((page, index) => {
        const sample: (typeof retained)[number] = { page: index + 1, frames: 0, stats: null };

        retained.push(sample);

        return page.screencast({ quality: 80, size: { width: 1280, height: 720 } }).pipe(
          Stream.runForEach(() =>
            Effect.gen(function* () {
              const at = yield* browser.now;

              sample.firstAt ??= at;
              sample.lastAt = at;
              if (measurementStart !== undefined) sample.frames++;
            }),
          ),
          Effect.andThen(refuse("H1 independently retained capture ended early")),
        );
      });

      const observe = stage.shown({ hold: "1 second" }).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            shown[event._tag]++;
            if (event._tag === "Gone") return yield* refuse("H1 output lost its current page");
            if (event._tag !== "Painted" || measurementStart === undefined) return;
            const at = yield* browser.now;

            if (event.frame.width !== 1280 || event.frame.height !== 720)
              return yield* refuse("H1 received an unexpected frame size");
            maximumGapMillis = Math.max(maximumGapMillis, at - (previous ?? measurementStart));
            maximumPaintAgeMillis = Math.max(maximumPaintAgeMillis, at - event.frame.hostTime);
            previous = at;
            frames++;
          }),
        ),
        Effect.andThen(refuse("H1 output stream ended before measurement completed")),
      );

      const load = Effect.forever(
        Effect.gen(function* () {
          yield* third.goto(`${origin}/load`);
          yield* third.text();
          loads++;
          yield* Effect.sleep("5 seconds");
        }),
      );

      const measure = Effect.gen(function* () {
        const reveals = yield* Effect.forEach(
          cuts,
          (cut) =>
            Effect.scoped(
              Effect.gen(function* () {
                yield* until(browser, epoch + cut.prepareAtMillis);
                const cue = yield* stage.cue(cut.index % 2 === 0 ? first : second);

                yield* cue.ready;
                const readyAt = yield* browser.now;

                // The event follows the first ready frame by 30 seconds; commit checks freshness again.
                yield* until(browser, Math.max(epoch + cut.eventAtMillis, readyAt + 30_000));
                const eventAt = yield* browser.now;
                const presented = yield* cue.commit({ at: eventAt });

                if (measurementStart === undefined) {
                  measurementStart = presented.at;
                  yield* Deferred.succeed(started, presented.at);
                }
                commits.push({
                  index: cut.index,
                  readyAt,
                  eventAt,
                  shownAt: presented.at,
                  latency: presented.latency,
                  stats: Option.getOrNull(yield* stage.stats()),
                });
              }),
            ),
          { concurrency: 3, discard: true },
        ).pipe(Effect.forkScoped);

        const beginning = yield* Effect.raceFirst(
          Deferred.await(started),
          Fiber.join(reveals).pipe(Effect.andThen(refuse("H1 completed without its first commit"))),
        );

        yield* Effect.raceFirst(
          until(browser, beginning + 300_000),
          Fiber.join(reveals).pipe(Effect.andThen(Effect.never)),
        );
        yield* Fiber.join(reveals);
        measurementEnd = yield* browser.now;
        maximumGapMillis = Math.max(maximumGapMillis, measurementEnd - (previous ?? beginning));
        yield* Effect.forEach([first, second], (page, index) =>
          Effect.gen(function* () {
            const sample = retained[index];

            if (
              sample === undefined ||
              sample.firstAt === undefined ||
              sample.firstAt > beginning ||
              sample.frames === 0
            )
              return yield* refuse("H1 did not retain both captures for the measured window");
            sample.stats = yield* page.captureStats();
          }),
        );
        if (commits.length !== 20 || frames === 0 || loads === 0)
          return yield* refuse("H1 did not complete its full capture experiment");
      });

      yield* Effect.raceAllFirst([measure, load, observe, ...captures]);
    }),
  );

  return {
    run,
    report: () => ({
      quality: 80,
      width: 1280,
      height: 720,
      measurementStart,
      measurementEnd,
      commits,
      frames,
      maximumGapMillis,
      maximumPaintAgeMillis,
      loads,
      shown,
      retained,
    }),
  };
});
