import { Clock, Context, Effect, Layer, Ref, Schema } from "effect";
import type { CapturedFrame, CaptureSummary } from "effect-browserbase/capture";

/**
 * What this layer of a recording or a livestream is answerable for.
 *
 * The example sits between a browser and whoever watches. It owns how late
 * frames reach the host, how evenly, what was lost or never covered, what each
 * action cost, and how much of the output is a held picture. It does not own a
 * viewer's player, their network or a CDN, so nothing here claims
 * glass-to-glass latency; it supplies the timestamps an application needs to
 * measure that for itself.
 */

/** Nearest-rank quantiles of one measurement, in milliseconds. */
export const Distribution = Schema.Struct({
  count: Schema.Int,
  p50: Schema.Finite,
  p95: Schema.Finite,
  p99: Schema.Finite,
  max: Schema.Finite,
});

export type Distribution = typeof Distribution.Type;

/**
 * One four-timestamp exchange, as in NTP: the page stamps when it called and
 * when the reply arrived, the host stamps when it received and when it replied.
 * The two pairs never need to share a clock.
 */
export const ClockSample = Schema.Struct({
  pageSentMillis: Schema.Finite,
  hostReceivedMillis: Schema.Finite,
  hostRepliedMillis: Schema.Finite,
  pageReceivedMillis: Schema.Finite,
});

export type ClockSample = typeof ClockSample.Type;

export const Metrics = Schema.Struct({
  capture: Schema.Struct({
    frames: Schema.Int,
    framesPerSecond: Schema.NullOr(Schema.Finite),
    /** Gaps between frames inside a take: the pacing a viewer sees. A still page is a long gap. */
    interFrameMillis: Schema.NullOr(Distribution),
    /**
     * Presentation in the browser to receipt on the host. `null` until the
     * clocks have been compared: a frame's source time is the browser's clock.
     */
    latencyMillis: Schema.NullOr(Distribution),
    clock: Schema.NullOr(
      Schema.Struct({
        /** Host clock minus browser clock. */
        offsetMillis: Schema.Finite,
        /** Half the best round trip: every latency above is good to within this. */
        uncertaintyMillis: Schema.Finite,
        samples: Schema.Int,
      }),
    ),
  }),
  takes: Schema.Array(
    Schema.Struct({
      received: Schema.Int,
      delivered: Schema.Int,
      /** Frames this host discarded. What the browser or the network dropped upstream is unknown. */
      dropped: Schema.Int,
      duplicates: Schema.Int,
      peakBufferedFrames: Schema.Int,
      timeToFirstFrameMillis: Schema.NullOr(Schema.Finite),
      nativeStop: Schema.Literals(["confirmed", "unconfirmed"]),
    }),
  ),
  /** Source time no interval filmed, one entry per cut. On film it is a held picture. */
  uncoveredMillis: Schema.Array(Schema.Finite),
  control: Schema.Struct({
    /** Dispatch to return of the session's own actions, by kind. */
    actionMillis: Schema.Record(Schema.String, Distribution),
    /** A `Locate` cue out and its report back: the page-to-host channel's round trip. */
    cueRoundTripMillis: Schema.NullOr(Distribution),
    /** A click's dispatch to the next frame received: an upper bound on action-to-pixel. */
    clickToFrameMillis: Schema.NullOr(Distribution),
  }),
  output: Schema.Struct({
    frames: Schema.Int,
    /** Output frames that repeat the previous picture. High on still pages, by design. */
    heldFrames: Schema.Int,
  }),
});

export type Metrics = typeof Metrics.Type;

export const distribution = (values: ReadonlyArray<number>): Distribution | null => {
  if (values.length === 0) return null;

  const sorted = [...values].sort((left, right) => left - right);

  const rank = (quantile: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1)] ?? 0;

  return {
    count: sorted.length,
    p50: rank(0.5),
    p95: rank(0.95),
    p99: rank(0.99),
    max: sorted[sorted.length - 1] ?? 0,
  };
};

/** The sample with the shortest round trip bounds the offset most tightly. */
export const clockOffset = (samples: ReadonlyArray<ClockSample>) => {
  const measured = samples
    .map((sample) => ({
      offsetMillis:
        (sample.hostReceivedMillis -
          sample.pageSentMillis +
          (sample.hostRepliedMillis - sample.pageReceivedMillis)) /
        2,
      roundTripMillis:
        sample.pageReceivedMillis -
        sample.pageSentMillis -
        (sample.hostRepliedMillis - sample.hostReceivedMillis),
    }))
    .filter((sample) => sample.roundTripMillis >= 0)
    .sort((left, right) => left.roundTripMillis - right.roundTripMillis)[0];

  return measured === undefined
    ? null
    : {
        offsetMillis: measured.offsetMillis,
        uncertaintyMillis: measured.roundTripMillis / 2,
        samples: samples.length,
      };
};

interface FrameRecord {
  readonly take: number;
  readonly sourceMillis: number;
  readonly receivedMillis: number;
}

interface Records {
  readonly frames: ReadonlyArray<FrameRecord>;
  readonly takeStartedMillis: ReadonlyArray<number>;
  readonly takes: ReadonlyArray<CaptureSummary>;
  readonly clock: ReadonlyArray<ClockSample>;
  readonly actions: Readonly<Record<string, ReadonlyArray<number>>>;
  readonly cues: ReadonlyArray<number>;
  readonly clicksAtMillis: ReadonlyArray<number>;
  readonly outputFrames: number;
  readonly heldFrames: number;
}

const empty: Records = {
  frames: [],
  takeStartedMillis: [],
  takes: [],
  clock: [],
  actions: {},
  cues: [],
  clicksAtMillis: [],
  outputFrames: 0,
  heldFrames: 0,
};

/** Ten minutes at sixty frames a second; past it the oldest samples are let go. */
const MaximumSamples = 36_000;

const appended = <A>(values: ReadonlyArray<A>, value: A) =>
  values.length < MaximumSamples ? [...values, value] : [...values.slice(1), value];

const differences = (values: ReadonlyArray<number>) =>
  values.slice(1).map((value, index) => value - (values[index] ?? value));

export const summarize = (records: Records): Metrics => {
  const clock = clockOffset(records.clock);

  const byTake = records.takeStartedMillis.map((_, take) =>
    records.frames.filter((frame) => frame.take === take),
  );

  const first = records.frames[0];
  const last = records.frames[records.frames.length - 1];
  const spanMillis = first && last ? last.receivedMillis - first.receivedMillis : 0;

  return {
    capture: {
      frames: records.frames.length,
      framesPerSecond: spanMillis > 0 ? ((records.frames.length - 1) * 1000) / spanMillis : null,
      interFrameMillis: distribution(
        byTake.flatMap((frames) => differences(frames.map((frame) => frame.sourceMillis))),
      ),
      latencyMillis:
        clock === null
          ? null
          : distribution(
              records.frames.map(
                (frame) => frame.receivedMillis - (frame.sourceMillis + clock.offsetMillis),
              ),
            ),
      clock,
    },
    takes: records.takes.map((take, index) => {
      const started = records.takeStartedMillis[index];
      const firstFrame = byTake[index]?.[0];

      return {
        received: take.received,
        delivered: take.delivered,
        dropped: take.dropped,
        duplicates: take.duplicates,
        peakBufferedFrames: take.peakBufferedFrames,
        timeToFirstFrameMillis:
          started === undefined || firstFrame === undefined
            ? null
            : firstFrame.receivedMillis - started,
        nativeStop: take.nativeStop,
      };
    }),
    uncoveredMillis: byTake.slice(1).flatMap((frames, index) => {
      const before = byTake[index]?.at(-1);
      const after = frames[0];

      return before === undefined || after === undefined
        ? []
        : [after.sourceMillis - before.sourceMillis];
    }),
    control: {
      actionMillis: Object.fromEntries(
        Object.entries(records.actions).flatMap(([kind, values]) => {
          const measured = distribution(values);

          return measured === null ? [] : [[kind, measured]];
        }),
      ),
      cueRoundTripMillis: distribution(records.cues),
      clickToFrameMillis: distribution(
        records.clicksAtMillis.flatMap((clickedAt) => {
          const next = records.frames.find((frame) => frame.receivedMillis > clickedAt);

          return next === undefined ? [] : [next.receivedMillis - clickedAt];
        }),
      ),
    },
    output: { frames: records.outputFrames, heldFrames: records.heldFrames },
  };
};

export class Telemetry extends Context.Service<
  Telemetry,
  {
    /**
     * Host time in Unix milliseconds, advanced by the monotonic clock. Frame
     * receipts are monotonic too, so every host timestamp here is comparable
     * and none of them jumps when the wall clock is corrected.
     */
    readonly now: Effect.Effect<number>;
    readonly takeStarted: (atMillis: number) => Effect.Effect<void>;
    readonly takeEnded: (summary: CaptureSummary) => Effect.Effect<void>;
    readonly frame: (frame: CapturedFrame) => Effect.Effect<void>;
    readonly output: (held: boolean) => Effect.Effect<void>;
    readonly clock: (sample: ClockSample) => Effect.Effect<void>;
    /** Time one of the session's actions; a click is also remembered for click-to-frame. */
    readonly action: <A, E, R>(
      kind: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    readonly cueRoundTrip: (millis: number) => Effect.Effect<void>;
    readonly metrics: Effect.Effect<Metrics>;
  }
>()("effect-browserbase/examples/realistic-footage/Telemetry") {
  static readonly layer = Layer.effect(
    Telemetry,
    Effect.gen(function* () {
      const records = yield* Ref.make(empty);
      const clock = yield* Clock.Clock;
      const epochMillis = clock.currentTimeMillisUnsafe();
      const epochNanos = clock.monotonicTimeNanosUnsafe();
      const hostMillis = (nanos: bigint) => epochMillis + Number(nanos - epochNanos) / 1_000_000;
      const now = Effect.map(clock.monotonicTimeNanos, hostMillis);

      return Telemetry.of({
        now,
        takeStarted: (atMillis) =>
          Ref.update(records, (all) => ({
            ...all,
            takeStartedMillis: [...all.takeStartedMillis, atMillis],
          })),
        takeEnded: (summary) =>
          Ref.update(records, (all) => ({ ...all, takes: [...all.takes, summary] })),
        frame: (frame) =>
          Ref.update(records, (all) => ({
            ...all,
            frames: appended(all.frames, {
              take: all.takeStartedMillis.length - 1,
              sourceMillis: frame.sourceTimeMillis,
              receivedMillis: hostMillis(frame.receivedMonotonicNanos),
            }),
          })),
        output: (held) =>
          Ref.update(records, (all) => ({
            ...all,
            outputFrames: all.outputFrames + 1,
            heldFrames: all.heldFrames + (held ? 1 : 0),
          })),
        clock: (sample) =>
          Ref.update(records, (all) => ({ ...all, clock: appended(all.clock, sample) })),
        action: (kind, effect) =>
          Effect.gen(function* () {
            const startedAt = yield* now;
            const result = yield* effect;
            const millis = (yield* now) - startedAt;

            yield* Ref.update(records, (all) => ({
              ...all,
              actions: { ...all.actions, [kind]: appended(all.actions[kind] ?? [], millis) },
              clicksAtMillis:
                kind === "click" ? appended(all.clicksAtMillis, startedAt) : all.clicksAtMillis,
            }));

            return result;
          }),
        cueRoundTrip: (millis) =>
          Ref.update(records, (all) => ({ ...all, cues: appended(all.cues, millis) })),
        metrics: Effect.map(Ref.get(records), summarize),
      });
    }),
  );
}
