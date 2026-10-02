import { Effect, Random, Result } from "effect";

import { BrowserError, Reasons } from "../../Errors.ts";
import type { MotionProfile, Performed } from "../../PlanData.ts";

/**
 * These caps are independent of logical action admission and pending native replies. Every
 * schedule is bounded by construction: a path or scroll has at most `samples` points, and a code
 * point expands to at most three strokes (a slip, its Backspace and the key), so typed text has at
 * most 768.
 */
export const Limits = {
  samples: 128,
  codePoints: 256,
} as const;

interface KeyRandom {
  readonly interval: number;
  readonly hold: number;
  readonly slip: number;
  readonly wrong: number;
}

/** Finite, geometry-independent policy data; this value owns no clock, permit or native work. */
export interface PerformancePlan {
  readonly seed: number;
  readonly profile: MotionProfile;
  readonly pointer: { readonly aimX: number; readonly aimY: number; readonly curvature: number };
  readonly keys: ReadonlyArray<KeyRandom>;
  readonly scroll: number;
  readonly slipsProbability: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface PointerGeometry {
  readonly from: Point | null;
  readonly box: Point & { readonly width: number; readonly height: number };
  readonly viewport: { readonly width: number; readonly height: number };
}

export interface MoveGeometry {
  readonly from: Point | null;
  readonly to: Point;
  readonly viewport: { readonly width: number; readonly height: number };
}

export interface PointerSchedule {
  /** Intended viewport point, never evidence of the native engine's actual pointer position. */
  readonly aim: Point;
  readonly durationMillis: number;
  readonly samples: ReadonlyArray<{ readonly offsetMillis: number; readonly position: Point }>;
}

export interface Stroke {
  readonly key: string;
  readonly index: number;
  /** Quiet interval from the preceding keyup to this keydown; the first stroke has no delay. */
  readonly intervalMillis: number;
  readonly holdMillis: number;
  readonly offsetMillis: number;
  readonly completedOffsetMillis: number;
  readonly kind: "type" | "slip" | "backspace";
}

export interface KeySchedule {
  readonly fieldIndex: number;
  readonly codePoints: number;
  readonly durationMillis: number;
  readonly strokes: ReadonlyArray<Stroke>;
}

export interface ScrollSchedule {
  readonly durationMillis: number;
  readonly samples: ReadonlyArray<{
    readonly offsetMillis: number;
    readonly deltaX: number;
    readonly deltaY: number;
  }>;
}

const failure = (reason: BrowserError["reason"]) =>
  BrowserError.make({ operation: "run", reason, outcome: "undispatched" });

const lerp = (minimum: number, maximum: number, unit: number) =>
  minimum + (maximum - minimum) * unit;

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));

/** Fifth-order progress for zero endpoint velocity/acceleration; curved paths remain policy. */
export const progress = (unit: number): number => {
  const u = clamp(unit, 0, 1);

  return u * u * u * (10 + u * (-15 + 6 * u));
};

/** Allocate a fresh pinned generator on execution, never a shared run/callback Random service. */
export const prepare = (style: Performed, seed: number, stepId: string) =>
  Effect.suspend(() =>
    Effect.gen(function* () {
      const aimX = yield* Random.next;
      const aimY = yield* Random.next;
      const curvature = yield* Random.next;
      const scroll = yield* Random.next;

      const keys = yield* Effect.forEach(Array.from({ length: Limits.codePoints }), () =>
        Effect.gen(function* () {
          return Object.freeze({
            interval: yield* Random.next,
            hold: yield* Random.next,
            slip: yield* Random.next,
            wrong: yield* Random.next,
          });
        }),
      );

      return Object.freeze({
        seed,
        profile: style.motion,
        pointer: Object.freeze({ aimX, aimY, curvature }),
        keys: Object.freeze(keys),
        scroll,
        slipsProbability: style.slips.probability,
      });
    }).pipe(Random.withSeed(`effect-browser/performed/1:${seed}:${stepId.length}:${stepId}`)),
  );

const path = (
  plan: PerformancePlan,
  from: Point | null,
  aim: Point,
  viewport: MoveGeometry["viewport"],
  durationMillis: number,
): Result.Result<PointerSchedule, BrowserError> => {
  if (from === null)
    return Result.succeed(Object.freeze({ aim, durationMillis: 0, samples: Object.freeze([]) }));

  const deltaX = aim.x - from.x;
  const deltaY = aim.y - from.y;
  const distance = Math.hypot(deltaX, deltaY);

  if (!Number.isFinite(distance)) return Result.fail(failure(Reasons.Malformed.make({})));
  if (distance === 0)
    return Result.succeed(Object.freeze({ aim, durationMillis: 0, samples: Object.freeze([]) }));
  const count = Math.min(Limits.samples, Math.max(2, Math.ceil(durationMillis / (1000 / 60)) + 1));
  const curvature = (plan.pointer.curvature * 2 - 1) * plan.profile.pointer.curvature * distance;
  const normalX = -deltaY / distance;
  const normalY = deltaX / distance;

  const samples = Array.from({ length: count }, (_value, index) => {
    const unit = index / (count - 1);
    const eased = progress(unit);
    const bend = 4 * eased * (1 - eased) * curvature;

    return Object.freeze({
      offsetMillis: unit * durationMillis,
      position: Object.freeze({
        x: clamp(from.x + deltaX * eased + normalX * bend, 0, viewport.width),
        y: clamp(from.y + deltaY * eased + normalY * bend, 0, viewport.height),
      }),
    });
  });

  return Result.succeed(Object.freeze({ aim, durationMillis, samples: Object.freeze(samples) }));
};

/** The existing native hit checker must validate the returned aim on the exact leased node. */
export const pointer = (
  plan: PerformancePlan,
  geometry: PointerGeometry,
): Result.Result<PointerSchedule, BrowserError> => {
  const { from, box, viewport } = geometry;

  const values = [
    box.x,
    box.y,
    box.width,
    box.height,
    viewport.width,
    viewport.height,
    ...(from === null ? [] : [from.x, from.y]),
  ];

  if (values.some((value) => !Number.isFinite(value)))
    return Result.fail(failure(Reasons.Malformed.make({})));
  const left = Math.max(0, box.x);
  const top = Math.max(0, box.y);
  const right = Math.min(viewport.width, box.x + box.width);
  const bottom = Math.min(viewport.height, box.y + box.height);
  const width = right - left;
  const height = bottom - top;

  if (width <= 0 || height <= 0 || box.width <= 0 || box.height <= 0)
    return Result.fail(failure(Reasons.NotVisible.make({})));
  const inset = plan.profile.pointer.aimInset;

  const aim = Object.freeze({
    x: lerp(left + width * inset, right - width * inset, plan.pointer.aimX),
    y: lerp(top + height * inset, bottom - height * inset, plan.pointer.aimY),
  });

  const distance = from === null ? 0 : Math.hypot(aim.x - from.x, aim.y - from.y);
  const range = plan.profile.pointer.duration;

  // Shannon duration form with chosen policy coefficients, not measured human calibration.
  const durationMillis = clamp(
    100 + 150 * Math.log2(distance / Math.min(width, height) + 1),
    range.minMillis,
    range.maxMillis,
  );

  return path(plan, from, aim, viewport, durationMillis);
};

/** Authored coordinates stay exact; the bounded timing policy needs no synthetic target box. */
export const move = (
  plan: PerformancePlan,
  geometry: MoveGeometry,
): Result.Result<PointerSchedule, BrowserError> => {
  const { from, to, viewport } = geometry;

  if (
    [to.x, to.y, viewport.width, viewport.height, ...(from === null ? [] : [from.x, from.y])].some(
      (value) => !Number.isFinite(value),
    )
  )
    return Result.fail(failure(Reasons.Malformed.make({})));
  if (
    viewport.width <= 0 ||
    viewport.height <= 0 ||
    to.x < 0 ||
    to.y < 0 ||
    to.x > viewport.width ||
    to.y > viewport.height
  )
    return Result.fail(failure(Reasons.NotVisible.make({})));
  const aim = Object.freeze({ x: to.x, y: to.y });
  const distance = from === null ? 0 : Math.hypot(to.x - from.x, to.y - from.y);
  const range = plan.profile.pointer.duration;

  // Chosen linear-distance pacing, with no claim of measured human calibration.
  const durationMillis = clamp(100 + distance * 0.35, range.minMillis, range.maxMillis);

  return path(plan, from, aim, viewport, durationMillis);
};

const slipKeys = "abcdefghijklmnopqrstuvwxyz";

/** Input text is transient host data; receipts/timeline retain counts and intervals only. */
export const keys = (
  plan: PerformancePlan,
  text: string,
  fieldIndex = 0,
): Result.Result<KeySchedule, BrowserError> => {
  if (!Number.isSafeInteger(fieldIndex) || fieldIndex < 0 || fieldIndex > 31)
    return Result.fail(failure(Reasons.Malformed.make({})));
  // Input values are already bounded to 65,536 UTF-8 bytes, so the count is measured in full.
  const characters = [...text];

  if (characters.length > Limits.codePoints)
    return Result.fail(
      failure(
        Reasons.Limit.make({
          dimension: "code-points",
          maximum: Limits.codePoints,
          observed: characters.length,
        }),
      ),
    );
  const strokes: Array<Stroke> = [];
  let durationMillis = 0;

  const append = (key: string, index: number, random: KeyRandom, kind: Stroke["kind"]) => {
    const intervalMillis =
      strokes.length === 0
        ? 0
        : lerp(
            plan.profile.keys.interval.minMillis,
            plan.profile.keys.interval.maxMillis,
            random.interval,
          );

    const holdMillis = lerp(
      plan.profile.keys.hold.minMillis,
      plan.profile.keys.hold.maxMillis,
      random.hold,
    );

    const offsetMillis = durationMillis + intervalMillis;

    durationMillis = offsetMillis + holdMillis;
    strokes.push(
      Object.freeze({
        key,
        index,
        intervalMillis,
        holdMillis,
        offsetMillis,
        completedOffsetMillis: durationMillis,
        kind,
      }),
    );
  };

  for (const [index, key] of characters.entries()) {
    const random = plan.keys[(index + fieldIndex * 17) % Limits.codePoints];

    if (random === undefined) return Result.fail(failure(Reasons.Malformed.make({})));
    if (plan.slipsProbability > 0 && random.slip < plan.slipsProbability && /^[a-z]$/u.test(key)) {
      const wrongIndex = Math.floor(random.wrong * (slipKeys.length - 1));
      const originalIndex = slipKeys.indexOf(key);
      const wrong = slipKeys[wrongIndex >= originalIndex ? wrongIndex + 1 : wrongIndex];

      if (wrong === undefined) return Result.fail(failure(Reasons.Malformed.make({})));
      append(wrong, index, random, "slip");
      append("Backspace", index, random, "backspace");
    }
    append(key, index, random, "type");
  }

  return Result.succeed(
    Object.freeze({
      fieldIndex,
      codePoints: characters.length,
      durationMillis,
      strokes: Object.freeze(strokes),
    }),
  );
};

/** Explicit deltas apply to the existing checked scroll capability, not a synthetic wheel target. */
export const scroll = (
  plan: PerformancePlan,
  deltaX: number,
  deltaY: number,
): Result.Result<ScrollSchedule, BrowserError> => {
  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY))
    return Result.fail(failure(Reasons.Malformed.make({})));
  if (deltaX === 0 && deltaY === 0)
    return Result.succeed(Object.freeze({ durationMillis: 0, samples: Object.freeze([]) }));
  const range = plan.profile.scroll.duration;
  const durationMillis = lerp(range.minMillis, range.maxMillis, plan.scroll);

  const count = Math.min(
    Limits.samples,
    Math.max(1, Math.ceil(durationMillis / plan.profile.scroll.intervalMillis)),
  );

  let sentX = 0;
  let sentY = 0;

  const samples = Array.from({ length: count }, (_value, index) => {
    const unit = (index + 1) / count;
    const x = index + 1 === count ? deltaX : deltaX * progress(unit);
    const y = index + 1 === count ? deltaY : deltaY * progress(unit);

    const sample = Object.freeze({
      offsetMillis: unit * durationMillis,
      deltaX: x - sentX,
      deltaY: y - sentY,
    });

    sentX = x;
    sentY = y;

    return sample;
  });

  return Result.succeed(Object.freeze({ durationMillis, samples: Object.freeze(samples) }));
};
