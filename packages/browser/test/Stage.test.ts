// The stage over real Chromium: switches within one browser and across two, what each stamps and
// stops, a first frame that never comes, a capture that fails, and frames of other sizes.
import { assert, layer } from "@effect/vitest";
import { Clock, Duration, Effect, Option, Schedule, Stream } from "effect";
import type { CDPSession } from "playwright-core";

import { Browser, make as makeBrowser } from "../src/Browser.ts";
import * as Cdp from "../src/Cdp.ts";
import * as Chromium from "../src/Chromium.ts";
import type { Frame } from "../src/Frame.ts";
import * as Stage from "../src/Stage.ts";
import { behindProxy } from "./protocol.ts";

// A page that paints every frame, so its capture sends frames all the time.
const animated = `data:text/html,${encodeURIComponent(`<body style="margin:0"><canvas id=c width=300 height=300></canvas><script>
  const g = c.getContext("2d");
  (function draw(t) { g.fillStyle = "hsl(" + (t / 5 % 360) + ",80%,50%)"; g.fillRect(0, 0, 300, 300); requestAnimationFrame(draw); })(0);
</script></body>`)}`;

interface Sent {
  readonly target: unknown;
  readonly method: string;
  /** On the host monotonic clock, as the browser stamps frames. */
  readonly at: number;
}

/**
 * A browser over a context of its own, as one session: what its pages' own protocol sessions
 * sent, and a fault a test can plant for a page, answering a command itself instead.
 */
const session = Effect.fnUntraced(function* (id: string) {
  const native = (yield* Browser).context.browser();
  const clock = yield* Clock.Clock;

  if (native === null) return yield* Effect.die("the fixture requires local Chromium");

  const context = yield* Effect.acquireRelease(
    Effect.promise(() => native.newContext({ viewport: { width: 640, height: 400 } })),
    (context) => Effect.promise(() => context.close()),
  );

  const sent: Array<Sent> = [];
  const faults = new Map<unknown, (method: string) => Promise<unknown> | undefined>();
  const create = context.newCDPSession.bind(context);

  context.newCDPSession = async (target) => {
    const cdp = await create(target);
    const send = cdp.send.bind(cdp);

    const observed: CDPSession["send"] = (method, params) => {
      sent.push({ target, method, at: Number(clock.monotonicTimeNanosUnsafe()) / 1e6 });

      return (faults.get(target)?.(method) as ReturnType<typeof send> | undefined) ?? send(method, params);
    };

    cdp.send = observed;

    return cdp;
  };

  const browser = yield* makeBrowser(context, { id, provider: "test" });

  return { browser, sent, faults };
});

/** The stage's frames as they come, from now. */
const collect = Effect.fnUntraced(function* (stage: Stage.Stage) {
  const frames: Array<Frame> = [];

  yield* stage.frames.pipe(
    Stream.runForEach((frame) => Effect.sync(() => frames.push(frame))),
    Effect.forkScoped,
  );

  return frames;
});

const eventually = (check: Effect.Effect<boolean>) =>
  check.pipe(
    Effect.repeat({ until: (done) => done, schedule: Schedule.spaced("20 millis") }),
    Effect.timeout("10 seconds"),
  );

layer(Chromium.layer(), { excludeTestServices: true, timeout: Duration.seconds(60) })(
  "Stage",
  (it) => {
    it.effect("switches within a session at the new page's first frame, the old capture stopped first", () =>
      Effect.gen(function* () {
        const { browser, sent } = yield* session("one");
        const first = yield* browser.newPage(animated);
        const second = yield* browser.newPage(animated);
        const stage = yield* Stage.make();
        const frames = yield* collect(stage);

        yield* stage.present(first);
        yield* eventually(Effect.sync(() => frames.length >= 5));
        const asked = yield* browser.now;
        const shown = yield* stage.present(second, { at: asked });

        yield* eventually(Effect.sync(() => frames.filter((frame) => frame.page === second.id).length >= 5));
        const turn = frames.findIndex((frame) => frame.page === second.id);
        const before = frames.slice(0, turn);
        const after = frames.slice(turn);

        assert.isTrue(before.every((frame) => frame.page === first.id));
        assert.isTrue(after.every((frame) => frame.page === second.id));
        // The switch took effect after the frames it followed and the new page's first frame.
        assert.strictEqual(shown.page, second.id);
        assert.strictEqual(
          shown.at,
          Math.max(asked, after[0]?.hostTime ?? asked, before.at(-1)?.hostTime ?? asked),
        );
        assert.strictEqual(shown.latency, shown.at - asked);
        assert.isTrue(frames.every((frame) => frame.session === "one" && frame.url.startsWith("data:")));

        const at = (target: unknown, method: string) =>
          sent.findIndex((each) => each.target === target && each.method === method);

        assert.isAbove(at(first.playwright, "Page.stopScreencast"), -1);
        assert.isAbove(at(second.playwright, "Page.startScreencast"), at(first.playwright, "Page.stopScreencast"));
        assert.deepStrictEqual(yield* stage.current, Option.some(second));
        // Presenting what is on the stage again changes nothing.
        assert.deepStrictEqual(yield* stage.present(second), shown);
      }),
    );

    it.effect("switches across sessions at the time asked, with the new capture started ahead", () =>
      Effect.gen(function* () {
        const one = yield* session("one");
        const two = yield* session("two");
        const first = yield* one.browser.newPage(animated);
        const second = yield* two.browser.newPage(animated);
        const stage = yield* Stage.make();
        const frames = yield* collect(stage);

        yield* stage.present(first);
        yield* eventually(Effect.sync(() => frames.length >= 5));
        const asked = (yield* one.browser.now) + 800;
        const shown = yield* stage.present(second, { at: asked });
        const turn = frames.findIndex((frame) => frame.page === second.id);

        assert.isAtLeast(shown.at, asked);
        assert.isBelow(shown.latency, 500);
        // The first page stayed on the stage until the time asked, its frames painted before it.
        assert.isTrue(frames.slice(0, turn).every((frame) => frame.page === first.id));
        assert.isAbove(frames.slice(0, turn).filter((frame) => frame.hostTime > asked - 300).length, 0);
        assert.isTrue(frames.slice(0, turn).every((frame) => frame.hostTime <= shown.at));
        assert.isTrue(frames.slice(turn).every((frame) => frame.session === "two"));

        const started = two.sent.find((each) => each.method === "Page.startScreencast");
        const stopped = one.sent.find((each) => each.method === "Page.stopScreencast");

        assert.isBelow(started?.at ?? Infinity, asked - 300);
        assert.isAtLeast(stopped?.at ?? -Infinity, asked);
      }),
    );

    it.effect("fails a switch whose first frame is late, and the old page stays on the stage", () =>
      Effect.gen(function* () {
        const { browser, faults } = yield* session("late");
        const first = yield* browser.newPage(animated);
        const second = yield* browser.newPage(animated);
        const stage = yield* Stage.make({ firstFrame: "1 second" });
        const frames = yield* collect(stage);

        yield* stage.present(first);
        // The second page's capture starts, as far as the library can tell, and sends nothing.
        faults.set(second.playwright, (method) =>
          method === "Page.startScreencast" ? Promise.resolve({}) : undefined,
        );

        const failure = yield* stage.present(second).pipe(Effect.flip);

        assert.strictEqual(failure.reason._tag, "Timeout");
        assert.isFalse(failure.dispatched);
        assert.deepStrictEqual(yield* stage.current, Option.some(first));
        const count = frames.length;

        yield* eventually(Effect.sync(() => frames.length >= count + 5));
        assert.isTrue(frames.every((frame) => frame.page === first.id));
      }),
    );

    it.effect("restarts a capture that fails on the page it shows", () =>
      Effect.gen(function* () {
        const { browser, faults } = yield* session("restart");
        const page = yield* browser.newPage(animated);
        const stage = yield* Stage.make();
        const frames = yield* collect(stage);
        let failed = 0;

        yield* stage.present(page);
        yield* eventually(Effect.sync(() => frames.length >= 5));
        // A frame's acknowledgement fails once, which fails the capture.
        faults.set(page.playwright, (method) => {
          if (method !== "Page.screencastFrameAck" || failed > 0) return undefined;
          failed = Date.now();

          return Promise.reject(new Error("the acknowledgement was lost"));
        });
        yield* eventually(Effect.sync(() => failed > 0));
        const count = frames.length;

        yield* eventually(Effect.sync(() => frames.length >= count + 5));
        assert.isTrue(frames.every((frame) => frame.page === page.id));
        assert.deepStrictEqual(yield* stage.current, Option.some(page));
      }),
    );
  },
);

// Over CDP, where nothing emulates the viewport, a crop is drawn into the screencast at its own
// size; the page's capture leaves those frames out, so the stage never carries them.
layer(Chromium.layer(), { excludeTestServices: true, timeout: Duration.seconds(60) })(
  "Stage over CDP",
  (it) => {
    it.effect("carries no frame of another size while the page is cropped", () =>
      Effect.gen(function* () {
        const proxy = yield* behindProxy();
        const browser = yield* Cdp.open({ endpoint: proxy.endpoint });
        const page = yield* browser.newPage(animated);
        const stage = yield* Stage.make();
        const frames = yield* collect(stage);

        yield* stage.present(page);
        yield* eventually(Effect.sync(() => frames.length >= 3));
        for (let index = 0; index < 8; index++) {
          yield* page.zoom({ x: 10 * index, y: 0, width: 120, height: 200 });
          yield* Effect.sleep("50 millis");
        }
        yield* Effect.sleep("300 millis");

        const sizes = new Set(frames.map((frame) => `${frame.width}x${frame.height}`));
        const stats = yield* stage.stats({ window: "30 seconds" });

        assert.strictEqual(sizes.size, 1, [...sizes].join(", "));
        assert.isAbove(stats.filtered, 0);
        assert.strictEqual(stats.frames, frames.length);
      }).pipe(Effect.scoped),
    );
  },
);
