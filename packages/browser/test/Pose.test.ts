// Element poses on local Chromium: where a posed element is drawn, read back through `layout`, and
// what is put back, refused and stepped on held time.
import * as Chromium from "@effect-browser/chromium/Chromium";
import { assert, layer } from "@effect/vitest";
import { Duration, Effect, Stream } from "effect";
import { PNG } from "playwright-core/lib/utilsBundle";

import { Browser } from "../src/Browser.ts";
import * as Change from "../src/Change.ts";
import * as Frame from "../src/Frame.ts";
import * as Layout from "../src/Layout.ts";
import type { Page } from "../src/Page.ts";
import * as PageTime from "../src/PageTime.ts";
import * as Pose from "../src/Pose.ts";
import * as Film from "../src/presentation/Film.ts";

// A button whose every property eases over a second, as many do, and a box the page centres on
// its left with a transform of its own.
const page = `data:text/html,${encodeURIComponent(`<!doctype html><style>
body { margin: 0; height: 2000px }
#box { position: absolute; left: 100px; top: 100px; width: 80px; height: 40px; margin: 0;
  padding: 0; border: 0; transition: all 1s }
#centred { position: absolute; left: 400px; top: 100px; width: 60px; height: 60px;
  transform: translateX(-50%); background: teal }
</style><button id=box>Box</button><div id=centred></div>
<svg id=icon width=20 height=20 style="position: absolute; left: 10px; top: 10px"><circle r=5 cx=10 cy=10 /></svg>`)}`;

const picks = {
  box: { selector: "#box" },
  centred: { selector: "#centred" },
  icon: { selector: "#icon" },
} as const;

const boxes = (page: Page) =>
  Effect.map(Layout.measure(page, picks), (layout) => ({
    box: Layout.place(layout, "box")?.box,
    centred: Layout.place(layout, "centred")?.box,
  }));

const near = (
  actual: { x: number; y: number; width: number; height: number } | undefined,
  expected: { x: number; y: number; width: number; height: number },
  what: string,
) => {
  for (const key of ["x", "y", "width", "height"] as const)
    assert.closeTo(actual?.[key] ?? Number.NaN, expected[key], 0.01, `${what}: ${key}`);
};

layer(Chromium.layer({ pageTime: true, deviceScaleFactor: 2 }), {
  excludeTestServices: true,
  timeout: Duration.seconds(60),
})("Pose.make", (it) => {
  it.effect("poses an element about a point where it is drawn, past the page's transitions", () =>
    Effect.gen(function* () {
      const browser = yield* Browser;
      const tab = yield* browser.newPage(page);
      const layout = yield* Layout.measure(tab, picks);
      const box = Layout.place(layout, "box")?.ref ?? "";
      const centred = Layout.place(layout, "centred")?.ref ?? "";
      const recorded = yield* Change.read(tab);

      near(
        Layout.place(layout, "centred")?.box,
        { x: 370, y: 100, width: 60, height: 60 },
        "as laid out",
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const poses = yield* Pose.make(tab);

          yield* poses.set([{ ref: box, dx: 10, dy: -5 }]);
          near((yield* boxes(tab)).box, { x: 110, y: 95, width: 80, height: 40 }, "moved");
          // Scaled about its bottom left, it keeps that corner.
          yield* poses.set([{ ref: box, sx: 2, sy: 0.5, origin: { x: 100, y: 140 } }]);
          near((yield* boxes(tab)).box, { x: 100, y: 120, width: 160, height: 20 }, "scaled");
          // A quarter turn about its middle, from the scaled pose.
          yield* poses.set([{ ref: box, rotate: 90 }]);
          near((yield* boxes(tab)).box, { x: 120, y: 80, width: 40, height: 80 }, "turned");
          // Its own transform holds beneath; a set takes the pose off what it leaves out.
          yield* poses.set([{ ref: centred, sx: 2, sy: 2 }]);
          const now = yield* boxes(tab);

          near(now.centred, { x: 340, y: 70, width: 120, height: 120 }, "centred, scaled");
          near(now.box, { x: 100, y: 100, width: 80, height: 40 }, "box, put back");
        }),
      );
      const after = yield* boxes(tab);

      near(after.centred, { x: 370, y: 100, width: 60, height: 60 }, "centred, put back");
      assert.deepStrictEqual((yield* Change.read(tab, { since: recorded })).changes, []);
    }),
  );

  // Lifting an element off the page is a picture of it at the screen's pixels and a pose that
  // scales it to nothing, which, as any transform, leaves the page laid out as it was.
  it.effect("lifts an element: its picture at device pixels, then posed to nothing", () =>
    Effect.gen(function* () {
      const browser = yield* Browser;
      const tab = yield* browser.newPage(page);

      const place = Layout.place(yield* Layout.measure(tab, picks), "box");
      const recorded = yield* Change.read(tab);

      if (place === undefined) return assert.fail("the box");
      const clip = { x: 95, y: 95, width: 90, height: 50 };

      const inked = (data: Uint8Array) =>
        PNG.sync
          .read(Buffer.from(data))
          .data.some((value, index) => index % 4 !== 3 && value < 200);

      const { image: picture } = yield* Frame.zoom(tab, clip, { format: "png", scale: "device" });

      assert.deepStrictEqual([picture.width, picture.height], [180, 100]);
      assert.isTrue(inked(picture.data), "the box's picture");
      const poses = yield* Pose.make(tab);

      yield* poses.set([{ ref: place.ref, sx: 0, sy: 0 }]);
      const { image: lifted } = yield* Frame.zoom(tab, clip, { format: "png", scale: "device" });

      assert.isFalse(inked(lifted.data), "nothing where the box was");
      assert.deepStrictEqual((yield* Change.read(tab, { since: recorded })).changes, []);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a second lease, a stale ref, a drawing, and numbers that are not finite", () =>
    Effect.gen(function* () {
      const browser = yield* Browser;
      const tab = yield* browser.newPage(page);
      const layout = yield* Layout.measure(tab, picks);
      const box = Layout.place(layout, "box")?.ref ?? "";
      const icon = Layout.place(layout, "icon")?.ref ?? "";
      const poses = yield* Pose.make(tab);

      const reason = <A, E extends { reason: { _tag: string } }>(effect: Effect.Effect<A, E>) =>
        Effect.map(Effect.flip(effect), (error) => error.reason._tag);

      assert.strictEqual(yield* reason(Effect.scoped(Pose.make(tab))), "InvalidRequest");
      assert.strictEqual(yield* reason(poses.set([{ ref: icon, dx: 1 }])), "InvalidRequest");
      assert.strictEqual(
        yield* reason(poses.set([{ ref: box, dx: Number.NaN }])),
        "InvalidRequest",
      );
      yield* tab.goto(page);
      assert.strictEqual(yield* reason(poses.set([{ ref: box, dx: 1 }])), "StaleRef");
    }).pipe(Effect.scoped),
  );

  it.effect("poses on held time in the step that moves it, and a stale ref moves nothing", () =>
    Effect.gen(function* () {
      const browser = yield* Browser;
      const tab = yield* browser.newPage(page);
      const box = Layout.place(yield* Layout.measure(tab, picks), "box")?.ref ?? "";
      const time = yield* PageTime.hold(tab);
      const step = { scroll: 50, poses: [{ ref: box, dy: 30 }] };

      assert.strictEqual(
        (yield* Effect.flip(time.advance("10 millis", step))).reason._tag,
        "InvalidRequest",
        "the poses are not open",
      );
      yield* Pose.make(tab);
      assert.deepStrictEqual(yield* time.advance("10 millis", step), { x: 0, y: 50 });
      near((yield* boxes(tab)).box, { x: 100, y: 80, width: 80, height: 40 }, "posed, scrolled");

      const stale = yield* Effect.flip(
        time.advance("10 millis", { scroll: 200, poses: [{ ref: "e999", dy: 1 }] }),
      );

      assert.strictEqual(stale.reason._tag, "StaleRef");
      assert.strictEqual(
        (yield* time.advance("0 millis")).y,
        50,
        "the stale step scrolled nothing",
      );

      // A film poses only on held time.
      const real = yield* Effect.flip(
        Film.frames(tab, {
          times: [0],
          time: "real",
          at: () => Effect.succeed({ poses: [{ ref: box, dy: 1 }] }),
        }).pipe(Stream.runDrain),
      );

      assert.strictEqual(real.reason._tag, "InvalidRequest");
    }).pipe(Effect.scoped),
  );
});
