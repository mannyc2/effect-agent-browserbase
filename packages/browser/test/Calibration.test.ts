import { assert, describe, it } from "@effect/vitest";
import { Arbitrary, Effect, Option, Schema } from "effect";

import * as Clock from "../src/internal/pictures/clock.ts";

const between = (minimum: number, maximum: number) =>
  Arbitrary.schema(Schema.Finite.check(Schema.isBetween({ minimum, maximum })));

describe("Clock calibration", () => {
  it("keeps the true offset inside the full interval for asymmetric transports", () => {
    const offset = 5000;

    for (const [outbound, inbound] of [
      [5, 65],
      [140, 20],
    ] as const) {
      const result = Option.getOrThrow(
        Clock.estimate([
          {
            hostStart: 10_000,
            hostEnd: 10_000 + outbound + inbound,
            browserTime: 10_000 + outbound + offset,
          },
        ]),
      );

      assert.isAtMost(result.offsetMillis - result.uncertaintyMillis, offset);
      assert.isAtLeast(result.offsetMillis + result.uncertaintyMillis, offset);
      assert.strictEqual(result.uncertaintyMillis, (outbound + inbound) / 2);
      assert.notStrictEqual(result.offsetMillis, offset);
    }
  });

  it("uses the fastest complete probe without treating later receipts as exact clock evidence", () => {
    const result = Option.getOrThrow(
      Clock.estimate([
        { hostStart: 1000, hostEnd: 1100, browserTime: 10_050 },
        { hostStart: 2000, hostEnd: 2020, browserTime: 11_010 },
        { hostStart: 3000, hostEnd: 3400, browserTime: 12_020 },
      ]),
    );

    assert.deepStrictEqual(result, {
      offsetMillis: 9000,
      uncertaintyMillis: 10,
      roundTripMillis: 20,
      sampledAt: 2010,
    });
  });

  it("maps browser paint and CDP input stamps into one owner clock without mixing units", () => {
    const result = Option.getOrThrow(
      Clock.estimate([{ hostStart: 8000, hostEnd: 8040, browserTime: 1_700_000_000_020 }]),
    );

    const frame = 1_700_000_000_125;

    assert.strictEqual(Clock.toHostTime(result, frame), 8125);
    assert.strictEqual(Clock.toBrowserSeconds(result, 8125), frame / 1000);
    assert.strictEqual(
      Clock.toHostTime(result, 1_700_000_000_450) - Clock.toHostTime(result, frame),
      325,
    );
  });

  it.effect("keeps the browser's narrower estimate unless a measurement contradicts it", () =>
    Effect.gen(function* () {
      const precise = {
        offsetMillis: 1000,
        uncertaintyMillis: 1,
        roundTripMillis: 2,
        sampledAt: 0,
      };

      let now = 0;
      const mapping = Clock.mapping(() => now);

      // Each measurement comes ten seconds after the last, when the browser measures again.
      const renewed = <E>(measure: Effect.Effect<Clock.Estimate, E>) => {
        now += 10_000;

        return mapping.renew(measure).pipe(Effect.map(() => mapping.latest()));
      };

      const measured = (offsetMillis: number, uncertaintyMillis: number) =>
        Effect.suspend(() =>
          Effect.succeed({
            offsetMillis,
            uncertaintyMillis,
            roundTripMillis: uncertaintyMillis * 2,
            sampledAt: now,
          }),
        );

      assert.isUndefined(mapping.latest());
      assert.deepStrictEqual(yield* mapping.current(Effect.succeed(precise)), precise);
      // Within ten seconds of a measurement, the browser measures nothing.
      yield* mapping.renew(Effect.die("measured again too soon"));
      // A probe delayed behind a busy page agrees with the current estimate but says less.
      assert.deepStrictEqual(yield* renewed(measured(1060, 75)), precise);
      // A failed probe keeps the estimate the browser already holds.
      assert.deepStrictEqual(yield* renewed(Effect.fail("busy")), precise);
      // A no-worse probe is fresher evidence of the same offset.
      assert.strictEqual((yield* renewed(measured(1000.5, 1)))?.offsetMillis, 1000.5);
      // A measurement that cannot contain the current offset means the clocks moved.
      assert.strictEqual((yield* renewed(measured(1500, 30)))?.offsetMillis, 1500);
      assert.strictEqual(
        (yield* mapping.current(Effect.die("an estimate exists"))).offsetMillis,
        1500,
      );
    }),
  );

  it("says less about the offset the older an estimate is, so a wider, later one can replace it", () => {
    const sampled = { offsetMillis: 1000, uncertaintyMillis: 1, roundTripMillis: 2, sampledAt: 0 };
    const later = { ...sampled, uncertaintyMillis: 5, roundTripMillis: 10, sampledAt: 60_000 };

    assert.strictEqual(Clock.uncertaintyAt(sampled, 0), 1);
    assert.closeTo(Clock.uncertaintyAt(sampled, 60_000), 7, 1e-9);
    assert.isTrue(Clock.supersedes(later, sampled));
    assert.isFalse(Clock.supersedes(later, { ...sampled, sampledAt: 50_000 }));
  });

  // Every measurement's interval holds the true offset, as an honest probe's does, so they agree.
  it.prop(
    "keeps whichever of its measurements says most about the offset now",
    {
      measurements: Arbitrary.array(
        Arbitrary.all({
          error: between(-1, 1),
          uncertainty: between(0, 40),
          after: between(10_000, 600_000),
        }),
        { minLength: 1, maxLength: 8 },
      ),
    },
    ({ measurements }) => {
      const offset = 5000;
      const taken: Array<Clock.Estimate> = [];
      let now = 0;
      const mapping = Clock.mapping(() => now);

      for (const { error, uncertainty, after } of measurements) {
        now += after;

        const measured = {
          offsetMillis: offset + error * uncertainty,
          uncertaintyMillis: uncertainty,
          roundTripMillis: uncertainty * 2,
          sampledAt: now,
        };

        taken.push(measured);
        Effect.runSync(
          taken.length === 1
            ? Effect.asVoid(mapping.current(Effect.succeed(measured)))
            : mapping.renew(Effect.succeed(measured)),
        );
        const latest = mapping.latest();

        if (latest === undefined) throw new Error("the browser holds no estimate");
        const best = Math.min(...taken.map((estimate) => Clock.uncertaintyAt(estimate, now)));

        assert.isAtMost(Clock.uncertaintyAt(latest, now), best + 1e-9);
        assert.isAtMost(
          Math.abs(latest.offsetMillis - offset),
          Clock.uncertaintyAt(latest, now) + 1e-9,
        );
      }
    },
  );

  it("ignores invalid probes and cannot calibrate from backward or nonfinite host intervals", () => {
    const invalid = [
      { hostStart: 20, hostEnd: 10, browserTime: 1000 },
      { hostStart: Number.NaN, hostEnd: 10, browserTime: 1000 },
      { hostStart: 0, hostEnd: Infinity, browserTime: 1000 },
      { hostStart: 0, hostEnd: 10, browserTime: Number.NaN },
      { hostStart: -Number.MAX_VALUE, hostEnd: Number.MAX_VALUE, browserTime: 1000 },
    ];

    assert.isTrue(Option.isNone(Clock.estimate([])));
    assert.isTrue(Option.isNone(Clock.estimate(invalid)));
    assert.deepStrictEqual(
      Clock.estimate([...invalid, { hostStart: 100, hostEnd: 120, browserTime: 1110 }]),
      Option.some({
        offsetMillis: 1000,
        uncertaintyMillis: 10,
        roundTripMillis: 20,
        sampledAt: 110,
      }),
    );
  });
});
