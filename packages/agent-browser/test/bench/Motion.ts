import { Schema } from "effect";

import { InputEvent, type Point } from "./InputLog.ts";

type Coordinate = typeof Point.Type;
const distance = (a: Coordinate, b: Coordinate) => Math.hypot(b.x - a.x, b.y - a.y);

export interface Movement {
  readonly startedAt: number;
  readonly clickedAt: number;
  readonly durationMillis: number;
  readonly distancePixels: number;
  readonly pathLengthPixels: number;
  readonly straightness: number | null;
  readonly peakVelocityPosition: number | null;
  readonly overshoot: boolean | null;
  readonly preClickDwellMillis: number;
  readonly fittsIndex: number | null;
  readonly samples: number;
}

/** These are native page input samples; intended timeline glides are never measured paths. */
export const motionStats = (input: ReadonlyArray<InputEvent>) => {
  const events = [
    ...Schema.decodeSync(Schema.Array(InputEvent).check(Schema.isMaxLength(65536)))(input),
  ]
    .filter((event) => event.trusted)
    .sort((a, b) => a.sourceTimeMillis - b.sourceTimeMillis);

  const movements: Movement[] = [];
  const interKeyMillis: number[] = [];
  const keyHoldMillis: number[] = [];
  const scrollCadenceMillis: number[] = [];
  const idleGapMillis: number[] = [];
  const held = new Map<string, number>();
  let lastKey: number | undefined;
  let lastScroll: number | undefined;
  let lastAction: number | undefined;
  let path: InputEvent[] = [];

  for (const event of events) {
    const at = event.sourceTimeMillis;

    if (
      event.kind === "pointermove" &&
      event.point !== null &&
      event.coordinateSpace === "main-viewport"
    ) {
      if (path.length > 0 && at - (path.at(-1)?.sourceTimeMillis ?? at) > 500) path = [];
      path.push(event);
    }
    if (
      event.kind === "pointerdown" &&
      event.point !== null &&
      event.coordinateSpace === "main-viewport"
    ) {
      const samples = path.filter((sample) => sample.point !== null);
      const first = samples[0];
      let length = 0;
      let peakVelocity = 0;
      let peakAt: number | null = null;

      for (let index = 1; index < samples.length; index++) {
        const before = samples[index - 1];
        const sample = samples[index];

        if (
          before?.point === null ||
          before === undefined ||
          sample?.point === null ||
          sample === undefined
        )
          continue;
        const segment = distance(before.point, sample.point);
        const interval = sample.sourceTimeMillis - before.sourceTimeMillis;

        length += segment;
        if (interval > 0 && segment / interval > peakVelocity) {
          peakVelocity = segment / interval;
          peakAt = (before.sourceTimeMillis + sample.sourceTimeMillis) / 2;
        }
      }
      if (first !== undefined && first.point !== null && path.length > 0) {
        const lastMove = path.at(-1);
        const endpoint = lastMove?.point;

        if (endpoint === undefined || endpoint === null) continue;
        const straight = distance(first.point, endpoint);
        const duration = (lastMove?.sourceTimeMillis ?? at) - first.sourceTimeMillis;
        const target = event.target?.kind === "dom" ? event.target : null;
        const direction = { x: event.point.x - first.point.x, y: event.point.y - first.point.y };
        const norm = Math.hypot(direction.x, direction.y);
        const point = event.point;

        const overshoot =
          target === null || norm === 0
            ? null
            : path.some(
                (sample) =>
                  sample.point !== null &&
                  ((sample.point.x - point.x) * direction.x +
                    (sample.point.y - point.y) * direction.y) /
                    norm >
                    2,
              );

        movements.push({
          startedAt: first.sourceTimeMillis,
          clickedAt: at,
          durationMillis: duration,
          distancePixels: straight,
          pathLengthPixels: length,
          straightness: length > 0 ? Math.min(1, straight / length) : null,
          peakVelocityPosition:
            peakAt !== null && duration > 0 ? (peakAt - first.sourceTimeMillis) / duration : null,
          overshoot,
          preClickDwellMillis: at - (lastMove?.sourceTimeMillis ?? at),
          fittsIndex:
            target === null
              ? null
              : Math.log2(1 + distance(first.point, target.center) / target.width),
          samples: samples.length,
        });
      }
      path = [];
    }
    const keyId = `${event.sourceOrigin}:${event.documentTimeOriginMillis}:${event.code ?? "unknown"}`;

    if (event.kind === "keydown" && !event.repeat && event.code !== null) {
      if (lastKey !== undefined) interKeyMillis.push(at - lastKey);
      lastKey = at;
      held.set(keyId, at);
    } else if (event.kind === "keyup" && event.code !== null) {
      const start = held.get(keyId);

      if (start !== undefined) keyHoldMillis.push(at - start);
      held.delete(keyId);
    }
    if (event.kind === "wheel") {
      if (lastScroll !== undefined) scrollCadenceMillis.push(at - lastScroll);
      lastScroll = at;
    }
    if (
      event.kind === "pointerdown" ||
      (event.kind === "keydown" && !event.repeat) ||
      event.kind === "wheel"
    ) {
      if (lastAction !== undefined) idleGapMillis.push(at - lastAction);
      lastAction = at;
    }
  }

  const knownOvershoots = movements.filter((movement) => movement.overshoot !== null);

  return {
    events: events.length,
    ignoredUntrusted: input.length - events.length,
    movements,
    interKeyMillis,
    keyHoldMillis,
    scrollCadenceMillis,
    idleGapMillis,
    overshootRate:
      knownOvershoots.length === 0
        ? null
        : knownOvershoots.filter((movement) => movement.overshoot).length / knownOvershoots.length,
    qualifications: {
      fitts: "DOM element width; canvas control geometry unavailable",
      path: "trusted main-viewport input samples; movement breaks after 500 ms",
      duration:
        "first to last delivered pointermove; excludes pre-click dwell and unobserved motion",
      velocity: "sampled peak, not continuous physical velocity",
      dwell: "time from last delivered pointermove to pointerdown",
      idle: "intervals between pointerdown, non-repeat keydown and wheel",
    },
  };
};

/** Two-sided empirical KS distance, with ties evaluated after both CDFs advance. */
export const ksDistance = (
  left: ReadonlyArray<number>,
  right: ReadonlyArray<number>,
): number | null => {
  if (left.length === 0 || right.length === 0) return null;
  const finite = Schema.Array(Schema.Finite).check(Schema.isMaxLength(65536));
  const a = [...Schema.decodeSync(finite)(left)].sort((x, y) => x - y);
  const b = [...Schema.decodeSync(finite)(right)].sort((x, y) => x - y);
  let i = 0;
  let j = 0;
  let maximum = 0;

  while (i < a.length || j < b.length) {
    const value = Math.min(a[i] ?? Infinity, b[j] ?? Infinity);

    while (i < a.length && (a[i] ?? Infinity) <= value) i++;
    while (j < b.length && (b[j] ?? Infinity) <= value) j++;
    maximum = Math.max(maximum, Math.abs(i / a.length - j / b.length));
  }

  return maximum;
};

export const compareMotion = (
  human: ReturnType<typeof motionStats>,
  candidate: ReturnType<typeof motionStats>,
) => {
  const fields = (stats: ReturnType<typeof motionStats>) => ({
    movementMillis: stats.movements.map((move) => move.durationMillis),
    straightness: stats.movements.flatMap((move) =>
      move.straightness === null ? [] : [move.straightness],
    ),
    peakVelocityPosition: stats.movements.flatMap((move) =>
      move.peakVelocityPosition === null ? [] : [move.peakVelocityPosition],
    ),
    preClickDwellMillis: stats.movements.map((move) => move.preClickDwellMillis),
    interKeyMillis: stats.interKeyMillis,
    keyHoldMillis: stats.keyHoldMillis,
    scrollCadenceMillis: stats.scrollCadenceMillis,
    idleGapMillis: stats.idleGapMillis,
  });

  const reference = fields(human);
  const sample = fields(candidate);

  return Object.fromEntries(
    Object.keys(reference).map((name) => {
      const key = name as keyof typeof reference;

      return [
        name,
        {
          ksDistance: ksDistance(reference[key], sample[key]),
          humanCount: reference[key].length,
          candidateCount: sample[key].length,
        },
      ];
    }),
  );
};
