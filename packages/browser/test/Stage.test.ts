// The stage over real Chromium: switches within one browser and across two, what each stamps and
// stops, a first frame that never comes, a capture that fails, and frames of other sizes.
import { assert, layer } from "@effect/vitest";
import { Duration, Effect, Fiber, Option } from "effect";

import { behindProxy } from "../../../tools/testing/cdp-proxy.ts";
import * as Stage from "../src/presentation/Stage.ts";
import * as Cdp from "../src/providers/Cdp.ts";
import * as Chromium from "../src/providers/Chromium.ts";
import { animated, collect, eventually, session } from "./support/NativeFrames.ts";
import * as TestCdp from "./support/TestCdp.ts";

layer(TestCdp.provideLayer(Chromium.layer()), {
  excludeTestServices: true,
  timeout: Duration.seconds(60),
})("Stage", (it) => {
  // Two captures fit in one session, as on Browserbase, so a switch there overlaps them too.
  it.effect("switches within a session with no dark spell, the captures overlapping", () =>
    TestCdp.withCdp(
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

        yield* eventually(
          Effect.sync(() => frames.filter((frame) => frame.page === second.id).length >= 5),
        );
        const turn = frames.findIndex((frame) => frame.page === second.id);
        const before = frames.slice(0, turn);
        const after = frames.slice(turn);

        assert.isTrue(before.every((frame) => frame.page === first.id));
        assert.isTrue(after.every((frame) => frame.page === second.id));
        // The switch took effect after the frames it followed and the new page's first frame.
        assert.strictEqual(shown.page, second.id);
        assert.isAtLeast(
          shown.at,
          Math.max(asked, after[0]?.hostTime ?? asked, before.at(-1)?.hostTime ?? asked),
        );
        assert.strictEqual(shown.latency, shown.at - asked);
        assert.isTrue(
          frames.every((frame) => frame.session === "one" && frame.url.startsWith("data:")),
        );
        assert.isAtLeast(frames.came[turn] ?? -Infinity, frames.came[turn - 1] ?? Infinity);

        const at = (target: unknown, method: string) =>
          sent.findIndex((each) => each.target === target && each.method === method);

        assert.isAbove(at(TestCdp.nativePage(second), "Page.startScreencast"), -1);
        assert.isAbove(
          at(TestCdp.nativePage(first), "Page.stopScreencast"),
          at(TestCdp.nativePage(second), "Page.startScreencast"),
        );
        assert.deepStrictEqual(yield* stage.current, Option.some(second));
        // Presenting what is on the stage again changes nothing.
        assert.deepStrictEqual(yield* stage.present(second), shown);
      }),
    ),
  );

  it.effect("switches across sessions at the time asked, with the new capture started ahead", () =>
    TestCdp.withCdp(
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
        assert.strictEqual(shown.latency, shown.at - asked);
        // The first page stayed on the stage until the time asked, its frames painted before it.
        assert.isTrue(frames.slice(0, turn).every((frame) => frame.page === first.id));
        assert.isAbove(
          frames.slice(0, turn).filter((frame) => frame.hostTime > asked - 300).length,
          0,
        );
        assert.isTrue(frames.slice(0, turn).every((frame) => frame.hostTime <= shown.at));
        assert.isTrue(frames.slice(turn).every((frame) => frame.session === "two"));

        const started = two.sent.find((each) => each.method === "Page.startScreencast");
        const stopped = one.sent.find((each) => each.method === "Page.stopScreencast");

        assert.isBelow(started?.at ?? Infinity, asked - 300);
        assert.isAtLeast(stopped?.at ?? -Infinity, asked);
      }),
    ),
  );

  it.effect("turns only once input under way on the old page has ended", () =>
    TestCdp.withCdp(
      Effect.gen(function* () {
        const { browser } = yield* session("one");
        const first = yield* browser.newPage(animated);
        const second = yield* browser.newPage(animated);
        const stage = yield* Stage.make();

        yield* stage.present(first);

        const pressing = yield* first
          .press("Shift", { holdMillis: 1500 })
          .pipe(Effect.andThen(browser.now), Effect.forkScoped);

        yield* Effect.sleep("200 millis");
        yield* stage.present(second);
        const turned = yield* browser.now;

        assert.isAtLeast(turned, yield* Fiber.join(pressing));
      }),
    ),
  );

  it.effect("fails a switch whose first frame is late, and the old page stays on the stage", () =>
    TestCdp.withCdp(
      Effect.gen(function* () {
        const { browser, faults } = yield* session("late");
        const first = yield* browser.newPage(animated);
        const second = yield* browser.newPage(animated);
        const stage = yield* Stage.make({ firstFrame: "1 second" });
        const frames = yield* collect(stage);

        yield* stage.present(first);
        // The second page's capture starts, as far as the library can tell, and sends nothing.
        faults.rule(
          { page: second.id, method: "Page.startScreencast" },
          { _tag: "Reply", value: {} },
        );

        const failure = yield* stage.present(second).pipe(Effect.flip);

        assert.strictEqual(failure.reason._tag, "Timeout");
        assert.isFalse(failure.dispatched);
        assert.deepStrictEqual(yield* stage.current, Option.some(first));
        const count = frames.length;

        yield* eventually(Effect.sync(() => frames.length >= count + 5));
        assert.isTrue(frames.every((frame) => frame.page === first.id));
      }),
    ),
  );

  it.effect("restarts a capture that fails on the page it shows", () =>
    TestCdp.withCdp(
      Effect.gen(function* () {
        const { browser, faults } = yield* session("restart");
        const page = yield* browser.newPage(animated);
        const stage = yield* Stage.make();
        const frames = yield* collect(stage);

        yield* stage.present(page);
        yield* eventually(Effect.sync(() => frames.length >= 5));

        // A frame's acknowledgement fails once, which fails the capture.
        const before = faults.calls.filter(
          ({ method }) => method === "Page.screencastFrameAck",
        ).length;

        faults.rule(
          { page: page.id, method: "Page.screencastFrameAck" },
          { _tag: "Fail", error: new Error("the acknowledgement was lost") },
          { times: 1 },
        );
        yield* faults.waitUntil(
          (calls) =>
            calls.filter(({ method }) => method === "Page.screencastFrameAck").length > before,
        );
        const count = frames.length;

        yield* eventually(Effect.sync(() => frames.length >= count + 5));
        assert.isTrue(frames.every((frame) => frame.page === page.id));
        assert.deepStrictEqual(yield* stage.current, Option.some(page));
      }),
    ),
  );
});

// Over CDP, where nothing emulates the viewport, a crop is drawn into the screencast at its own
// size; the page's capture leaves those frames out, so the stage never carries them.
layer(TestCdp.provideLayer(Chromium.layer()), {
  excludeTestServices: true,
  timeout: Duration.seconds(60),
})("Stage over CDP", (it) => {
  it.effect("carries no frame of another size while the page is cropped", () =>
    TestCdp.withCdp(
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
        const carried = frames.length;
        const stats = Option.getOrThrow(yield* stage.stats({ window: "30 seconds" }));

        assert.strictEqual(sizes.size, 1, [...sizes].join(", "));
        assert.isAbove(stats.foreignSize + stats.duringPictures, 0);
        assert.isAtLeast(stats.accepted, carried);
        // No frame goes out twice.
        assert.strictEqual(new Set(frames.map((frame) => frame.timestamp)).size, frames.length);
      }).pipe(Effect.scoped),
    ),
  );
});
