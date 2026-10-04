/**
 * Pointer paths and key timing that look like a person at the controls rather than a script:
 * curved motion that eases in and out, with a duration that grows with distance.
 */
import { Effect, Random } from "effect";

interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Step extends Point {
  /** Milliseconds to wait before moving to this point. */
  readonly delay: number;
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/**
 * A curved path from `from` to `to`. Its duration follows Fitts's law: long moves take longer,
 * but not proportionally longer.
 */
export const path = Effect.fnUntraced(function* (from: Point, to: Point) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);

  if (distance < 2) return [{ ...to, delay: 0 }];
  const duration = 180 + 110 * Math.log2(1 + distance / 40);
  const steps = Math.max(6, Math.min(40, Math.round(duration / 16)));
  // One control point pulled off the straight line gives a gentle arc.
  const bend = (yield* Random.nextBetween(-0.25, 0.25)) * distance;
  const normalX = distance === 0 ? 0 : -dy / distance;
  const normalY = distance === 0 ? 0 : dx / distance;
  const controlX = from.x + dx / 2 + normalX * bend;
  const controlY = from.y + dy / 2 + normalY * bend;
  const out: Array<Step> = [];

  for (let index = 1; index <= steps; index++) {
    const t = ease(index / steps);
    const x = (1 - t) ** 2 * from.x + 2 * (1 - t) * t * controlX + t * t * to.x;
    const y = (1 - t) ** 2 * from.y + 2 * (1 - t) * t * controlY + t * t * to.y;

    out.push({ x: Math.round(x), y: Math.round(y), delay: duration / steps });
  }

  return out;
});

/** The pause between two keystrokes, around 90 ms with some spread. */
export const keyDelay = Random.nextBetween(45, 140);

/** The pause between pressing and releasing a mouse button. */
export const pressDelay = Random.nextBetween(40, 110);
