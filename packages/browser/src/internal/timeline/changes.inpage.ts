/**
 * In the page: what changed after `since`, up to `until`, as a read returns it. A read starts the
 * record if it has not, and keeps it going. What waited for the page to render is judged first, as
 * it stands; then each element's history is folded over the window (`history.inpage.ts`), and only
 * now named: its role, its name when something else names it, its tag, and its context, where it
 * is or, for what was removed, where it was. A field's value reads `••••` unless the read unmasks
 * it, and a secret field's always does.
 *
 * A change names its cause, the input it followed, only where it was the input's own doing:
 *
 * - the element had not changed in the second before the input, so it was not already changing;
 * - it changed within 500 ms of the input, or within 3 s where it lies inside what the input
 *   acted on, or in its row, form or dialog, or in what it controls (`aria-controls`), so a reply
 *   from a server keeps its cause.
 *
 * See `names.inpage.ts` for what a page-side part may use.
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

  /** The input a change followed, on the page's clock, where the change was its own doing. */
  const causeOf = (one: Folded, element: Element): number | undefined => {
    for (const input of recorder.inputs().toReversed()) {
      const after = one.startedAt - input.at;

      if (after <= 0) continue;
      if (after > 3000) break;

      const changing =
        one.track.known >= input.at - 1000 ||
        one.track.samples.some((sample) => sample.at < input.at && sample.at >= input.at - 1000);

      if (!changing && (after <= 500 || local(input.target, element))) return input.at;
    }

    return undefined;
  };

  const describe = (one: Folded, known: Known, unmask: boolean): typeof Change.Encoded => {
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
      cause: field || where === null ? undefined : causeOf(one, where),
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

    return {
      until,
      from,
      dropped,
      records: folded.map((one) => describe(one, known, request.unmask)),
    };
  };

  return { read };
};

export type Changes = ReturnType<typeof changes>;
