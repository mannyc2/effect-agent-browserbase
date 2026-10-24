// Visible changes on a real Chromium page, over a stand-in for TradingView's widget that answers
// one hotkey and shows none of the chart's toolbars, searches or dialogs.
import { assert, layer } from "@effect/vitest";
import { Duration, Effect } from "effect";
import { Browser } from "effect-browser/Browser";
import * as Chromium from "effect-browser/Chromium";

import * as Chart from "../src/Chart.ts";
import * as ChartInput from "../src/ChartInput.ts";
import { chartOn, recorded, time } from "./fixture.ts";

const charted = Effect.gen(function* () {
  const page = yield* (yield* Browser).newPage("about:blank");

  yield* chartOn(page);

  return page;
});

layer(Chromium.layer(), { excludeTestServices: true, timeout: Duration.seconds(60) })(
  "ChartInput",
  (it) => {
    it.effect("draws with the chart's hotkey, then puts a point the chart moved where asked", () =>
      Effect.gen(function* () {
        const page = yield* charted;
        const level = [{ time: time(70), price: 175.3 }];
        // The stand-in's magnet puts the level on bar 70's high, 172.
        const drawn = yield* ChartInput.draw(page, { shape: "horizontal_line", points: level });

        assert.deepStrictEqual(
          [drawn.name, drawn.points, drawn.via],
          ["horizontal_line", level, "corrected"],
        );
        assert.deepStrictEqual(
          (yield* Chart.state(page)).drawings.map(({ id, points }) => [id, points]),
          [[drawn.id, level]],
        );
      }),
    );

    it.effect(
      "makes a change through the chart's API where the chart shows no control for it",
      () =>
        Effect.gen(function* () {
          const page = yield* charted;

          const points = [
            { time: time(62), price: 160 },
            { time: time(95), price: 195 },
          ];

          const fib = yield* ChartInput.draw(page, { shape: "fib_retracement", points });

          assert.deepStrictEqual([fib.points, fib.via], [points, "api"]);
          // The stand-in selects nothing a click lands on.
          assert.strictEqual((yield* ChartInput.remove(page, fib.id)).via, "api");
          // Nor does its wheel move the view.
          const shown = yield* ChartInput.range(page, { from: time(80), to: time(99) });

          assert.strictEqual(shown.via, "api");
          assert.deepStrictEqual((yield* recorded(page)).calls, [
            { range: { from: time(80), to: time(99) } },
          ]);
          assert.deepStrictEqual((yield* Chart.state(page)).drawings, []);
        }),
    );
  },
);
