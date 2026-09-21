import { Effect, Random } from "effect";

/**
 * Seeded models of how a person moves, types, scrolls and pauses.
 *
 * Everything here is arithmetic over the `Random` service, so one
 * `Random.withSeed` reproduces a whole performance and nothing needs a browser
 * to test. Each constant names the measurement it comes from; the ones marked
 * "chosen" are demo pacing rather than a finding.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Box extends Point {
  readonly width: number;
  readonly height: number;
}

/** One sample of a timed track. The page interpolates linearly between samples. */
export interface Waypoint extends Point {
  readonly atMillis: number;
}

export interface ScrollSample {
  readonly atMillis: number;
  readonly top: number;
}

/** The whole value a field holds after one key, and the pause that precedes that key. */
export interface Keystroke {
  readonly value: string;
  readonly afterMillis: number;
}

/** Tracks are sampled at display rate; the page never needs a finer grain than a frame. */
const SampleMillis = 1000 / 60;

export const Pointer = {
  /** Fitts's law, MT = a + b·log2(D/W + 1). Mouse fits put b at 85–200 ms/bit (MacKenzie 1992). */
  fittsInterceptMillis: 100,
  fittsSlopeMillisPerBit: 150,
  /** Long moves overshoot and correct; ghost-cursor uses the same 500px threshold. */
  overshootBeyondPixels: 500,
  /** Chosen: not every long move misses. */
  overshootChance: 0.65,
  overshootPixels: [6, 18],
  correctionPauseMillis: [50, 110],
  /** Bézier control points sit this fraction of the distance off the straight line. */
  curvature: [0.04, 0.16],
  /** Clicks land around the centre, never on it, and never in the outer 15%. */
  aimDeviation: 1 / 6,
  aimInset: 0.15,
} as const;

export const Typing = {
  /** 136M-keystroke study (Dhakal et al., CHI 2018): right-skewed intervals with a ~60ms floor. */
  floorMillis: 60,
  /** Chosen: a fast typist's median. The study's population mean of 239ms reads as slow on film. */
  medianMillis: 130,
  logSigma: 0.32,
  /** The word-initiation effect: the key after a space is slower. */
  wordStartMillis: [80, 150],
  shiftedMillis: [40, 90],
  /** Chosen. The study reports 1.17% uncorrected errors; corrected ones are more common. */
  typoChance: 0.025,
  noticeMillis: [180, 340],
} as const;

export const Scrolling = {
  /** Chosen: one flick of a wheel or trackpad. */
  flickPixels: [260, 480],
  flickMillis: [380, 560],
  betweenFlicksMillis: [90, 220],
} as const;

export const Pacing = {
  /** Settle on the target before pressing; webreel's click dwell is the same range. */
  dwellBeforeClickMillis: [80, 180],
  afterClickMillis: [260, 480],
  /** Silent reading averages 238 words per minute (Brysbaert 2019). */
  readingWordsPerMinute: 238,
  /** Chosen: a viewer skims what the presenter reads. */
  skim: 0.4,
  readingBoundsMillis: [600, 3_500],
} as const;

type Range = readonly [minimum: number, maximum: number];

export const between = ([minimum, maximum]: Range) => Random.nextBetween(minimum, maximum);

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));

/** Box–Muller over two uniform draws. */
const standardNormal = Effect.gen(function* () {
  const radius = Math.sqrt(-2 * Math.log(1 - (yield* Random.next)));

  return radius * Math.cos(2 * Math.PI * (yield* Random.next));
});

/** Flash & Hogan's minimum-jerk position profile: a bell-shaped velocity with zero end speed. */
export const minimumJerk = (progress: number) =>
  progress * progress * progress * (10 - 15 * progress + 6 * progress * progress);

const easeOutCubic = (progress: number) => 1 - (1 - progress) ** 3;

export const fittsMillis = (distance: number, targetWidth: number) =>
  Pointer.fittsInterceptMillis +
  Pointer.fittsSlopeMillisPerBit * Math.log2(distance / Math.max(1, targetWidth) + 1);

const distanceBetween = (from: Point, to: Point) => Math.hypot(to.x - from.x, to.y - from.y);

/** A point near the centre of a control, the way a hand aims rather than the way a selector resolves. */
export const aimPoint = Effect.fnUntraced(function* (box: Box) {
  const along = (origin: number, size: number, deviation: number) =>
    origin +
    size * clamp(0.5 + deviation * Pointer.aimDeviation, Pointer.aimInset, 1 - Pointer.aimInset);

  return {
    x: along(box.x, box.width, yield* standardNormal),
    y: along(box.y, box.height, yield* standardNormal),
  };
});

/**
 * One continuous stroke: a cubic Bézier whose control points bow to the same
 * side of the straight line, travelled on the minimum-jerk profile.
 */
const stroke = Effect.fnUntraced(function* (
  from: Point,
  to: Point,
  durationMillis: number,
  startMillis: number,
) {
  const distance = distanceBetween(from, to);
  const side = (yield* Random.nextBoolean) ? 1 : -1;

  // The unit normal of the straight line, so the bow is perpendicular to travel.
  const normal = {
    x: (-(to.y - from.y) / distance) * side,
    y: ((to.x - from.x) / distance) * side,
  };

  const control = Effect.fnUntraced(function* (fraction: number) {
    const bow = distance * (yield* between(Pointer.curvature));

    return {
      x: from.x + (to.x - from.x) * fraction + normal.x * bow,
      y: from.y + (to.y - from.y) * fraction + normal.y * bow,
    };
  });

  const first = yield* control(1 / 3);
  const second = yield* control(2 / 3);
  const samples = Math.max(2, Math.ceil(durationMillis / SampleMillis));

  return Array.from({ length: samples }, (_, index): Waypoint => {
    const progress = (index + 1) / samples;
    const t = minimumJerk(progress);
    const u = 1 - t;

    return {
      x: u ** 3 * from.x + 3 * u * u * t * first.x + 3 * u * t * t * second.x + t ** 3 * to.x,
      y: u ** 3 * from.y + 3 * u * u * t * first.y + 3 * u * t * t * second.y + t ** 3 * to.y,
      atMillis: startMillis + progress * durationMillis,
    };
  });
});

/**
 * The pointer's path to a target, timed by Fitts's law: far or small targets
 * take longer, and a long reach may overshoot and come back.
 */
export const pointerPath = Effect.fnUntraced(function* (
  from: Point,
  to: Point,
  targetWidth: number,
) {
  const distance = distanceBetween(from, to);

  if (distance < 1) return [{ ...to, atMillis: 0 }];

  const overshoots =
    distance > Pointer.overshootBeyondPixels && (yield* Random.next) < Pointer.overshootChance;

  if (!overshoots) return yield* stroke(from, to, fittsMillis(distance, targetWidth), 0);

  const beyond = (yield* between(Pointer.overshootPixels)) / distance;
  const drift = yield* between([-6, 6]);

  const missed = {
    x: to.x + (to.x - from.x) * beyond + drift,
    y: to.y + (to.y - from.y) * beyond - drift,
  };

  // The ballistic phase aims at a fatter target than the correction does.
  const reach = yield* stroke(from, missed, fittsMillis(distance, targetWidth * 2), 0);

  const reachedAt = (reach.at(-1)?.atMillis ?? 0) + (yield* between(Pointer.correctionPauseMillis));

  const correction = yield* stroke(
    missed,
    to,
    fittsMillis(distanceBetween(missed, to), targetWidth),
    reachedAt,
  );

  return [...reach, ...correction];
});

/** A scroll as a few eased flicks with a breath between them, not one teleport. */
export const scrollTrack = Effect.fnUntraced(function* (fromTop: number, toTop: number) {
  const direction = Math.sign(toTop - fromTop);
  const track: Array<ScrollSample> = [];
  let top = fromTop;
  let atMillis = 0;

  while (Math.abs(toTop - top) >= 1) {
    const remaining = Math.abs(toTop - top);
    const wanted = yield* between(Scrolling.flickPixels);
    // A leftover too small to be its own flick is folded into this one.
    const length = remaining - wanted < Scrolling.flickPixels[0] / 2 ? remaining : wanted;
    const durationMillis = yield* between(Scrolling.flickMillis);
    const samples = Math.ceil(durationMillis / SampleMillis);
    const start = top;

    for (let index = 1; index <= samples; index++) {
      track.push({
        atMillis: atMillis + (index / samples) * durationMillis,
        top: start + direction * length * easeOutCubic(index / samples),
      });
    }
    top = start + direction * length;
    atMillis += durationMillis + (yield* between(Scrolling.betweenFlicksMillis));
  }

  return track;
});

/** Physical neighbours on a QWERTY board: the only slips a touch typist plausibly makes. */
const Neighbours: Readonly<Record<string, string>> = {
  a: "sq",
  b: "vn",
  c: "xv",
  d: "sf",
  e: "wr",
  f: "dg",
  g: "fh",
  h: "gj",
  i: "uo",
  j: "hk",
  k: "jl",
  l: "k",
  m: "n",
  n: "bm",
  o: "ip",
  p: "o",
  q: "w",
  r: "et",
  s: "ad",
  t: "ry",
  u: "yi",
  v: "cb",
  w: "qe",
  x: "zc",
  y: "tu",
  z: "x",
};

const keyInterval = Effect.map(standardNormal, (deviation) =>
  Math.max(Typing.floorMillis, Typing.medianMillis * Math.exp(Typing.logSigma * deviation)),
);

/**
 * Typing as the sequence of values the field passes through. A slip is just
 * three more values: the wrong letter, the field without it, the right letter.
 */
export const keystrokes = Effect.fnUntraced(function* (
  text: string,
  options: { readonly typoChance?: number } = {},
) {
  const typoChance = options.typoChance ?? Typing.typoChance;
  const strokes: Array<Keystroke> = [];
  let typed = "";

  for (const character of text) {
    let afterMillis = yield* keyInterval;

    if (typed.endsWith(" ")) afterMillis += yield* between(Typing.wordStartMillis);
    if (character !== character.toLowerCase()) afterMillis += yield* between(Typing.shiftedMillis);

    const neighbours = Neighbours[character];

    if (neighbours !== undefined && (yield* Random.next) < typoChance) {
      const slip = neighbours.charAt(yield* Random.nextIntBetween(0, neighbours.length - 1));

      strokes.push({ value: typed + slip, afterMillis });
      strokes.push({ value: typed, afterMillis: yield* between(Typing.noticeMillis) });
      afterMillis = yield* keyInterval;
    }

    typed += character;
    strokes.push({ value: typed, afterMillis });
  }

  return strokes;
});

/** How long to rest on freshly revealed text, scaled to how much of it there is. */
export const readingMillis = (words: number) =>
  clamp(
    (words / Pacing.readingWordsPerMinute) * 60_000 * Pacing.skim,
    Pacing.readingBoundsMillis[0],
    Pacing.readingBoundsMillis[1],
  );
