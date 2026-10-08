/**
 * In the page: what changed after `since`, up to `until`, as a read returns it. A read starts the
 * record if it has not, and keeps it going. What waited for the page to render is judged first, as
 * it stands; then each element's history is folded over the window (`history.inpage.ts`), and only
 * now named: its role, its name when something else names it, its tag, and its context, where it
 * is or, for what was removed, where it was. A field's value reads `••••` unless the read unmasks
 * it, and a secret field's always does. A change names the input it followed only where it was
 * the input's own doing, by `Change.cause`'s rule. See `names.inpage.ts` for what a page-side part
 * may use.
 */
import { Schema } from "effect";

import { Change } from "../../Change.ts";
import type { Known, ContextReader } from "../reading/context.inpage.ts";
import type { Names } from "../reading/names.inpage.ts";
import type { Folded } from "./fold.inpage.ts";
import type { History } from "./history.inpage.ts";
import type { Marks } from "./marks.inpage.ts";
import type { Recorder } from "./record.inpage.ts";
import type { Sight } from "./sight.inpage.ts";

/** A window on the page's own clock: epoch milliseconds, or the record's start and now. */
export interface ChangesRequest {
  readonly since: number | null;
  readonly until: number | null;
  readonly unmask: boolean;
}

/**
 * What a read sends back: its window and the record's state, and each change as `Change` encodes
 * it, all on the page's clock.
 */
export const ChangesResultSchema = Schema.Struct({
  until: Schema.Finite,
  from: Schema.Finite,
  dropped: Schema.Int,
  records: Schema.Array(Change),
});

export type ChangesResult = typeof ChangesResultSchema.Encoded;

export const changes = (
  names: Names,
  placing: ContextReader,
  kept: History,
  seeing: Sight,
  marking: Marks,
  recorder: Recorder,
) => {
  const { clean, isInput, roleOf, nameOf } = names;
  const groups = "tr,[role=row],form,dialog,[role=dialog],[role=alertdialog]";

  /** Whether `element` lies in what an input on `target` acted on, its group, or what it controls. */
  const local = (target: Element, element: Element): boolean => {
    const controls = target.closest("[aria-controls]")?.getAttribute("aria-controls") ?? "";
    const group = target.closest(groups);

    return (
      target.contains(element) ||
      group?.contains(element) === true ||
      controls
        .split(/\s+/)
        .some((id) => id !== "" && document.getElementById(id)?.contains(element) === true)
    );
  };

  /** What an element sits in, or sat in as it went. */
  const parentOf = (key: object): Element | null =>
    key instanceof Element
      ? key.isConnected
        ? key.parentElement
        : (marking.placeOf(key) ?? null)
      : null;

  // What changed in the 10 s before an input is in flux at it, and a change in the 2 s before says
  // the page was not still.
  const fluxMillis = 10_000;
  const stillMillis = 2000;

  /**
   * Each input a change may follow, with what the page did before it: what changed in the 10 s
   * before, the parents that gained or lost a child then, and whether nothing changed, and nothing
   * was let go, in the 2 s before. What holds the input's target, as a menu holds its item, came
   * with it, so it counts only as changing itself.
   */
  const before = () => {
    const inputs = recorder.inputs();

    if (inputs.length === 0) return [];
    const { tracks, losses } = kept.recent();

    return inputs.map(({ at, target }) => {
      const changed = new Set<object>();
      const moved = new Set<Element | null>();
      let still = losses.every((lost) => lost >= at || lost < at - stillMillis);

      for (const { key, kind, initial, samples } of tracks) {
        // Whether each change in the 10 s before came or went: it, or what it followed, showed
        // nothing. A field's own edits are the input's, not the page's.
        const prior = samples.flatMap(({ at: when, shown }, index) =>
          kind === "value" || when >= at || when < at - fluxMillis
            ? []
            : [shown === null || (index === 0 ? initial : samples[index - 1]?.shown) === null],
        );

        if (prior.length > 0) changed.add(key);
        if (prior.length === 0 || (key instanceof Element && key.contains(target))) continue;
        if (prior.includes(true)) moved.add(parentOf(key));
        if (samples.some(({ at: when }) => when < at && when >= at - stillMillis)) still = false;
      }

      return { at, target, changed, moved, still };
    });
  };

  /** The input a change followed, on the page's clock, where `Change.cause`'s rule names one. */
  const causeOf = (
    one: Folded,
    element: Element,
    inputs: ReturnType<typeof before>,
  ): number | undefined => {
    const parent = parentOf(one.track.key);

    for (const input of inputs.toReversed()) {
      const after = one.startedAt - input.at;

      if (after <= 0) continue;
      if (after > 3000) break;

      // In flux: it changed, or another came into or left what it sits in, in the 10 s before.
      const changing =
        one.track.known >= input.at - fluxMillis ||
        input.changed.has(one.track.key) ||
        (parent !== null && input.moved.has(parent));

      if (!changing && (local(input.target, element) || (after <= 500 && input.still)))
        return input.at;
    }

    return undefined;
  };

  const describe = (
    one: Folded,
    known: Known,
    unmask: boolean,
    inputs: ReturnType<typeof before>,
  ): typeof Change.Encoded => {
    const { track, kind, before, after, lowest, highest, ...times } = one;
    const element = track.key instanceof Element ? track.key : null;
    const where = element?.isConnected === true ? element : (marking.placeOf(track.key) ?? null);
    const role = element === null ? null : roleOf(element);
    const field = kind === "value";

    const checkable =
      element !== null && isInput(element) && /^(checkbox|radio)$/.test(element.type);

    // A field's value is masked unless asked, empty or a box's state; a secret one never kept more.
    const masked = (value: string | undefined) =>
      value === undefined || !field || unmask || checkable || value === "" ? value : "••••";

    return {
      ...times,
      kind,
      subject: {
        role,
        // An element's own words are what changed, so it is named only by what else names it.
        name:
          element === null
            ? ""
            : field
              ? nameOf(element, role)
              : clean(element.getAttribute("aria-label"), 120),
        tag: element === null ? "title" : element.tagName.toLowerCase(),
        context: kind === "title" || where === null ? {} : placing.contextOf(where, known),
      },
      before: masked(before),
      after: masked(after),
      lowest: field ? undefined : lowest,
      highest: field ? undefined : highest,
      // A field's own edit needs no cause.
      cause: field || where === null ? undefined : causeOf(one, where, inputs),
    };
  };

  /** What changed after `since`, up to `until`, and no later than now. */
  const read = (request: ChangesRequest): ChangesResult => {
    const now = performance.timeOrigin + performance.now();

    recorder.start();
    seeing.settle();
    const until = Math.min(request.until ?? now, now);

    const { from, dropped, folded } = kept.read(
      request.since ?? Number.NEGATIVE_INFINITY,
      until,
      now,
    );

    const known = placing.known();
    const inputs = before();

    return {
      until,
      from,
      dropped,
      records: folded.map((one) => describe(one, known, request.unmask, inputs)),
    };
  };

  return { read };
};

export type Changes = ReturnType<typeof changes>;
