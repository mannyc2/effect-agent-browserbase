import { assert, layer } from "@effect/vitest";
import { Clock, Duration, Effect, Layer, Schedule, Stream } from "effect";
import { TestClock } from "effect/testing";

import { Browser, make as makeBrowser, type Options } from "../src/Browser.ts";
import * as Chromium from "../src/Chromium.ts";
import type { Frame } from "../src/Frame.ts";
import * as Moment from "../src/Moment.ts";
import * as Presentation from "../src/Presentation.ts";
import { Site, SiteLayer } from "./fixtures.ts";

const refOf = (text: string, role: string, name: string) =>
  new RegExp(`${role} "${name}"[^\\n]*?\\[ref=(e\\d+)\\]`).exec(text)?.[1];

const controlledClock = (
  live: Clock.Clock,
  time: { wall: number; monotonic: number },
): Clock.Clock => ({
  currentTimeMillisUnsafe: () => time.wall,
  currentTimeMillis: Effect.sync(() => time.wall),
  currentTimeNanosUnsafe: () => BigInt(time.wall) * 1_000_000n,
  currentTimeNanos: Effect.sync(() => BigInt(time.wall) * 1_000_000n),
  monotonicTimeNanosUnsafe: () => BigInt(time.monotonic) * 1_000_000n,
  monotonicTimeNanos: Effect.sync(() => BigInt(time.monotonic) * 1_000_000n),
  // Protocol work uses real sleeps; only the readings are controlled by each test.
  sleep: (duration) => live.sleep(duration),
});

const setup = Effect.fnUntraced(function* (clock: Clock.Clock, options: Options = {}) {
  const host = yield* Browser;
  const native = host.context.browser();

  if (native === null) return yield* Effect.die("the fixture requires a launched Chromium");

  const context = yield* Effect.acquireRelease(
    Effect.promise(() => native.newContext({ viewport: { width: 1280, height: 720 } })),
    (context) => Effect.promise(() => context.close()),
  );

  const browser = yield* makeBrowser(context, { id: "clock-test", provider: "test" }, options).pipe(
    Effect.provideService(Clock.Clock, clock),
  );

  const page = yield* browser.newPage();

  return { browser, page };
});

layer(Layer.mergeAll(Chromium.layer(), SiteLayer), {
  excludeTestServices: true,
  timeout: Duration.seconds(60),
})("Clock", (it) => {
  it.effect("keeps action durations and observations monotonic when wall time moves backward", () =>
    Effect.gen(function* () {
      const time = { wall: 1_900_000_000_000, monotonic: 1000 };
      const clock = controlledClock(yield* Clock.Clock, time);

      const { browser, page } = yield* setup(clock, {
        guard: () =>
          Effect.sync(() => {
            time.wall -= 3_600_000;
            time.monotonic += 100;
          }),
      });

      yield* page.goto((yield* Site).url("/form"));
      yield* page.click({ x: 20, y: 20 });
      const observation = yield* page.state;
      const events = yield* browser.recentEvents;
      const actions = events.filter((event) => event._tag === "Action");

      assert.deepStrictEqual(
        actions.map((event) => [event.name, event.startedAt, event.at]),
        [
          ["navigate", 1000, 1100],
          ["click", 1100, 1200],
        ],
      );
      assert.deepStrictEqual(
        events
          .filter((event) => ["PageOpened", "Navigated", "Action"].includes(event._tag))
          .map((event) => event.at),
        [1000, 1100, 1100, 1200],
      );
      assert.strictEqual(observation.at, 1200);
      assert.strictEqual(yield* browser.now, 1200);
      assert.isTrue(events.every((event) => event.at >= 1000 && event.at <= 1200));
      assert.deepStrictEqual(
        events.map((event) => event.at),
        events.map((event) => event.at).toSorted((left, right) => left - right),
      );
      assert.doesNotThrow(() => JSON.stringify({ events, at: observation.at }));
    }),
  );

  it.effect(
    "captures frame and event windows on the owner clock even under a caller clock override",
    () =>
      Effect.gen(function* () {
        const live = yield* Clock.Clock;
        const time = { wall: 1_900_000_000_000, monotonic: 5000 };
        const { page } = yield* setup(controlledClock(live, time));

        yield* page.goto((yield* Site).url("/form"));

        const frames = yield* page
          .screencast()
          .pipe(Stream.take(1), Stream.runCollect, Effect.timeout(Duration.seconds(10)));

        const frame = frames[0];

        assert.isDefined(frame);
        if (frame === undefined) return;
        assert.strictEqual(frame.receivedAt, 5000);
        // CDP paint time stays in its separate epoch domain.
        assert.strictEqual(frame.timing._tag, "BrowserPaint");
        assert.isAbove(frame.timestamp ?? 0, 1_000_000_000_000);
        assert.closeTo(frame.hostTime, 5000, 1000);
        time.wall -= 3_600_000;
        time.monotonic = 5500;
        const callerTime = { wall: 1_800_000_000_000, monotonic: 900_000 };

        const capture = Moment.capture(page, { since: Duration.seconds(1) }).pipe(
          Effect.provideService(Clock.Clock, controlledClock(live, callerTime)),
        );

        const moment = yield* capture;

        assert.strictEqual(moment.until, 5500);
        // That capture has stopped, so its frame leads up to a new screenshot of the moment.
        assert.strictEqual(moment.frames.length, 2);
        assert.strictEqual(moment.frames[0], frame);
        assert.strictEqual(moment.frames[1]?.timing._tag, "Screenshot");
        assert.strictEqual(moment.frames[1]?.hostTime, 5500);
        assert.isAbove(moment.events.length, 0);
        assert.isTrue(moment.events.every((event) => event.at === 5000));
        assert.include(
          Moment.toPrompt(moment)
            .content.flatMap((message) =>
              message.role === "user"
                ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
                : [],
            )
            .join("\n"),
          "-0.5s navigated",
        );

        time.monotonic = 7000;
        const later = yield* capture;

        assert.strictEqual(later.until, 7000);
        assert.isEmpty(later.events);
        assert.strictEqual(later.frames[0]?.receivedAt, 7000);
        assert.strictEqual(later.frames[0]?.timestamp, undefined);
        assert.strictEqual(later.frames[0]?.timing._tag, "Screenshot");
        assert.strictEqual(later.frames[0]?.hostTime, 7000);
      }),
  );
  // A capture on air runs for hours, so its frames must not keep the estimate it started with.
  it.effect("times a running capture's later frames by the browser's newest clock estimate", () =>
    Effect.gen(function* () {
      const time = { wall: 1_900_000_000_000, monotonic: 5000 };
      const { page } = yield* setup(controlledClock(yield* Clock.Clock, time));
      const frames: Array<Frame> = [];

      yield* page.goto(
        "data:text/html,<canvas id=c width=300 height=300></canvas><script>const g=c.getContext('2d');(function f(t){g.fillStyle='hsl('+(t/5%360)+',80%,50%)';g.fillRect(0,0,300,300);requestAnimationFrame(f)})(0)</script>",
      );
      yield* page.screencast().pipe(
        Stream.runForEach((frame) => Effect.sync(() => frames.push(frame))),
        Effect.forkScoped,
      );

      const paintedAfter = (hostTime: number) =>
        Effect.sync(() => frames.at(-1)?.hostTime ?? Number.NEGATIVE_INFINITY).pipe(
          Effect.repeat({ until: (newest) => newest > hostTime, schedule: Schedule.spaced(20) }),
          Effect.timeout("5 seconds"),
        );

      yield* paintedAfter(0);
      assert.closeTo(frames[0]?.hostTime ?? 0, 5000, 1000);
      // A minute on by the owner's clock, the estimate is due again: the capture measures it while
      // its frames flow, finds the clocks moved, and times its later frames by the new estimate.
      time.monotonic += 60_000;
      yield* paintedAfter(60_000);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps page pacing and deadlines on the owner clock under a caller's TestClock", () =>
    Effect.gen(function* () {
      const live = yield* Clock.Clock;

      const { browser, page: plain } = yield* setup(live, { actionTimeout: Duration.seconds(5) });
      const page = (yield* Presentation.make()).view(plain);
      const site = yield* Site;

      // A caller's TestClock never advances on its own; the browser must not sleep on it.
      const caller = <A, E>(effect: Effect.Effect<A, E>) =>
        effect.pipe(Effect.provide(TestClock.layer()));

      yield* page.goto(site.url("/form"));
      const other = yield* browser.newPage(site.url("/form"));
      const amount = refOf((yield* page.snapshot()).text, "textbox", "Amount");

      assert.isDefined(amount);
      if (amount === undefined) return;

      // A stalled caller-clock action would also hold the browser-wide input lock from `other`.
      yield* Effect.all([caller(page.click(amount)), other.click({ x: 400, y: 500 })], {
        concurrency: 2,
      }).pipe(Effect.timeout("20 seconds"));
      yield* Effect.all(
        [
          caller(page.type("12", { into: amount })),
          caller(page.press("ArrowLeft", { holdMillis: 50 })),
          caller(page.scroll({ dy: 200 })),
        ],
        { concurrency: 1 },
      ).pipe(Effect.timeout("30 seconds"));
      assert.strictEqual(
        yield* Effect.promise(() => page.playwright.locator("#amount").inputValue()),
        "12",
      );

      // A deadline measured on the caller's clock would never expire.
      const missing = yield* caller(page.waitForText("never shown", Duration.millis(300))).pipe(
        Effect.flip,
        Effect.timeout("5 seconds"),
      );

      assert.strictEqual(missing.reason._tag, "NotFound");
    }),
  );
});
