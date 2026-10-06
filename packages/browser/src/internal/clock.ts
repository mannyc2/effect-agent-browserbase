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
  contextId: number,
): Effect.Effect<Estimate, ClockCalibrationFailure> =>
  Effect.gen(function* () {
    const probes: Array<Probe> = [];

    for (let index = 0; index < 3; index++) {
      const hostStart = Number(clock.monotonicTimeNanosUnsafe()) / 1e6;

      const response = yield* command(() =>
        cdp.send("Runtime.evaluate", {
          contextId,
          expression: "performance.timeOrigin + performance.now()",
          returnByValue: true,
        }),
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
