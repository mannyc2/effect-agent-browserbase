/**
 * Constant-frame-rate resampling of a change-driven capture.
 *
 * A screencast delivers a frame when the page repaints, so a still page
 * delivers nothing and a busy one delivers bursts. A player expects evenly
 * spaced frames. The reel places each frame in the slot its own presentation
 * timestamp names and holds the previous picture across empty slots, so a
 * three-second reading pause is three seconds on film rather than one frame.
 *
 * Plain state and arithmetic: `Camera.ts` folds a stream through it, and
 * `test/realistic-footage.test.ts` checks it without a browser.
 */

export interface Exposure {
  readonly bytes: Uint8Array;
  /** The browser's presentation clock. Only differences between exposures are used. */
  readonly sourceTimeMillis: number;
}

export interface Reel {
  readonly framesPerSecond: number;
  readonly firstMillis: number;
  /** The newest exposure, not yet emitted: a later one in the same slot replaces it. */
  readonly held: Exposure;
  readonly heldSlot: number;
}

const slotOf = (reel: Reel, sourceTimeMillis: number) =>
  Math.floor(((sourceTimeMillis - reel.firstMillis) * reel.framesPerSecond) / 1000);

const repeated = (bytes: Uint8Array, count: number) =>
  Array.from({ length: Math.max(0, count) }, () => bytes);

/** Admit one exposure; returns the pictures whose slots are now settled. */
export const expose = (
  reel: Reel | undefined,
  exposure: Exposure,
  framesPerSecond: number,
): readonly [Reel, ReadonlyArray<Uint8Array>] => {
  if (reel === undefined)
    return [
      { framesPerSecond, firstMillis: exposure.sourceTimeMillis, held: exposure, heldSlot: 0 },
      [],
    ];

  const slot = slotOf(reel, exposure.sourceTimeMillis);

  // Same slot, or a timestamp that ran backwards: the newer picture wins the slot.
  if (slot <= reel.heldSlot) return [{ ...reel, held: exposure }, []];

  return [
    { ...reel, held: exposure, heldSlot: slot },
    repeated(reel.held.bytes, slot - reel.heldSlot),
  ];
};

/** End the reel, holding the last picture for however long the page stayed still before the cut. */
export const cut = (reel: Reel | undefined, stillMillis: number): ReadonlyArray<Uint8Array> => {
  if (reel === undefined) return [];

  const lastSlot = slotOf(reel, reel.held.sourceTimeMillis + Math.max(0, stillMillis));

  return repeated(reel.held.bytes, Math.max(1, lastSlot - reel.heldSlot + 1));
};
