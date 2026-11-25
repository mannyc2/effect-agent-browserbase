// The film example, run on local Chromium: the page answers each contact on the frame it is sent,
// what changed is read back with its box and time, and a link click is a passage. The site is
// served through the request policy, as a hosted browser would be served it.
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { PNG } from "playwright-core/lib/utilsBundle";

import { film, origin, requests } from "../examples/film.ts";
import type { Box } from "../src/BrowserEvent.ts";
import type * as Film from "../src/film/Film.ts";
import * as Layout from "../src/Layout.ts";
import * as Chromium from "../src/providers/Chromium.ts";

// The red, green and blue of each pixel of a frame's row `y` from `left` to `right`.
const row = (shot: Film.Shot | undefined, y: number, left: number, right: number) => {
  const { width, data } = PNG.sync.read(Buffer.from(shot?.image.data ?? []));

  return Array.from({ length: Math.round(right - left) }, (_, index) => {
    const at = (Math.round(y) * width + Math.round(left) + index) * 4;

    return { r: data[at] ?? 0, g: data[at + 1] ?? 0, b: data[at + 2] ?? 0 };
  });
};

const median = (values: ReadonlyArray<number>) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? Number.NaN;

const middle = (box: Box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

const contains = (box: Box | undefined, { x, y }: { x: number; y: number }) =>
  box !== undefined &&
  x >= box.x &&
  x <= box.x + box.width &&
  y >= box.y &&
  y <= box.y + box.height;

it.live("films the page answering each contact on its frame, what changed, and a passage", () =>
  Effect.gen(function* () {
    const shots: Array<Film.Shot> = [];

    const { summary, changed, layout } = yield* film((shot) => Effect.sync(() => shots.push(shot)));

    assert.strictEqual(summary.frames, 240);
    assert.isTrue(shots.every(({ image }) => image.mediaType === "image/png"));
    assert.deepStrictEqual([shots[0]?.image.width, shots[0]?.image.height], [640, 360]);
    assert.deepStrictEqual(
      summary.sent.map(({ t, label }) => [t, label]),
      [
        [600, "hover"],
        [1200, "tab"],
        [2400, "select"],
        [2900, "copy"],
        [3200, "search"],
        [3450, "s"],
        [3570, "t"],
        [3690, "r"],
        [4100, "close"],
        [5700, "drag"],
        [6000, "docs"],
      ],
    );
    assert.deepStrictEqual(
      summary.passages.map(({ t, url: to }) => [t, new URL(to).pathname]),
      [[6000, "/docs"]],
    );
    assert.strictEqual(new URL(shots.at(-1)?.url ?? origin).pathname, "/docs");

    const docs = Layout.place(layout, "docs")?.box;
    const usage = Layout.place(layout, "usage")?.box;
    const copy = Layout.place(layout, "copy")?.box;

    const word = Layout.place(layout, "lede")?.words?.find(({ text }) =>
      text.startsWith("concurrency"),
    )?.box;

    const [rowWord] = Layout.place(layout, "row")?.words ?? [];

    if (!docs || !usage || !copy || !word || !rowWord) return assert.fail("the example's places");

    // Frames are 1/30 s apart, so frame 18 is at 600 ms. The link's underline eases in over
    // 300 ms from the frame the pointer reaches it: none there, a part 100 ms on, all of it later.
    const underline = (index: number) =>
      median(
        row(shots[index], docs.y + docs.height - 1.5, docs.x + 1, docs.x + docs.width - 1).map(
          ({ g }) => g,
        ),
      );

    assert.isAbove(underline(18), 245, "no underline as the pointer arrives");
    assert.closeTo(underline(21), 137, 15, "a part of the underline 100 ms on");
    assert.isBelow(underline(30), 70, "the whole underline");

    // The tab's bar slides 120 px over 400 ms from the click's frame, 36.
    const bar = (index: number) =>
      row(shots[index], usage.y + usage.height, 0, usage.x + usage.width).findIndex(
        ({ r, g, b }) => r > 150 && g < 100 && b < 100,
      );

    assert.closeTo(bar(36), usage.x - usage.width, 1, "the bar where it was");
    assert.closeTo(bar(40), usage.x - usage.width + 66, 7, "the bar partway");
    assert.closeTo(bar(60), usage.x, 1, "the bar under the tab");

    // The double click on frame 72 selects the word: its highlight, above letters that rise no
    // higher than an x, where glyphs' coloured edges cannot pass for it.
    const selected = (index: number, { x, y }: Box) =>
      median(row(shots[index], y + 4, x + 2, x + 12).map(({ r, b }) => b - r)) > 80;

    assert.isFalse(selected(71, word));
    assert.isTrue(selected(72, word));

    // The drag released on frame 171 selects the row, scrolled 150 px up by then: its "ow", past
    // the capital R, whose selected glyph is drawn white.
    const across = { ...rowWord.page, x: rowWord.page.x + 12, y: rowWord.page.y - 150 };

    assert.isFalse(selected(170, across));
    assert.isTrue(selected(171, across));

    // What each contact changed, where it is, and the first frame that shows it.
    const texts = changed.filter(({ kind }) => kind === "text");
    const copied = texts.find(({ after }) => after === "✓");

    assert.isTrue(contains(copied?.box, middle(copy)), "the tick where the copy button is");
    assert.strictEqual(
      shots.findIndex(({ at }) => at >= (copied?.at ?? Infinity)),
      87,
      "the tick first shown on the copy's frame",
    );
    assert.isTrue(
      texts.some(
        ({ before, after }) =>
          before === "npm install effect" && after === "Effect.runPromise(main)",
      ),
    );
    // Typing filters the hits: what went is framed by the list it left, which holds what is left;
    // the closed search is drawn nowhere, so it has no box.
    const kept = texts.find(({ after }) => after === "Stream");
    const went = changed.find(({ kind, before }) => kind === "disappeared" && before === "Fiber");

    const closed = changed.find(
      ({ kind, subject }) => kind === "disappeared" && subject.tag === "dialog",
    );

    assert.isTrue(
      kept?.box !== undefined && contains(went?.box, middle(kept.box)),
      "a hit as the search is typed, inside the list a word left",
    );
    assert.isTrue(closed !== undefined && closed.box === undefined, "the closed search");
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Chromium.layer({ viewport: { width: 640, height: 360 }, pageTime: true, requests }),
    ),
    Effect.timeout("60 seconds"),
  ),
);
