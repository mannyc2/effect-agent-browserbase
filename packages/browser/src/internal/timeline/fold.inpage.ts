/**
 * In the page: one element's history in the change record, and its fold over a window. A fold gives
 * what the element showed at the window's start and at its end, how often that changed between,
 * the lowest and highest of a number that changed more than once, and when it last changed before
 * the window. Only what was seen in view as it changed is told. It touches no DOM, so it also runs
 * outside a page. See `names.inpage.ts` for what a page-side part may use.
 */

/** What an element shows: its words, `null` while it shows nothing, `undefined` until judged. */
export type Shown = string | null | undefined;

export interface Sample {
  readonly at: number;
  shown: Shown;
  /** Whether it was in view as the page rendered it; undefined until then. */
  seen: boolean | undefined;
}

/** One element's history, oldest change first. */
export interface Track {
  key: object;
  readonly kind: "content" | "value" | "title";
  /** What it showed before its oldest kept change; undefined when that is unknown. */
  initial: Shown;
  /** Before this, the record let some of its changes go. */
  known: number;
  readonly samples: Array<Sample>;
}

export type Kind = "text" | "appeared" | "disappeared" | "brief" | "value" | "title";

/** One element's changes over a window, before the page names the element. */
export interface Folded {
  readonly track: Track;
  readonly kind: Kind;
  readonly startedAt: number;
  readonly at: number;
  readonly before: string | undefined;
  readonly after: string | undefined;
  readonly count: number;
  readonly lowest: string | undefined;
  readonly highest: string | undefined;
  readonly earlier: number | undefined;
}

export const fold = () => {
  /** The one number some words show, such as 61240 in "$61,240"; none for none or several. */
  const number = (words: string): ReadonlyArray<number> => {
    const found = words.match(/[-+−]?\d[\d,]*(?:\.\d+)?/g);

    const value = Number(
      found?.length === 1 ? found[0]?.replaceAll(",", "").replace("−", "-") : "",
    );

    return found?.length === 1 && Number.isFinite(value) ? [value] : [];
  };

  /** A track's changes after `since`, up to `until`, if one was seen in view. */
  const over = (track: Track, since: number, until: number): Folded | undefined => {
    const inside = track.samples.filter((sample) => sample.at > since && sample.at <= until);
    const first = inside[0];
    const last = inside.at(-1);

    if (first === undefined || last === undefined || !inside.some((sample) => sample.seen === true))
      return undefined;
    const prior = track.samples[track.samples.indexOf(first) - 1];
    // What it showed at `since` is lost when the record let go of changes after it.
    const lost = track.known <= since ? track.known : undefined;

    const start =
      prior === undefined ? (lost === undefined ? undefined : track.initial) : prior.shown;

    const words = [start, ...inside.map((sample) => sample.shown)].filter(
      (each) => typeof each === "string",
    );

    const numbers = words.flatMap(number);
    const ranged = inside.length > 1 && numbers.length === words.length;

    const kind: Kind =
      track.kind !== "content"
        ? track.kind
        : last.shown === null
          ? start === null
            ? "brief"
            : "disappeared"
          : start === null
            ? "appeared"
            : "text";

    return {
      track,
      kind,
      startedAt: first.at,
      at: last.at,
      before: kind === "disappeared" ? words.at(-1) : (start ?? undefined),
      after: kind === "brief" ? words.at(-1) : (last.shown ?? undefined),
      count: inside.length,
      lowest: ranged ? words[numbers.indexOf(Math.min(...numbers))] : undefined,
      highest: ranged ? words[numbers.indexOf(Math.max(...numbers))] : undefined,
      earlier: prior?.at ?? (lost === Number.NEGATIVE_INFINITY ? undefined : lost),
    };
  };

  return { number, over };
};

export type Fold = ReturnType<typeof fold>;
