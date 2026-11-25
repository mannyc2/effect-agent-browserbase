/**
 * In the page: the readers, the change record, the overlay and element poses, composed from their
 * parts in the order they depend on one another. The page script installs this with trusted
 * input's checks and held time over it (`bridge.ts`); a site that owns its page calls it in its
 * own bundle (`Site.ts`). See `names.inpage.ts` for what a page-side part may use.
 */
import type { match } from "../../Matching.ts";
import type { addresses } from "../../Url.ts";
import type { context } from "../reading/context.inpage.ts";
import type { controls } from "../reading/controls.inpage.ts";
import type { expectations } from "../reading/expect.inpage.ts";
import type { layout } from "../reading/layout.inpage.ts";
import type { elements, names } from "../reading/names.inpage.ts";
import type { outline } from "../reading/outline.inpage.ts";
import type { ready } from "../reading/ready.inpage.ts";
import type { states, subjects } from "../reading/subjects.inpage.ts";
import type { text } from "../reading/text.inpage.ts";
import type { walk } from "../reading/walk.inpage.ts";
import type { changes } from "../timeline/changes.inpage.ts";
import type { fold } from "../timeline/fold.inpage.ts";
import type { history } from "../timeline/history.inpage.ts";
import type { marks } from "../timeline/marks.inpage.ts";
import type { record } from "../timeline/record.inpage.ts";
import type { sight } from "../timeline/sight.inpage.ts";
import type { overlay } from "./overlay.inpage.ts";
import type { pose } from "./pose.inpage.ts";

/** The parts composed, by name. */
export interface Composed {
  readonly elements: typeof elements;
  readonly names: typeof names;
  readonly walk: typeof walk;
  readonly match: typeof match;
  readonly context: typeof context;
  readonly subjects: typeof subjects;
  readonly states: typeof states;
  readonly expectations: typeof expectations;
  readonly text: typeof text;
  readonly layout: typeof layout;
  readonly controls: typeof controls;
  readonly fold: typeof fold;
  readonly history: typeof history;
  readonly sight: typeof sight;
  readonly marks: typeof marks;
  readonly record: typeof record;
  readonly changes: typeof changes;
  readonly ready: typeof ready;
  readonly outline: typeof outline;
  readonly overlay: typeof overlay;
  readonly pose: typeof pose;
  readonly addresses: typeof addresses;
}

/** Compose the parts; refs go on from `next`, as a script installed before left them. */
export const compose = (parts: Composed, next?: number) => {
  const named = parts.names(parts.elements());

  if (next !== undefined) named.refs.next = next;
  const walked = parts.walk(named);
  const placing = parts.context(named, walked);
  const matching = parts.match();
  const subjected = parts.subjects(named, walked, matching, placing, parts.states(named));
  const texts = parts.text(named, walked);
  const controlled = parts.controls(named, subjected, texts);
  const kept = parts.history(parts.fold());
  const seeing = parts.sight(named, walked, texts, kept);
  const marking = parts.marks(named, kept, seeing);
  const recorder = parts.record(named, texts, kept, seeing, marking);
  const url = parts.addresses();
  const read = parts.outline(named, walked, subjected, texts, controlled, url);
  const readiness = parts.ready(walked, texts, kept);
  const overlaid = parts.overlay(named);
  const posing = parts.pose(named);

  return {
    named,
    walked,
    placing,
    overlaid,
    posing,
    recorder,
    url,
    reads: {
      refs: named.refs,
      snapshot: read.snapshot,
      find: subjected.find,
      layout: parts.layout(named, walked, subjected, matching, placing).read,
      overlay: overlaid.draw,
      pose: posing.set,
      unpose: posing.clear,
      until: parts.expectations(named, subjected, matching).until,
      text: texts.read,
      record: recorder.start,
      stopRecord: recorder.stop,
      changes: parts.changes(named, walked, placing, kept, seeing, marking, recorder).read,
      ready: readiness.wait,
      settle: readiness.settle,
      viewport: read.viewport,
    },
  };
};
