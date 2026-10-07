import { Clock, Data, Duration, Effect, Option } from "effect";
import type { CDPSession } from "playwright-core";

export interface Probe {
  readonly hostStart: number;
  readonly hostEnd: number;
  readonly browserTime: number;
}

export interface Estimate {
  /** Browser epoch milliseconds minus the owner's host monotonic milliseconds. */
  readonly offsetMillis: number;
  /** Either transport direction can own the entire round trip; symmetry is not assumed. */
  readonly uncertaintyMillis: number;
  readonly roundTripMillis: number;
  readonly sampledAt: number;
}

export class ClockCalibrationFailure extends Data.TaggedError("ClockCalibrationFailure")<{
  readonly cause: unknown;
}> {}

/** The fastest complete probe limits uncertainty without mistaking transit delay for clock offset. */
export const estimate = (probes: ReadonlyArray<Probe>): Option.Option<Estimate> => {
  let best: Estimate | undefined;

  for (const probe of probes) {
    const roundTripMillis = probe.hostEnd - probe.hostStart;

    if (
      !Number.isFinite(probe.hostStart) ||
      !Number.isFinite(probe.hostEnd) ||
      !Number.isFinite(probe.browserTime) ||
      !Number.isFinite(roundTripMillis) ||
      roundTripMillis < 0
    )
      continue;
    const sampledAt = probe.hostStart + roundTripMillis / 2;
    const offsetMillis = probe.browserTime - sampledAt;

    if (
      !Number.isFinite(offsetMillis) ||
      !Number.isFinite(probe.browserTime - probe.hostStart) ||
      !Number.isFinite(probe.browserTime - probe.hostEnd)
    )
      continue;
    if (best === undefined || roundTripMillis < best.roundTripMillis)
      best = {
        offsetMillis,
        uncertaintyMillis: roundTripMillis / 2,
        roundTripMillis,
        sampledAt,
      };
  }

  return Option.fromUndefinedOr(best);
};

/** The browser's one epoch mapping, shared by its pages, input runs and capture generations. */
export interface Mapping {
  /** The latest estimate, measured through `measure` only while the browser has none. */
  readonly current: <E>(measure: Effect.Effect<Estimate, E>) => Effect.Effect<Estimate, E>;
  /**
   * Measure again and return the browser's estimate afterwards; a failed measurement keeps the
   * previous estimate when there is one.
   */
  readonly refresh: <E>(measure: Effect.Effect<Estimate, E>) => Effect.Effect<Estimate, E>;
}

/**
 * Whether a new measurement should replace the current estimate. Each interval contains the true
 * offset, so overlapping intervals agree and the narrower one is kept: a probe delayed behind a
 * busy page cannot widen every tab's stamps. A disjoint measurement means the clocks moved (a wall
 * clock step, or drift between a remote browser and this host), so the newer evidence wins.
 */
export const supersedes = (next: Estimate, current: Estimate): boolean =>
  next.uncertaintyMillis <= current.uncertaintyMillis ||
  Math.abs(next.offsetMillis - current.offsetMillis) >
    next.uncertaintyMillis + current.uncertaintyMillis;

/**
 * Every renderer of a browser reads the same host wall clock, so the offset belongs to the
 * browser rather than a page. A busy page cannot fail work that an earlier estimate can serve.
 */
export const mapping = (seed: Option.Option<Estimate>): Mapping => {
  let latest = Option.getOrUndefined(seed);

  const adopt = <E>(measure: Effect.Effect<Estimate, E>) =>
    measure.pipe(
      Effect.map((estimate) => {
        if (latest === undefined || supersedes(estimate, latest)) latest = estimate;

        return latest;
      }),
    );

  return {
    current: (measure) =>
      Effect.suspend(() => (latest === undefined ? adopt(measure) : Effect.succeed(latest))),
    refresh: (measure) =>
      adopt(measure).pipe(
        Effect.catch((error) =>
          latest === undefined ? Effect.fail(error) : Effect.succeed(latest),
        ),
      ),
  };
};

export const toHostTime = (calibration: Estimate, browserEpochMillis: number): number =>
  browserEpochMillis - calibration.offsetMillis;

/** CDP input timestamps use seconds, unlike browser frame timestamps and the owner's clock. */
export const toBrowserSeconds = (calibration: Estimate, hostMillis: number): number =>
  (hostMillis + calibration.offsetMillis) / 1000;

const command = <A>(run: () => Promise<A>): Effect.Effect<A, ClockCalibrationFailure> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new ClockCalibrationFailure({ cause }),
  });

/**
 * Reads only in a private JavaScript world: no DOM markers, input, navigation or extra tabs.
 * The owning clock supplies both stamps and the deadline even if a caller overrides Clock later.
 */
export const calibrate = (
  cdp: CDPSession,
  clock: Clock.Clock,
  // The page's main world when absent.
  contextId?: number,
): Effect.Effect<Estimate, ClockCalibrationFailure> =>
  Effect.gen(function* () {
    const probes: Array<Probe> = [];

    for (let index = 0; index < 3; index++) {
      const hostStart = Number(clock.monotonicTimeNanosUnsafe()) / 1e6;

      // A round trip to the page's script like any other, so traced as one.
      const response = yield* command(() =>
        cdp.send("Runtime.evaluate", {
          ...(contextId === undefined ? {} : { contextId }),
          expression: "performance.timeOrigin + performance.now()",
          returnByValue: true,
        }),
      ).pipe(
        Effect.withSpan(
          "Page.evaluate",
          { attributes: { function: "clock" }, level: "Trace" },
          { captureStackTrace: false },
        ),
      );

      const hostEnd = Number(clock.monotonicTimeNanosUnsafe()) / 1e6;
      const browserTime: unknown = response.result.value;

      if (response.exceptionDetails !== undefined || typeof browserTime !== "number")
        return yield* new ClockCalibrationFailure({
          cause: new Error("the browser clock probe did not return a timestamp"),
        });
      probes.push({ hostStart, hostEnd, browserTime });
    }

    const result = estimate(probes);

    if (Option.isNone(result))
      return yield* new ClockCalibrationFailure({
        cause: new Error("the browser clock probes did not define a finite interval"),
      });

    return result.value;
  }).pipe(
    Effect.timeoutOrElse({
      duration: Duration.seconds(2),
      orElse: () =>
        Effect.fail(
          new ClockCalibrationFailure({
            cause: new Error("browser clock calibration exceeded its deadline"),
          }),
        ),
    }),
    Effect.provideService(Clock.Clock, clock),
  );
