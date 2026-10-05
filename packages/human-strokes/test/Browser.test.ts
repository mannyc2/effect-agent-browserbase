import { assert, layer } from "@effect/vitest";
import { Duration, Effect, Layer, Random } from "effect";
import { Browser } from "effect-browser/Browser";
import * as Chromium from "effect-browser/Chromium";
import * as Motion from "effect-browser/Motion";

import * as HumanStrokes from "../src/index.ts";

const browserLayer = Chromium.layer({ humanize: true }).pipe(Layer.provide(HumanStrokes.layer));

layer(browserLayer, { excludeTestServices: true, timeout: Duration.seconds(60) })(
  "human-stroke browser integration",
  (it) => {
    it.effect("captures the supplied planner once and performs its exact published samples", () =>
      Effect.gen(function* () {
        const browser = yield* Browser;
        const page = yield* browser.page;

        yield* Effect.promise(() =>
          page.playwright.setContent(
            '<div id="position"></div><script>document.addEventListener("mousemove", event => { document.querySelector("#position").textContent = event.clientX + "," + event.clientY; });</script>',
          ),
        );
        const from = { x: 640, y: 360 };
        const to = { x: 796, y: 372 };

        const expected = yield* Effect.gen(function* () {
          const planner = yield* Motion.Motion;

          return yield* planner.plan(from, to).pipe(Random.withSeed(17));
        }).pipe(Effect.provide(HumanStrokes.layer));

        let replacementCalled = false;

        yield* page.hover(to).pipe(
          Random.withSeed(17),
          Effect.provideService(Motion.Motion, {
            plan: (_from, target) =>
              Effect.sync(() => {
                replacementCalled = true;

                return [{ ...target, afterMillis: 0 }];
              }),
          }),
        );
        const events = yield* browser.recentEvents;
        const plan = events.find((event) => event._tag === "TrackPlanned");

        assert.ok(plan?._tag === "TrackPlanned");
        assert.deepStrictEqual(plan.from, from);
        assert.deepStrictEqual(plan.samples, expected);
        assert.isFalse(replacementCalled);
        const performed = events.find((event) => event._tag === "TrackPerformed");

        assert.ok(performed?._tag === "TrackPerformed");
        assert.strictEqual(performed.dispatched, expected.length);
        assert.isTrue(performed.complete);
        assert.strictEqual(
          yield* Effect.promise(() => page.playwright.locator("#position").textContent()),
          "796,372",
        );
      }),
    );
  },
);
