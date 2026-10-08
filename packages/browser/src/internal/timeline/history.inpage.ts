/**
 * In the page: a document's record of what changed, element by element, within fixed bounds. It
 * touches no DOM, so it also runs outside a page.
 *
 * - **A change** is a new state: other words, or presence gained or lost. Within one batch of
 *   mutations the latest state stands, so an element moved in one step has not changed.
 * - **Bounds.** 256 elements, each with its latest 32 changes, kept a minute. On a busier page an
 *   element that keeps changing gives way first, then one never seen in view, then one that has
 *   gone, so news stays. What gives way, and what finds no room, is counted, and the record says it
 *   is whole only after the latest such loss.
 *
 * Each element's history is folded over a window by `fold.inpage.ts`. See `names.inpage.ts` for
 * what a page-side part may use.
 */
import type { Fold, Sample, Shown, Track } from "./fold.inpage.ts";

/** How much the record keeps: elements, changes of each, and for how long. */
export interface Bounds {
  readonly tracks: number;
  readonly samples: number;
  readonly retention: number;
}

export const history = (
  folding: Fold,
  bounds: Bounds = { tracks: 256, samples: 32, retention: 60_000 },
) => {
  const { tracks: maxTracks, samples: maxSamples, retention } = bounds;
  const tracks = new Map<object, Track>();
  // Keys that gave way or found no room: their later changes are counted, not kept.
  let refused = new WeakSet<object>();
  // When the record let changes go, and how many, and the latest such time; keys whose tracks went.
  let losses: Array<[number, number]> = [];
  let lastLoss = Number.NEGATIVE_INFINITY;
  const gone: Array<object> = [];
  let begun: number | undefined;

  // Losses at one time count together. Beyond 256 times the first noted go, so a count falls short
  // rather than over.
  const lose = (at: number, count: number) => {
    const last = losses.at(-1);

    if (count <= 0) return;
    lastLoss = Math.max(lastLoss, at);
    if (last?.[0] === at) last[1] += count;
    else losses.push([at, count]);
    if (losses.length > 256) losses.shift();
  };

  const latest = (track: Track) => track.samples.at(-1)?.at ?? Number.NEGATIVE_INFINITY;

  const drop = (track: Track) => {
    tracks.delete(track.key);
    gone.push(track.key);
  };

  // How often the tracks' samples have changed, and when a search found none to give way, which
  // holds until they change again, so a burst of newcomers pays for one search.
  let version = 0;
  let barren = -1;

  /** What gives way for a newcomer: one that holds no change, then one that keeps changing. */
  const victim = (): Track | undefined => {
    let chosen: Track | undefined;
    let rank = 0;

    for (const track of barren === version ? [] : tracks.values()) {
      const next = folding.rank(track);

      if (next > rank) [chosen, rank] = [track, next];
      if (rank === 4) break;
    }
    if (chosen === undefined) barren = version;

    return chosen;
  };

  const evict = (track: Track) => {
    drop(track);
    if (track.samples.length > 0) refused.add(track.key);
    for (const sample of track.samples) lose(sample.at, 1);
  };

  /** A key the record cannot keep: its change is counted. */
  const refuse = (key: object, at: number): undefined => {
    refused.add(key);
    lose(at, 1);

    return undefined;
  };

  /**
   * A new state for `key` at `at`: its sample, or none when it is no change or finds no room.
   * `initial` says what a key not yet kept showed before.
   */
  const note = (
    key: object,
    kind: Track["kind"],
    at: number,
    shown: Shown,
    initial: () => Shown,
  ): Sample | undefined => {
    let track = tracks.get(key);

    if (track === undefined) {
      const full = !refused.has(key) && tracks.size >= maxTracks;
      const out = full ? victim() : undefined;

      if (refused.has(key) || (full && out === undefined)) return refuse(key, at);
      const before = initial();

      if (shown !== undefined && shown === before) return undefined;
      if (out !== undefined) evict(out);
      track = { key, kind, initial: before, known: Number.NEGATIVE_INFINITY, samples: [] };
      tracks.set(key, track);
    }
    const { samples } = track;

    version++;

    if (samples.at(-1)?.at === at) samples.pop();
    const previous = samples.length === 0 ? track.initial : samples.at(-1)?.shown;

    if (shown !== undefined && shown === previous) return undefined;
    const oldest = samples.length >= maxSamples ? samples.shift() : undefined;

    if (oldest !== undefined) {
      track.initial = oldest.shown;
      track.known = oldest.at;
      lose(oldest.at, 1);
    }
    const sample: Sample = { at, shown, seen: undefined };

    samples.push(sample);

    return sample;
  };

  /** Judge a sample as the page rendered it; a state that repeats the one before is no change. */
  const settle = (key: object, sample: Sample, shown: Shown, seen: boolean) => {
    const track = tracks.get(key);

    // `null` is a state, what shows nothing, so only `undefined` is unjudged.
    version++;
    if (sample.shown === undefined) sample.shown = shown;
    if (sample.seen === undefined) sample.seen = seen;
    if (track === undefined) return;
    let previous = track.initial;

    const changes = track.samples.filter((each) => {
      const same = each.shown !== undefined && each.shown === previous;

      if (!same) previous = each.shown;

      return !same;
    });

    track.samples.splice(0, track.samples.length, ...changes);
  };

  /**
   * The window after `since`, up to `until`: where the record is whole, how many changes in it the
   * record let go, and each element's changes, oldest first by when they began.
   */
  const read = (since: number, until: number, now: number) => {
    for (const track of tracks.values()) if (latest(track) < now - retention) drop(track);

    return {
      from: Math.min(until, Math.max(begun ?? now, now - retention, lastLoss)),
      dropped: losses.reduce(
        (sum, [at, count]) => (at > since && at <= until ? sum + count : sum),
        0,
      ),
      folded: [...tracks.values()]
        .flatMap((track) => folding.over(track, since, until) ?? [])
        .toSorted((left, right) => left.startedAt - right.startedAt),
    };
  };

  /**
   * Each element's changes from `from` on, a field's own edits aside, with whether it came or went
   * at each; and when the record let changes go since. A read judges by them what was in flux
   * before an input.
   */
  const recent = (from: number) => ({
    tracks: Array.from(tracks.values(), ({ key, kind, initial, samples }) => ({
      key,
      changes: samples.flatMap(({ at, shown }, index) =>
        kind === "value" || at < from
          ? []
          : [
              {
                at,
                moved:
                  shown === null || (index === 0 ? initial : samples[index - 1]?.shown) === null,
              },
            ],
      ),
    })),
    losses: losses.flatMap(([at]) => (at < from ? [] : [at])),
  });

  /** When something in view last changed, or something not yet judged; for a wait for stillness. */
  const changing = (): number =>
    Math.max(
      Number.NEGATIVE_INFINITY,
      ...Array.from(
        tracks.values(),
        (track) =>
          track.samples.findLast((sample) => sample.seen !== false)?.at ?? Number.NEGATIVE_INFINITY,
      ),
    );

  return {
    begin: (at: number) => {
      begun = at;
    },
    begun: () => begun !== undefined,
    clear: () => {
      for (const track of tracks.values()) drop(track);
      refused = new WeakSet();
      losses = [];
      lastLoss = Number.NEGATIVE_INFINITY;
      begun = undefined;
    },
    changing,
    /** Keys whose tracks went since this was last asked, for the recorder to stop watching. */
    forgotten: (): ReadonlyArray<object> => gone.splice(0),
    has: (key: object) => tracks.has(key),
    /** Whether the record has let `key` go: its later changes are counted, never kept. */
    refuses: (key: object) => refused.has(key),
    lose,
    note,
    read,
    recent,
    /** A track moves to the element that took its key's place, as a re-rendered price does. */
    rekey: (from: object, to: object): boolean => {
      const track = tracks.get(from);

      if (track === undefined || tracks.has(to)) return false;
      tracks.delete(from);
      track.key = to;
      tracks.set(to, track);

      return true;
    },
    settle,
  };
};

export type History = ReturnType<typeof history>;
