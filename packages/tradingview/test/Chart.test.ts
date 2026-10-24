// The chart module on a real Chromium page, over a stand-in for TradingView's widget.
import { assert, layer } from "@effect/vitest";
import { Arbitrary, Duration, Effect, Exit, Schema } from "effect";
import { Browser } from "effect-browser/Browser";
import * as Chromium from "effect-browser/Chromium";

import * as Chart from "../src/Chart.ts";
import { chartOn, hour, position, recorded, time } from "./fixture.ts";

const charted = Effect.gen(function* () {
  const page = yield* (yield* Browser).newPage("about:blank");

  yield* chartOn(page);

  return page;
});

layer(Chromium.layer(), { excludeTestServices: true, timeout: Duration.seconds(60) })(
  "Chart",
  (it) => {
    it.effect("reads what the chart shows and its bars, by default those in view", () =>
      Effect.gen(function* () {
        const page = yield* charted;
        const state = yield* Chart.state(page);

        assert.deepStrictEqual(state.view, { from: time(60), to: time(99) });
        assert.deepStrictEqual(state.bars, { loaded: 100, inView: 40 });
        assert.deepStrictEqual([state.symbol, state.resolution], ["DEMO:AAPL", "60"]);
        const inView = yield* Chart.bars(page);

        assert.strictEqual(inView.length, 40);
        assert.deepStrictEqual(inView[0], [time(60), 160, 162, 159, 161, 1000]);
        assert.deepStrictEqual(
          (yield* Chart.bars(page, { last: 3 })).map(([at]) => at),
          [time(97), time(98), time(99)],
        );
        const window = yield* Chart.bars(page, { from: time(49), to: time(51) });

        // A bar without a volume gives null.
        assert.deepStrictEqual(
          window.map((bar) => bar[5]),
          [1000, null, 1000],
        );
      }),
    );

    it.effect.prop(
      "places a bar's time and a price at their viewport point, and reads them back there",
      {
        marks: Arbitrary.schema(
          Schema.Array(
            Schema.Tuple([
              Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 99 })),
              Schema.Int.check(Schema.isBetween({ minimum: 150, maximum: 200 })),
            ]),
          ).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
        ),
      },
      ({ marks }) =>
        Effect.gen(function* () {
          const page = yield* charted;
          const points = marks.map(([index, price]) => ({ time: time(index), price }));
          const positions = yield* Chart.point(page, points);

          assert.deepStrictEqual(
            positions,
            marks.map(([index, price]) => position(index, price)),
          );
          assert.deepStrictEqual(
            yield* Chart.at(
              page,
              positions.flatMap((at) => (at === null ? [] : [at])),
            ),
            points,
          );
        }).pipe(Effect.scoped),
      { arbitrary: { runs: 12 } },
    );

    it.effect("places a time between bars at the nearest, and one past them as many bars on", () =>
      Effect.gen(function* () {
        const page = yield* charted;

        const positions = yield* Chart.point(page, [
          { time: time(70) + hour * 0.4, price: 180 },
          { time: time(70) + hour * 0.6, price: 180 },
          { time: time(99) + hour * 3, price: 180 },
        ]);

        assert.deepStrictEqual(positions, [
          position(70, 180),
          position(71, 180),
          position(102, 180),
        ]);
        // Left of the first bar in view, the chart has a time; off its bars, none.
        assert.deepStrictEqual(yield* Chart.at(page, [position(10, 180), position(120, 180)]), [
          { time: time(10), price: 180 },
          null,
        ]);
      }),
    );

    it.effect("changes the chart through its API", () =>
      Effect.gen(function* () {
        const page = yield* charted;

        const level = yield* Chart.draw(page, {
          shape: "horizontal_line",
          points: [{ time: time(99), price: 175 }],
        });

        const trend = yield* Chart.draw(page, {
          shape: "trend_line",
          points: [
            { time: time(60), price: 159 },
            { time: time(99), price: 201 },
          ],
        });

        yield* Chart.range(page, { from: time(80), to: time(99) });
        yield* Chart.symbol(page, "MSFT");
        yield* Chart.timeframe(page, "240");

        const study = yield* Chart.indicator(page, {
          name: "Relative Strength Index",
          inputs: { length: 21 },
        });

        const moved = [
          { time: time(70), price: 170 },
          { time: time(90), price: 190 },
        ];

        yield* Chart.move(page, { id: trend, points: moved });
        yield* Chart.remove(page, level);
        const state = yield* Chart.state(page);

        assert.deepStrictEqual(
          state.drawings.map(({ id, name, points }) => [id, name, points]),
          [[trend, "trend_line", moved]],
        );
        assert.deepStrictEqual([state.symbol, state.resolution], ["MSFT", "240"]);
        const { studies, calls } = yield* recorded(page);

        assert.deepStrictEqual(studies, [
          { id: study, name: "Relative Strength Index", inputs: { length: 21 } },
        ]);
        assert.deepStrictEqual(calls, [{ range: { from: time(80), to: time(99) } }]);
      }),
    );

    it.effect("reads a study's inputs as its settings show them, and its plots' values", () =>
      Effect.gen(function* () {
        const page = yield* charted;

        const study = yield* Chart.indicator(page, {
          name: "Relative Strength Index",
          inputs: { length: 21 },
        });

        assert.deepStrictEqual((yield* Chart.state(page)).studies, [
          {
            id: study,
            name: "Relative Strength Index",
            // Not the hidden source, nor the symbol, which the settings do not show.
            inputs: [
              { id: "length", name: "Length", value: 21 },
              { id: "smoothing", name: "Smoothing", value: "SMA" },
            ],
            // A colourer holds no value; a second plot of a title is told by its id.
            latest: { Plot: 99, "Plot plot_2": 198 },
          },
        ]);
        assert.deepStrictEqual(yield* Chart.values(page, { study, last: 2 }), {
          id: study,
          name: "Relative Strength Index",
          plots: ["Plot", "Plot plot_2"],
          rows: [
            [time(98), 98, 196],
            [time(99), 99, 198],
          ],
        });
        yield* Chart.inputs(page, { study, inputs: { length: 9, smoothing: "EMA" } });
        assert.deepStrictEqual(
          (yield* Chart.state(page)).studies[0]?.inputs.map(({ value }) => value),
          [9, "EMA"],
        );
        const unknown = yield* Effect.exit(Chart.values(page, { study: "nothing" }));

        assert.strictEqual(
          Exit.isFailure(unknown) && unknown.cause.reasons[0]?._tag === "Fail"
            ? unknown.cause.reasons[0].error.reason._tag
            : undefined,
          "NotFound",
        );
      }),
    );

    it.effect("fails NotFound on a page without a chart", () =>
      Effect.gen(function* () {
        const page = yield* (yield* Browser).newPage("about:blank");

        for (const exit of [
          yield* Effect.exit(Effect.asVoid(Chart.state(page))),
          yield* Effect.exit(Effect.asVoid(Chart.point(page, [{ time: time(1), price: 1 }]))),
          yield* Effect.exit(Chart.symbol(page, "MSFT")),
        ]) {
          assert.isTrue(Exit.isFailure(exit));
          assert.strictEqual(
            Exit.isFailure(exit) && exit.cause.reasons[0]?._tag === "Fail"
              ? exit.cause.reasons[0].error.reason._tag
              : undefined,
            "NotFound",
          );
        }
      }),
    );
  },
);
