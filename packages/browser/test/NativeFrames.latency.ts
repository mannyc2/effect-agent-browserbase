/** Optional native frame/input envelopes; ordinary tests retain identity and causal ordering. */
import { assert, layer } from "@effect/vitest";
import { Clock, Duration, Effect, Fiber, Random, Stream } from "effect";

import * as Presentation from "../src/presentation/Presentation.ts";
import * as Stage from "../src/presentation/Stage.ts";
import * as Chromium from "../src/providers/Chromium.ts";
import { unpaused } from "./fixtures.ts";
import { keys, setup } from "./support/InputRelay.ts";
import {
  animated,
  busy,
  busyContext,
  collect,
  eventually,
  session,
} from "./support/NativeFrames.ts";
import * as TestCdp from "./support/TestCdp.ts";

layer(TestCdp.provideLayer(Chromium.layer()), {
  excludeTestServices: true,
  timeout: Duration.seconds(60),
})("Native frame/input latency (opt-in)", (it) => {
  it.effect("calibrates a busy renderer's first frame within 450 ms uncertainty", () =>
    TestCdp.withCdp(
      Effect.gen(function* () {
        const browser = yield* busyContext();
        const page = yield* browser.newPage();

        yield* Effect.promise(() => TestCdp.nativePage(page).setContent(busy));
        yield* Effect.sleep("300 millis");
        const frames = yield* page.screencast().pipe(Stream.take(1), Stream.runCollect);

        assert.isAtMost(frames[0]?.timing.uncertaintyMillis ?? Infinity, 450);
      }),
    ),
  );

  it.effect("switches consecutive staged frame delivery with less than a 100 ms gap", () =>
    TestCdp.withCdp(
      Effect.gen(function* () {
        const { browser } = yield* session("latency-switch");
        const first = yield* browser.newPage(animated);
        const second = yield* browser.newPage(animated);
        const stage = yield* Stage.make();
        const frames = yield* collect(stage);

        yield* stage.present(first);
        yield* eventually(Effect.sync(() => frames.length >= 5));
        yield* stage.present(second);
        yield* eventually(
          Effect.sync(() => frames.filter((frame) => frame.page === second.id).length >= 5),
        );
        const turn = frames.findIndex((frame) => frame.page === second.id);

        assert.isBelow((frames.came[turn] ?? Infinity) - (frames.came[turn - 1] ?? 0), 100);
      }),
    ),
  );

  it.effect("finishes a scheduled cross-session cut within 500 ms of its requested time", () =>
    TestCdp.withCdp(
      Effect.gen(function* () {
        const one = yield* session("latency-one");
        const two = yield* session("latency-two");
        const first = yield* one.browser.newPage(animated);
        const second = yield* two.browser.newPage(animated);
        const stage = yield* Stage.make();
        const frames = yield* collect(stage);

        yield* stage.present(first);
        yield* eventually(Effect.sync(() => frames.length >= 5));
        const shown = yield* stage.present(second, { at: (yield* one.browser.now) + 800 });

        assert.isBelow(shown.latency, 500);
      }),
    ),
  );

  it.effect("presents on its owning clock within two seconds under a suspended caller clock", () =>
    TestCdp.withCdp(
      Effect.gen(function* () {
        const { browser } = yield* session("latency-clock");
        const page = yield* browser.newPage("data:text/html,<button>Clock</button>");

        const caller = Object.assign(Object.create(page.clock) as Clock.Clock, {
          monotonicTimeNanosUnsafe: () => 0n,
          sleep: () => Effect.never,
        });

        const presenter = yield* Presentation.make({
          pacing: { ...unpaused, unrelated: "10 millis" },
        }).pipe(Effect.provideService(Clock.Clock, caller));

        const view = presenter.view(page);

        yield* view.hover({ x: 100, y: 100 }).pipe(Effect.provideService(Clock.Clock, caller));
        const stage = yield* Stage.make().pipe(Effect.provideService(Clock.Clock, caller));

        const presented = yield* stage
          .present(view, { at: (yield* browser.now) + 30 })
          .pipe(Effect.provideService(Clock.Clock, caller));

        assert.isBelow(presented.latency, 2000);
      }),
    ),
  );

  it.effect("preserves typing hold/rate envelopes across 70 and 320 ms RTT", () =>
    TestCdp.withCdp(
      Effect.gen(function* () {
        const averages: Array<number> = [];

        for (const oneWayMillis of [35, 160]) {
          const relay = yield* setup(oneWayMillis);

          yield* relay.mapClock;
          yield* relay.page
            .type("Az09!? letter and cool blue sky")
            .pipe(Random.withSeed("remote-input"));
          const events = yield* keys(relay.page);
          const downs = events.filter((event) => event.type === "keydown");

          const holds = downs.map((down) => {
            const up = events.find(
              (event) => event.type === "keyup" && event.code === down.code && event.at > down.at,
            );

            assert.isDefined(up);

            return (up?.at ?? Infinity) - down.at;
          });

          const meanHold = holds.reduce((sum, hold) => sum + hold, 0) / holds.length;
          const gaps = downs.slice(1).map((event, index) => event.at - (downs[index]?.at ?? 0));
          const average = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;

          assert.isAbove(meanHold, 75);
          assert.isBelow(meanHold, 165);
          assert.isAbove(average, 110);
          assert.isBelow(average, 235);
          averages.push(average);
        }
        assert.isBelow(Math.abs((averages[1] ?? 0) - (averages[0] ?? 0)), 60);
      }),
    ),
  );

  it.effect("delivers a remapped capture with frame age below 400 ms", () =>
    TestCdp.withCdp(
      Effect.gen(function* () {
        const relay = yield* setup(35);

        yield* relay.mapClock;
        const firstDown = relay.watchNextDown();

        const typing = yield* relay.page
          .type("the quick brown fox")
          .pipe(Random.withSeed("clock-refresh"), Effect.forkChild);

        yield* Effect.promise(() => firstDown);
        relay.shiftClock();
        relay.age(10_000);
        const frames = yield* relay.page.screencast().pipe(Stream.take(1), Stream.runCollect);
        const frame = frames[0];

        assert.isDefined(frame);
        assert.isBelow((frame?.receivedAt ?? Infinity) - (frame?.hostTime ?? 0), 400);
        yield* Fiber.join(typing);
      }),
    ),
  );
});
