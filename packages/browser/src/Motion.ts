/**
 * Pointer motion as a complete, bounded schedule, independent of browser input and transport.
 * A browser captures this service once; an optional layer can replace the default planner.
 *
 * @since 0.3.0
 */
import { Context, Effect, Random, Schema } from "effect";

export const maximumSamples = 2048;
export const maximumDurationMillis = 5000;

export const Point = Schema.Struct({ x: Schema.Finite, y: Schema.Finite });
export type Point = typeof Point.Type;

export const Sample = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
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

export interface Service {
  /**
   * Offsets start when the performer publishes the plan, before its first input. The browser
   * decodes the result as a `Plan` whose last sample must be exactly `to`. Glide time counts
   * against the browser's `actionTimeout`, and one action can glide more than once: a drag
   * performs two glides, so two 5-second plans exceed the 10-second default.
   */
  readonly plan: (from: Point, to: Point) => Effect.Effect<ReadonlyArray<Sample>>;
}

// These are the research's tuned two-stroke parameters. Width scaling was not evaluated, so the
// model keeps its 40px reference width rather than implying measured target-size behavior.
const tuning = {
  intercept: 115.8,
  slope: 291.8,
  durationSigma: 0.407,
  amplitude: 0.989,
  amplitudeSigma: 0.138,
  lateral: 0.0934,
  primaryDuration: 0.512,
  correctionDuration: 0.586,
  overlap: 0.452,
  sigmaLow: 0.155,
  sigmaHigh: 0.53,
} as const;

const sampleMillis = 16.7;

const normal = Effect.gen(function* () {
  const radius = Math.sqrt(-2 * Math.log(1 - (yield* Random.next)));

  return radius * Math.cos(2 * Math.PI * (yield* Random.next));
});

// Abramowitz-Stegun 7.1.26 supplies erf without another runtime dependency (error < 1.5e-7).
const erf = (value: number) => {
  const x = Math.abs(value);
  const t = 1 / (1 + 0.3275911 * x);

  const polynomial =
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;

  return Math.sign(value) * (1 - polynomial * Math.exp(-x * x));
};

const cumulative = (time: number, onset: number, mu: number, sigma: number) =>
  time <= onset ? 0 : (1 + erf((Math.log(time - onset) - mu) / (sigma * Math.SQRT2))) / 2;

const plan: Service["plan"] = Effect.fnUntraced(function* (from, to) {
  // Work in normalized coordinates so finite extreme inputs cannot overflow the displacement.
  const scale = Math.max(1, Math.abs(from.x), Math.abs(from.y), Math.abs(to.x), Math.abs(to.y));
  const startX = from.x / scale;
  const startY = from.y / scale;
  const deltaX = to.x / scale - startX;
  const deltaY = to.y / scale - startY;
  const distance = Math.hypot(deltaX, deltaY);

  if (distance * scale < 2) return [{ ...to, afterMillis: 0 }];
  const unitX = deltaX / distance;
  const unitY = deltaY / distance;

  const drawnDuration =
    (tuning.intercept + tuning.slope * Math.log2(1 + distance * (scale / 40))) *
    Math.exp((yield* normal) * tuning.durationSigma);

  const endFactor = Math.max(
    tuning.primaryDuration,
    tuning.overlap * tuning.primaryDuration + tuning.correctionDuration,
  );

  // Bound the duration before evaluating either stroke: dropping a sampled tail would remove
  // its homing correction. The last regular 16.7ms sample remains inside the public time bound.
  const lastRegularSample = Math.floor(maximumDurationMillis / sampleMillis) * sampleMillis;
  const duration = Math.min(drawnDuration, lastRegularSample / endFactor);
  const amplitude = distance * (tuning.amplitude + (yield* normal) * tuning.amplitudeSigma);
  const angle = ((yield* normal) * Math.PI) / 60;
  const primaryX = amplitude * (unitX * Math.cos(angle) - unitY * Math.sin(angle));
  const primaryY = amplitude * (unitY * Math.cos(angle) + unitX * Math.sin(angle));
  const sigma1 = yield* Random.nextBetween(tuning.sigmaLow, tuning.sigmaHigh);
  const primaryDuration = tuning.primaryDuration * duration;
  const mu1 = Math.log(primaryDuration / (Math.exp(3 * sigma1) - Math.exp(-3 * sigma1)));
  const onset1 = -Math.exp(mu1 - 3 * sigma1);
  const sigma2 = yield* Random.nextBetween(tuning.sigmaLow, tuning.sigmaHigh);
  const correctionDuration = tuning.correctionDuration * duration;
  const mu2 = Math.log(correctionDuration / (Math.exp(3 * sigma2) - Math.exp(-3 * sigma2)));
  const onset2 = tuning.overlap * primaryDuration - Math.exp(mu2 - 3 * sigma2);
  const end = Math.max(primaryDuration, onset2 + Math.exp(mu2 + 3 * sigma2));
  const centered = Math.max(Number.EPSILON, yield* Random.next) - 0.5;

  const lateral =
    -tuning.lateral * Math.sign(centered) * Math.log(1 - 2 * Math.abs(centered)) * distance;

  const count = Math.min(
    Math.ceil(end / sampleMillis),
    Math.floor(lastRegularSample / sampleMillis),
  );

  const samples: Array<Sample> = [];
  let last: Point = from;

  const coordinate = (value: number) =>
    Math.round(Math.max(-Number.MAX_VALUE, Math.min(Number.MAX_VALUE, value * scale)));

  for (let index = 0; index < count; index++) {
    const afterMillis = index * sampleMillis;
    const first = cumulative(afterMillis, onset1, mu1, sigma1);
    const second = cumulative(afterMillis, onset2, mu2, sigma2);
    const bend = lateral * Math.sin(Math.PI * first);
    const x = coordinate(startX + primaryX * first + (deltaX - primaryX) * second - unitY * bend);
    const y = coordinate(startY + primaryY * first + (deltaY - primaryY) * second + unitX * bend);

    // A pointer that stays on its pixel reports nothing; the model's timing is unchanged.
    if (x === last.x && y === last.y) continue;
    last = { x, y };
    samples.push({ x, y, afterMillis });
  }

  // The exact destination always lands at the model's end, even if a dwell precedes it.
  samples.push({ ...to, afterMillis: count * sampleMillis });

  return samples;
});

export const Motion: Context.Reference<Service> = Context.Reference("effect-browser/Motion", {
  defaultValue: () => ({ plan }),
});
