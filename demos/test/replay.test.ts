// What a replay shows at an instant, from recorded events alone: the pointer along its planned
// glide, a canceled glide's end, a jump with no glide, and which page is on screen.
import { assert, describe, it } from "@effect/vitest";
import {
  Action,
  Navigated,
  PageClosed,
  PageLoaded,
  PageOpened,
  RecordedEvent,
  TrackPerformed,
  TrackPlanned,
  type BrowserEvent,
} from "effect-browser/BrowserEvent";

import { pointerAt, shownFrames, track } from "../src/Replay.ts";

const recorded = (...events: ReadonlyArray<BrowserEvent>) =>
  events.map((event, index) => new RecordedEvent({ sequence: index + 1, event }));

const glide = new TrackPlanned({
  at: 1000,
  page: "p1",
  from: { x: 0, y: 0 },
  samples: [
    { x: 0, y: 0, afterMillis: 0 },
    { x: 100, y: 50, afterMillis: 100 },
    { x: 200, y: 50, afterMillis: 200 },
  ],
});

describe("pointerAt", () => {
  it("follows a planned glide between its samples and holds at its end", () => {
    const recording = track(recorded(glide));

    assert.isUndefined(pointerAt(recording, 999));
    assert.deepInclude(pointerAt(recording, 1050), { x: 50, y: 25 });
    assert.deepInclude(pointerAt(recording, 1150), { x: 150, y: 50 });
    assert.deepInclude(pointerAt(recording, 5000), { x: 200, y: 50 });
  });

  it("stops a canceled glide where its submitted prefix ended", () => {
    const canceled = new TrackPerformed({
      at: 1100,
      page: "p1",
      plan: 1,
      dispatched: 2,
      x: 100,
      y: 50,
      complete: false,
    });

    const recording = track(recorded(glide, canceled));

    assert.deepInclude(pointerAt(recording, 1500), { x: 100, y: 50 });
  });

  it("jumps to an action's point when no glide took it there", () => {
    const typed = new Action({
      at: 2100,
      startedAt: 2000,
      page: "p1",
      name: "type",
      x: 30,
      y: 40,
      ok: true,
      dispatched: true,
    });

    const recording = track(recorded(typed));

    assert.isUndefined(pointerAt(recording, 1999));
    assert.deepInclude(pointerAt(recording, 2000), { x: 30, y: 40 });
    assert.deepInclude(pointerAt(recording, 2050), { x: 30, y: 40 });
  });
});

describe("shownFrames", () => {
  const frame = (page: string, hostTime: number) => ({ page, hostTime });

  // A page that finishes loading behind another does not take the screen.
  it("shows the page the latest event concerned, and every page after it closes", () => {
    const events = recorded(
      new PageOpened({ at: 0, page: "p1", url: "about:blank" }),
      new Navigated({
        at: 10,
        page: "p1",
        url: "https://bench.test/",
        document: 1,
        sameDocument: false,
      }),
      new PageOpened({ at: 100, page: "p2", url: "about:blank" }),
      new PageLoaded({ at: 120, page: "p1", state: "load" }),
      new PageClosed({ at: 200, page: "p2", cause: "page" }),
    );

    const frames = [
      frame("p1", 50),
      frame("p2", 60),
      frame("p2", 150),
      frame("p1", 160),
      frame("p1", 250),
    ];

    assert.deepStrictEqual(shownFrames(frames, events), [
      frame("p1", 50),
      frame("p2", 150),
      frame("p1", 250),
    ]);
  });
});
