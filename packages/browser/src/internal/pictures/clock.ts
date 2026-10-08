/**
 * The browser's clock read on the owner's: estimates of their offset from timed probes, how an
 * estimate ages, and the one mapping a browser's pages share. `pictures.ts` takes the probes.
 */
import { Duration, Effect, Option } from "effect";

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

// Two machines' clocks drift apart by up to about 100 parts per million, so an estimate says this
// much less about the offset for each millisecond of its age.
const driftPerMillis = 1e-4;

/** An estimate's uncertainty at `hostTime`, wider the further that is from when it was sampled. */
export const uncertaintyAt = (estimate: Estimate, hostTime: number): number =>
  estimate.uncertaintyMillis + Math.abs(hostTime - estimate.sampledAt) * driftPerMillis;

// Ten seconds widen an estimate by a millisecond, far less than a remote round trip, so it is
// measured again no more often than this.
const renewAfter = Duration.seconds(10);

/**
 * The browser's one epoch mapping, shared by its pages, input runs and capture generations. It is
 * measured on first need, by the first capture, never ahead of it.
 */
export interface Mapping {
  /** The latest estimate, without measuring: input uses it, and never waits for one. */
  readonly latest: () => Estimate | undefined;
  /** The latest estimate, measured through `measure` only while the browser has none. */
  readonly current: <E>(measure: Effect.Effect<Estimate, E>) => Effect.Effect<Estimate, E>;
  /**
   * Measure again once ten seconds have passed since the latest measurement began. A failed
   * measurement keeps the estimate, which keeps widening with its age.
   */
  readonly renew: <E>(measure: Effect.Effect<Estimate, E>) => Effect.Effect<void>;
}

/**
 * Whether a new measurement should replace the current estimate. Each interval contains the true
 * offset, so overlapping intervals agree and the narrower one is kept, the current one widened by
 * its age: a probe delayed behind a busy page cannot widen every tab's stamps. A disjoint
 * measurement means the clocks moved (a wall clock step, or drift between a remote browser and
 * this host), so the newer evidence wins.
 */
export const supersedes = (next: Estimate, current: Estimate): boolean => {
  const aged = uncertaintyAt(current, next.sampledAt);

  return (
    next.uncertaintyMillis <= aged ||
    Math.abs(next.offsetMillis - current.offsetMillis) > next.uncertaintyMillis + aged
  );
};

/**
 * Every renderer of a browser reads the same host wall clock, so the offset belongs to the
 * browser rather than a page. A busy page cannot fail work that an earlier estimate can serve.
 */
export const mapping = (now: () => number): Mapping => {
  let latest: Estimate | undefined;
  let measuredAt = Number.NEGATIVE_INFINITY;

  // Called where a measurement is decided, so no other can be decided before this one begins.
  const adopt = <E>(measure: Effect.Effect<Estimate, E>) => {
    measuredAt = now();

    return measure.pipe(
      Effect.map((estimate) => {
        if (latest === undefined || supersedes(estimate, latest)) latest = estimate;

        return latest;
      }),
    );
  };

  return {
    latest: () => latest,
    current: (measure) =>
      Effect.suspend(() => (latest === undefined ? adopt(measure) : Effect.succeed(latest))),
    renew: (measure) =>
      Effect.suspend(() =>
        latest === undefined || now() - measuredAt < Duration.toMillis(renewAfter)
          ? Effect.void
          : Effect.ignore(adopt(measure)),
      ),
  };
};

export const toHostTime = (calibration: Estimate, browserEpochMillis: number): number =>
  browserEpochMillis - calibration.offsetMillis;

/** CDP input timestamps use seconds, unlike browser frame timestamps and the owner's clock. */
export const toBrowserSeconds = (calibration: Estimate, hostMillis: number): number =>
  (hostMillis + calibration.offsetMillis) / 1000;
