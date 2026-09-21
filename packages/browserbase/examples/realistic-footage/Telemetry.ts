import { Clock, Context, Effect, Layer, Ref, Schema } from "effect";
import type { InputReceipt } from "effect-browserbase/browser-data";
import type { CapturedFrame, CaptureSummary } from "effect-browserbase/capture";

/**
 * What this layer of a recording or a livestream is answerable for.
 *
 * The example sits between a browser and whoever watches. It owns how late
 * frames reach the host, how evenly, what this host lost, how long the picture
 * held across each navigation, what each action cost, and how much of the
 * output is a held picture. It does not own a
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
    /** Gaps between frames of one document: the pacing a viewer sees. A still page is a long gap. */
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
    /** From the first attempt to start filming to the first frame received. */
    timeToFirstFrameMillis: Schema.NullOr(Schema.Finite),
    /** The one interval's own account of itself. `null` until it has ended. */
    interval: Schema.NullOr(
      Schema.Struct({
        reason: Schema.String,
        received: Schema.Int,
        delivered: Schema.Int,
        /** Frames this host discarded. What the browser or the network dropped upstream is unknown. */
        dropped: Schema.Int,
        duplicates: Schema.Int,
        peakBufferedFrames: Schema.Int,
        nativeStop: Schema.Literals(["confirmed", "unconfirmed"]),
      }),
    ),
  }),
  /**
   * Every document the film showed, in order. The address and the commit time
   * are the library's evidence and arrive when the interval ends; until then a
   * document seen in frames is listed without them. `heldMillis` is this code's
   * measurement: the source time between the last frame of the document before
   * and the first of this one, which on film is a held picture. It is not a gap
   * anything introduced. One screencast ran the whole way, and what Chromium
   * left out while loading is unknown. Frames are attributed by receipt order,
   * so it is good to a frame either way.
   */
  documents: Schema.Array(
    Schema.Struct({
      document: Schema.Int,
      url: Schema.NullOr(Schema.String),
      /** When the navigation to it committed, on the host clock. `null` for the opening document. */
      committedAtMillis: Schema.NullOr(Schema.Finite),
      heldMillis: Schema.NullOr(Schema.Finite),
    }),
  ),
  control: Schema.Struct({
    /** Around the call, for actions that report no interval of their own: admission to return. */
    actionMillis: Schema.Record(Schema.String, Distribution),
    /** From the receipt of native input: the native command alone, with admission excluded. */
    inputMillis: Schema.Record(Schema.String, Distribution),
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
  readonly document: number;
  readonly sourceMillis: number;
  readonly receivedMillis: number;
}

/** What the library reported about one navigation, with its commit on this layer's host clock. */
interface Commit {
  readonly document: number;
  readonly url: string | null;
  readonly committedAtMillis: number;
}

interface Records {
  readonly frames: ReadonlyArray<FrameRecord>;
  readonly startedMillis: number | null;
  readonly interval: CaptureSummary | null;
  readonly commits: ReadonlyArray<Commit>;
  readonly clock: ReadonlyArray<ClockSample>;
  readonly actions: Readonly<Record<string, ReadonlyArray<number>>>;
  readonly inputs: Readonly<Record<string, ReadonlyArray<number>>>;
  readonly cues: ReadonlyArray<number>;
  readonly clicksAtMillis: ReadonlyArray<number>;
  readonly outputFrames: number;
  readonly heldFrames: number;
}

const empty: Records = {
  frames: [],
  startedMillis: null,
  interval: null,
  commits: [],
  clock: [],
  actions: {},
  inputs: {},
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

const distributions = (byKind: Readonly<Record<string, ReadonlyArray<number>>>) =>
  Object.fromEntries(
    Object.entries(byKind).flatMap(([kind, values]) => {
      const spread = distribution(values);

      return spread === null ? [] : [[kind, spread]];
    }),
  );

export const summarize = (records: Records): Metrics => {
  const clock = clockOffset(records.clock);

  // Frames say which documents were filmed as they arrive; the library's summary adds the
  // address and the commit of each once the interval has ended.
  const indices = [
    ...new Set([
      0,
      ...records.frames.map((frame) => frame.document),
      ...records.commits.map((commit) => commit.document),
    ]),
  ].sort((left, right) => left - right);

  const byDocument = new Map(
    indices.map((document) => [
      document,
      records.frames.filter((frame) => frame.document === document),
    ]),
  );

  const first = records.frames[0];
  const last = records.frames[records.frames.length - 1];
  const spanMillis = first && last ? last.receivedMillis - first.receivedMillis : 0;

  return {
    capture: {
      frames: records.frames.length,
      framesPerSecond: spanMillis > 0 ? ((records.frames.length - 1) * 1000) / spanMillis : null,
      interFrameMillis: distribution(
        [...byDocument.values()].flatMap((frames) =>
          differences(frames.map((frame) => frame.sourceMillis)),
        ),
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
      timeToFirstFrameMillis:
        records.startedMillis === null || first === undefined
          ? null
          : first.receivedMillis - records.startedMillis,
      interval:
        records.interval === null
          ? null
          : {
              reason: records.interval.reason,
              received: records.interval.received,
              delivered: records.interval.delivered,
              dropped: records.interval.dropped,
              duplicates: records.interval.duplicates,
              peakBufferedFrames: records.interval.peakBufferedFrames,
              nativeStop: records.interval.nativeStop,
            },
    },
    documents: indices.map((document) => {
      const commit = records.commits.find((candidate) => candidate.document === document);
      const before = byDocument.get(document - 1)?.at(-1);
      const after = byDocument.get(document)?.[0];

      return {
        document,
        url: document === 0 ? (records.interval?.initialUrl ?? null) : (commit?.url ?? null),
        committedAtMillis: commit?.committedAtMillis ?? null,
        heldMillis:
          before === undefined || after === undefined
            ? null
            : after.sourceMillis - before.sourceMillis,
      };
    }),
    control: {
      actionMillis: distributions(records.actions),
      inputMillis: distributions(records.inputs),
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
    /** Dated from the first attempt to start, so any wait shows in the time to first frame. */
    readonly captureStarted: (atMillis: number) => Effect.Effect<void>;
    readonly captureEnded: (summary: CaptureSummary) => Effect.Effect<void>;
    readonly frame: (frame: CapturedFrame) => Effect.Effect<void>;
    readonly output: (held: boolean) => Effect.Effect<void>;
    readonly clock: (sample: ClockSample) => Effect.Effect<void>;
    /** Time one of the session's actions; a click is also remembered for click-to-frame. */
    readonly action: <A, E, R>(
      kind: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    /**
     * Native input says when its own command started and completed, on the clock
     * that stamps frames. That is the better number: timing around the call would
     * add the wait for the owner's permit and the readiness check to it.
     */
    readonly input: <E, R>(
      kind: string,
      effect: Effect.Effect<InputReceipt, E, R>,
    ) => Effect.Effect<InputReceipt, E, R>;
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
        captureStarted: (atMillis) =>
          Ref.update(records, (all) => ({ ...all, startedMillis: atMillis })),
        captureEnded: (summary) =>
          Ref.update(records, (all) => ({
            ...all,
            interval: summary,
            commits: summary.documentBoundaries.map((boundary) => ({
              document: boundary.document,
              url: boundary.url,
              committedAtMillis: hostMillis(boundary.observedMonotonicNanos),
            })),
          })),
        frame: (frame) =>
          Ref.update(records, (all) => ({
            ...all,
            frames: appended(all.frames, {
              document: frame.document,
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
        input: (kind, effect) =>
          Effect.tap(effect, (receipt) =>
            Ref.update(records, (all) => ({
              ...all,
              inputs: {
                ...all.inputs,
                [kind]: appended(
                  all.inputs[kind] ?? [],
                  Number(receipt.completedMonotonicNanos - receipt.startedMonotonicNanos) /
                    1_000_000,
                ),
              },
            })),
          ),
        cueRoundTrip: (millis) =>
          Ref.update(records, (all) => ({ ...all, cues: appended(all.cues, millis) })),
        metrics: Effect.map(Ref.get(records), summarize),
      });
    }),
  );
}
