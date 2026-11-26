/** Viewport geometry and bounded input schedules, independent of presentation planners. */
import { Effect, Random, Schema } from "effect";

export const maximumSamples = 2048;
export const maximumDurationMillis = 5000;

export const Point = Schema.Struct({ x: Schema.Finite, y: Schema.Finite });
export type Point = typeof Point.Type;

export const Sample = Schema.Struct({
  ...Point.fields,
  afterMillis: Schema.Finite.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(maximumDurationMillis),
  ),
});

export type Sample = typeof Sample.Type;

/** A complete glide: 1 to 2,048 samples whose offsets never decrease. */
export const Plan = Schema.Array(Sample).check(
  Schema.isBetweenLength(1, maximumSamples),
  Schema.makeFilter(
    (samples) =>
      samples.every(
        (sample, index) => sample.afterMillis >= (samples[index - 1]?.afterMillis ?? 0),
      ),
    { expected: "nondecreasing sample offsets" },
  ),
);

export type Plan = typeof Plan.Type;

export interface Planner {
  /**
   * Offsets start when the performer publishes the plan, before its first input. The browser
   * decodes the result as a `Plan` whose last sample must be exactly `to`. Glide time has a budget
   * of its own, outside the browser's `actionTimeout`, so a drag may glide twice for 5 seconds.
   */
  readonly plan: (from: Point, to: Point) => Effect.Effect<ReadonlyArray<Sample>>;
}

/** One standard normal draw from the current seeded Effect random source. */
export const normal = Effect.gen(function* () {
  const radius = Math.sqrt(-2 * Math.log(1 - (yield* Random.next)));

  return radius * Math.cos(2 * Math.PI * (yield* Random.next));
});
