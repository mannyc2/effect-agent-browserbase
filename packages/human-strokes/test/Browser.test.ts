import { assert, layer } from "@effect/vitest";
import { Duration, Effect, Random, Schema } from "effect";
import { Browser } from "effect-browser/Browser";
import * as Chromium from "effect-browser/Chromium";
import * as Presentation from "effect-browser/Presentation";

import * as HumanStrokes from "../src/index.ts";

layer(Chromium.layer(), { excludeTestServices: true, timeout: Duration.seconds(60) })(
  "human-stroke presentation",
  (it) => {
    it.effect("glides a view along the recorded strokes, exactly as planned", () =>
      Effect.gen(function* () {
        const browser = yield* Browser;
        const page = yield* browser.firstPage;

        yield* page.act(
          () => {
            document.body.innerHTML = '<div id="position"></div>';
            document.addEventListener("mousemove", (event) => {
              const output = document.querySelector("#position");

              if (output !== null) output.textContent = `${event.clientX},${event.clientY}`;
            });
          },
          { document: (yield* page.state).document, arg: undefined, result: Schema.Void },
        );
        const from = { x: 640, y: 360 };
        const to = { x: 796, y: 372 };
        const motion = yield* HumanStrokes.motion;
        const expected = yield* motion.plan(from, to).pipe(Random.withSeed(17));

        const presenter = yield* Presentation.make({
          motion,
          pacing: { ...Presentation.human, expected: 0, surprise: 0, unrelated: 0 },
        });

        yield* presenter.view(page).hover(to).pipe(Random.withSeed(17));
        const events = yield* browser.recentEvents;
        const plan = events.find((event) => event._tag === "TrackPlanned");

        assert.ok(plan?._tag === "TrackPlanned");
        assert.deepStrictEqual(plan.from, from);
        assert.deepStrictEqual(plan.samples, expected);
        const performed = events.find((event) => event._tag === "TrackPerformed");

        assert.ok(performed?._tag === "TrackPerformed");
        assert.strictEqual(performed.dispatched, expected.length);
        assert.isTrue(performed.complete);
        assert.strictEqual(
          (yield* page.read(() => document.querySelector("#position")?.textContent ?? "", {
            arg: undefined,
            result: Schema.String,
          })).value,
          "796,372",
        );
      }),
    );
  },
);
