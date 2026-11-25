/**
 * The library's readers for a site that owns its page, called in the site's own bundle on its own
 * document, with no protocol in it. It is the composition the library installs in a page over the
 * protocol, so a site reads the same refs, subjects, outline, text, layout and changes as an agent
 * does, draws in the same overlay, and poses elements the same way.
 *
 * What needs the protocol stays out:
 *
 * - trusted input and the checks that make it safe;
 * - pictures;
 * - held page time;
 * - a record that starts before the page's own scripts.
 *
 * Instead, the site acts through its own app and `note`s each act, so the changes it brings name it
 * as their cause. Time is real, so a pose or a drawing is set again on each animation frame. The
 * record starts when the site calls `record`.
 *
 * Requests and results are the page script's own plain data. Boxes are in viewport CSS pixels, and
 * a change's times are epoch milliseconds, as `performance.timeOrigin + performance.now()`. A
 * request the page cannot serve answers `{ invalid }`, and a ref it no longer has `{ stale }`,
 * rather than throwing. `Layout`, `Change` and `Snapshot` hold their schemas. The script runs in
 * the site's own world, so it shares the globals the site's code may patch.
 */
import { compose } from "./internal/page/compose.inpage.ts";
import { overlay } from "./internal/page/overlay.inpage.ts";
import { pose, poseRequest } from "./internal/page/pose.inpage.ts";
import { context } from "./internal/reading/context.inpage.ts";
import { controls } from "./internal/reading/controls.inpage.ts";
import { expectations, type Want } from "./internal/reading/expect.inpage.ts";
import { layout } from "./internal/reading/layout.inpage.ts";
import { elements, names } from "./internal/reading/names.inpage.ts";
import { outline } from "./internal/reading/outline.inpage.ts";
import { ready } from "./internal/reading/ready.inpage.ts";
import { states, subjects } from "./internal/reading/subjects.inpage.ts";
import { text } from "./internal/reading/text.inpage.ts";
import { walk } from "./internal/reading/walk.inpage.ts";
import { changes } from "./internal/timeline/changes.inpage.ts";
import { fold } from "./internal/timeline/fold.inpage.ts";
import { history } from "./internal/timeline/history.inpage.ts";
import { marks } from "./internal/timeline/marks.inpage.ts";
import { record } from "./internal/timeline/record.inpage.ts";
import { sight } from "./internal/timeline/sight.inpage.ts";
import type { Picks } from "./Layout.ts";
import { match, pickRequests, request } from "./Matching.ts";
import type { FindQuery } from "./Page.ts";
import type { Pose } from "./Pose.ts";
import { addresses } from "./Url.ts";

/**
 * The readers, the change record, the overlay and poses for the current document. Make one for
 * each document the site shows, and `stopRecord` the last one's.
 */
export const make = () => {
  const { named, recorder, url, reads } = compose({
    elements,
    names,
    walk,
    match,
    context,
    subjects,
    states,
    expectations,
    text,
    layout,
    controls,
    fold,
    history,
    sight,
    marks,
    record,
    changes,
    ready,
    outline,
    overlay,
    pose,
    addresses,
  });

  const own = overlay(named);

  return {
    /** What a query finds in the viewport: each element's ref, subject, box and state. */
    find: (query: FindQuery) => reads.find(request(query, "viewport")),
    /** Where each pick is, unrounded, with a box for each of the words it asks for. */
    layout: (picks: Picks) => reads.layout(pickRequests(picks)),
    /** Wait up to `millis` until what a query finds in the document is as wanted. */
    until: (query: FindQuery, want: Want, millis: number) =>
      reads.until(request(query, "document"), want, millis),
    /** The page as an outline of its subjects, each control with a ref. */
    snapshot: reads.snapshot,
    /** The text the viewport shows, or one element's. */
    text: reads.text,
    /** Wait up to `millis` for what the page is still loading, quiet for `quietMillis`. */
    ready: (millis: number, quietMillis?: number) => reads.ready(millis, quietMillis),
    /** One task, then a frame; says whether the page painted. */
    settle: reads.settle,
    /** Record what changes from now, until `stopRecord`, or two minutes with no `changes`. */
    record: reads.record,
    stopRecord: reads.stopRecord,
    /** Keep an act the site did through its app at `target` now, for changes to name as cause. */
    note: recorder.note,
    /** What changed in a window of the record, each change with its box. */
    changes: reads.changes,
    /** Draw an SVG document over the viewport, or take it away with null; says where its parts are. */
    draw: reads.overlay,
    /**
     * A layer of the site's own over the viewport, which no reader reads and the record leaves
     * out: a closed shadow root to render into. It takes no pointer, except parts that set
     * `pointer-events: auto`.
     */
    layer: own.mount,
    /** Pose these elements and take the pose off every other. */
    pose: (poses: ReadonlyArray<Pose>) => reads.pose(poses.map(poseRequest)),
    unpose: reads.unpose,
    /** An element's ref, which `pose` and a read's `ref` take. */
    ref: named.refFor,
    /** The element a ref names, while it is in the document. */
    element: named.lookup,
    /** An address without its userinfo or the parameters known to carry secrets. */
    redact: url.redact,
  };
};

export type Site = ReturnType<typeof make>;
