/**
 * Film a page on held time with a plain drawing over it, the page answering at every contact. It
 * serves a small site through the browser's request policy, so a hosted browser can film it too,
 * opens it, reads its layout, and films eight seconds at 30 frames a second.
 * A ring hovers a link and its underline eases in. It presses a tab, which squashes as the bar
 * slides under it, and walks along the top of a line of text. It double-clicks a word, which the
 * page selects, and presses the copy button, whose box dips. It opens the search with Ctrl K and
 * types into it a key at a time, then rides an eased scroll, drags across a row to select it, and
 * follows a link to the next page, landing on its heading. After each contact, what changed is
 * framed by its box. Each frame is written as a numbered PNG; encoding them is the caller's, for
 * instance `ffmpeg -framerate 30 -i %05d.png film.mp4`.
 *
 * bun --conditions=@effect-browser/source packages/browser/examples/film.ts [out directory]
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Data, Effect, Stream } from "effect";
import { Browser } from "effect-browser";
import type { RequestPolicy } from "effect-browser/Browser";
import type { Box } from "effect-browser/BrowserEvent";
import type { Change } from "effect-browser/Change";
import * as Chromium from "effect-browser/Chromium";
import * as Film from "effect-browser/Film";
import * as Layout from "effect-browser/Layout";
import type { Pose } from "effect-browser/Pose";

const rows = Array.from({ length: 30 }, (_, index) => `<p>Row ${index + 1}</p>`).join("");

const home = `<!doctype html><meta charset=utf-8><title>A page to film</title><style>
body { margin: 0; font: 18px/1.5 system-ui; color: #222 }
nav { position: sticky; top: 0; display: flex; gap: 32px; padding: 14px 48px; background: #fff }
nav a { color: #333; text-decoration: none; box-shadow: inset 0 -3px transparent;
  transition: color .3s, box-shadow .3s }
nav a:hover { color: #c33; box-shadow: inset 0 -3px #c33 }
main { padding: 0 48px 48px }
.lede { max-width: 520px; font-size: 22px }
.tabs { position: relative; display: flex; width: 240px; border-bottom: 1px solid #ccc }
.tabs button { width: 120px; padding: 8px 0; font: inherit; border: 0; background: none }
#bar { position: absolute; left: 0; bottom: -2px; width: 120px; height: 4px; background: #c33;
  transition: transform .4s }
.command { display: flex; justify-content: space-between; align-items: center; width: 400px;
  margin: 16px 0; padding: 12px 16px; background: #f4f4f4; border: 1px solid #ddd;
  font: 16px ui-monospace, monospace }
.command button { min-width: 32px; font: inherit; border: 0; background: none }
#search { position: fixed; top: 72px; right: 48px; left: auto; width: 260px; margin: 0;
  padding: 12px; border: 1px solid #ccc; background: #fff }
#search input { width: 100%; box-sizing: border-box; font: inherit }
</style>
<nav><a href="/docs">Docs</a><a href="/blog">Blog</a></nav>
<main><h1>A page to film</h1>
<p class=lede>Effect makes concurrency, errors and resources explicit, so a program says what it does.</p>
<div class=tabs><button id=install>Install</button><button id=usage>Usage</button><span id=bar></span></div>
<div class=command><code id=command>npm install effect</code><button id=copy aria-label=Copy>⧉</button></div>
${rows}</main>
<dialog id=search><input id=q aria-label=Search placeholder=Search><ul id=hits></ul></dialog>
<script>
const said = { install: "npm install effect", usage: "Effect.runPromise(main)" };
for (const [id, text] of Object.entries(said))
  document.getElementById(id).onclick = (event) => {
    bar.style.transform = "translateX(" + event.target.offsetLeft + "px)";
    command.textContent = text;
  };
copy.onclick = () => { copy.textContent = "✓"; setTimeout(() => (copy.textContent = "⧉"), 1500) };
const words = ["Effect", "Stream", "Schema", "Scope", "Fiber", "Layer", "Schedule"];
q.oninput = () => hits.replaceChildren(...words
  .filter((word) => word.toLowerCase().includes(q.value.toLowerCase()))
  .map((word) => Object.assign(document.createElement("li"), { textContent: word })));
addEventListener("keydown", (event) => {
  if (event.key === "k" && event.ctrlKey) { event.preventDefault(); search.show(); q.focus(); q.oninput() }
  if (event.key === "Escape") search.close();
});
</script>`;

const docs = `<!doctype html><meta charset=utf-8><title>Docs</title><style>
body { margin: 0; font: 18px/1.5 system-ui } main { padding: 120px 48px }</style>
<main><h1>Docs</h1><p>The page the film arrives on.</p></main>`;

/** Where the site is: no host has it, so only the request policy answers it. */
export const origin = "https://film.test";

/** The site, as the browser's answers to requests for it. */
export const requests: RequestPolicy = {
  patterns: [`${origin}/*`],
  decide: ({ url }) => {
    const { pathname } = new URL(url);
    const body = pathname === "/" ? home : pathname === "/docs" ? docs : undefined;

    return Effect.succeed(
      body === undefined
        ? { _tag: "Fulfilled", status: 404, contentType: "text/plain", body: "" }
        : { _tag: "Fulfilled", status: 200, contentType: "text/html; charset=utf-8", body },
    );
  },
};

const picks = {
  docs: { role: "link", name: "Docs" },
  usage: { role: "button", name: "Usage" },
  lede: { selector: ".lede", words: /\S+/u },
  command: { selector: ".command" },
  copy: { role: "button", name: "Copy" },
  // The first of the rows that show it, which is Row 1.
  row: { text: "Row 1", words: /\S+/u },
} satisfies Layout.Picks;

export class NotOnPage extends Data.TaggedError("NotOnPage")<{ readonly pick: string }> {}

interface Point {
  readonly x: number;
  readonly y: number;
}

// From 0 to 1, slow at each end.
const ease = (x: number) => {
  const t = Math.min(1, Math.max(0, x));

  return t * t * (3 - 2 * t);
};

// 0 outside `from` to `from + length`, rising to 1 halfway and back.
const pulse = (t: number, from: number, length: number) =>
  t < from || t >= from + length ? 0 : Math.sin((Math.PI * (t - from)) / length);

const middle = (box: Box): Point => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

// The top of each line of a place's text, from its words' boxes, in the document: floors.
const lines = (place: Layout.Place) => {
  const found: Array<{ left: number; right: number; top: number }> = [];

  for (const { page } of place.words ?? []) {
    const line = found.find((each) => Math.abs(each.top - page.y) < page.height / 2);

    if (line === undefined) found.push({ left: page.x, right: page.x + page.width, top: page.y });
    else {
      line.left = Math.min(line.left, page.x);
      line.right = Math.max(line.right, page.x + page.width);
      line.top = Math.min(line.top, page.y);
    }
  }

  return found;
};

const radius = 18;
const scrollAt = (t: number) => Math.round(150 * ease((t - 4300) / 1000));

// Where the ring is, given the scroll: a point on the page moves with it, one on the screen not.
type Spot = (scroll: number) => Point;

const onPage =
  ({ x, y }: Point): Spot =>
  (scroll) => ({ x, y: y - scroll });

const onScreen =
  (point: Point): Spot =>
  () =>
    point;

// The ring at `t` on a path of times and spots, eased from each to the next.
const along = (path: ReadonlyArray<readonly [number, Spot]>, t: number, scroll: number) => {
  const next = path.findIndex(([at]) => at > t);
  const last = path.length - 1;

  const [from, spot] = path[next === -1 ? last : Math.max(0, next - 1)] ?? [
    0,
    onScreen({ x: 0, y: 0 }),
  ];

  const [to, then] = (next === -1 ? undefined : path[next]) ?? [from, spot];
  const a = spot(scroll);
  const b = then(scroll);
  const k = to === from ? 1 : ease((t - from) / (to - from));

  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
};

/**
 * Film the site, which the browser must be serving through `requests`, handing each frame to
 * `write`: what it cost, what changed, and the layout it read before filming.
 */
export const film = <E>(write: (shot: Film.Shot) => Effect.Effect<void, E>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* Browser.Browser;
      const page = yield* browser.newPage();

      // Scrollbars go from the next document on, so paint before loading it.
      yield* page.paint({ scrollbars: false });
      yield* page.goto(`${origin}/`);
      yield* page.ready();
      const layout = yield* page.layout(picks);
      const docs = Layout.place(layout, "docs");
      const usage = Layout.place(layout, "usage");
      const lede = Layout.place(layout, "lede");
      const command = Layout.place(layout, "command");
      const copy = Layout.place(layout, "copy");
      const row = Layout.place(layout, "row");

      if (!docs || !usage || !lede || !command || !copy || !row)
        return yield* new NotOnPage({ pick: layout.missing.join(", ") });
      const [line] = lines(lede);
      const [across] = lines(row);
      const word = lede.words?.find(({ text }) => text.startsWith("concurrency"));

      if (line === undefined || word === undefined) return yield* new NotOnPage({ pick: "lede" });
      if (across === undefined) return yield* new NotOnPage({ pick: "row" });
      // The row's text, from just before its first letter to its last, along its middle.
      const y = middle(row.page).y;
      const start = { x: across.left - 2, y };
      const end = { x: across.right, y };
      const { width, height } = layout.viewport;
      const searching = onScreen({ x: width - 48 - 130, y: 100 });

      const path: ReadonlyArray<readonly [number, Spot]> = [
        [0, onScreen({ x: width - 80, y: height - 80 })],
        [600, onScreen(middle(docs.box))],
        [1200, onPage(middle(usage.page))],
        // Onto the line's left end, then along its top: a floor.
        [1600, onPage({ x: line.left + radius, y: line.top - radius })],
        [2300, onPage({ x: middle(word.page).x, y: line.top - radius })],
        [2400, onPage(middle(word.page))],
        [2900, onPage(middle(copy.page))],
        [3200, onPage(middle(copy.page))],
        [3450, searching],
        [4100, searching],
        [4300, onPage(middle(copy.page))],
        [5300, onPage(middle(copy.page))],
        [5400, onPage(start)],
        [5700, onPage(end)],
        [6000, onScreen(middle(docs.box))],
      ];

      const inputs: ReadonlyArray<Film.Contact> = [
        { t: 600, label: "hover", action: { _tag: "Hover", target: docs.ref } },
        { t: 1200, label: "tab", action: { _tag: "Click", target: usage.ref } },
        {
          t: 2400,
          label: "select",
          action: { _tag: "Click", target: middle(word.box), options: { clickCount: 2 } },
        },
        { t: 2900, label: "copy", action: { _tag: "Click", target: copy.ref } },
        { t: 3200, label: "search", action: { _tag: "Press", keys: "Control+k" } },
        ...[..."str"].map((key, index): Film.Contact => ({
          t: 3450 + index * 120,
          label: key,
          action: { _tag: "Type", text: key, options: { replace: false } },
        })),
        { t: 4100, label: "close", action: { _tag: "Press", keys: "Escape" } },
        // Released as the ring reaches the row's end; the scroll has ended, so it is still.
        {
          t: 5700,
          label: "drag",
          action: {
            _tag: "Drag",
            from: onPage(start)(scrollAt(5700)),
            to: onPage(end)(scrollAt(5700)),
          },
        },
        { t: 6000, label: "docs", action: { _tag: "Click", target: docs.ref } },
      ];

      // The tab squashes as it is pressed, and the command box dips as the copy lands on it.
      const posesAt = (t: number, scroll: number): Array<Pose> => {
        const squash = pulse(t, 1200, 250);
        const dip = pulse(t, 2900, 250);
        const tab = { x: middle(usage.page).x, y: usage.page.y + usage.page.height - scroll };
        const top = { x: middle(command.page).x, y: command.page.y - scroll };

        return [
          ...(squash === 0
            ? []
            : [{ ref: usage.ref, sx: 1 + 0.08 * squash, sy: 1 - 0.2 * squash, origin: tab }]),
          ...(dip === 0 ? [] : [{ ref: command.ref, dy: 6 * dip, origin: top }]),
        ];
      };

      // What changed after each contact on this page, read 100 ms of film time after it, and
      // framed for 700 ms from then.
      let since = yield* page.changes();
      const due = new Set(inputs.filter(({ label }) => label !== "docs").map(({ t }) => t + 100));
      const changed: Array<{ readonly from: number; readonly change: Change }> = [];

      const look = (t: number) =>
        Effect.gen(function* () {
          for (const at of due)
            if (t >= at) {
              due.delete(at);
              since = yield* page.changes({ since });
              for (const change of since.changes) changed.push({ from: t, change });
            }
        });

      const rect = ({ x, y, width, height }: Box) =>
        `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="none" stroke="rgb(40, 110, 220)" stroke-width="2" stroke-dasharray="6 4"/>`;

      const svg = (ring: Point, t: number): Film.At["overlay"] => ({
        _tag: "Svg",
        markup: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">${changed
          .flatMap(({ from, change }) =>
            t - from < 700 && change.box !== undefined ? [rect(change.box)] : [],
          )
          .join(
            "",
          )}<circle cx="${ring.x}" cy="${ring.y}" r="${radius}" fill="none" stroke="rgb(230, 60, 30)" stroke-width="5"/></svg>`,
      });

      const time = yield* page.hold;
      const overlay = yield* page.overlay;

      yield* page.poses;

      const summary = yield* Film.frames(page, {
        times: { fps: 30, to: 8000 },
        time,
        overlay,
        image: { format: "png" },
        inputs,
        picks: { title: { role: "heading" } },
        at: (t, { passages }) =>
          Effect.gen(function* () {
            const [arrived] = passages;

            // On the next page, from the link to the top of its heading.
            if (arrived !== undefined) {
              const title = Layout.place(arrived.layout, "title")?.box;
              const link = onScreen(middle(docs.box));

              const landing = title
                ? onScreen({ x: title.x + 2 * radius, y: title.y - radius })
                : link;

              const ring = along(
                [
                  [arrived.t, link],
                  [arrived.t + 800, landing],
                ],
                t,
                0,
              );

              return { poses: [], overlay: svg(ring, t) };
            }
            yield* look(t);
            const scroll = scrollAt(t);

            return { scroll, poses: posesAt(t, scroll), overlay: svg(along(path, t, scroll), t) };
          }),
      }).pipe(Stream.tap(write), Film.summary);

      return { summary, changed: changed.map(({ change }) => change), layout };
    }),
  );

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [out = "film-frames"] = process.argv.slice(2);

  const program = Effect.gen(function* () {
    yield* Effect.promise(() => mkdir(out, { recursive: true }));

    const { summary, changed } = yield* film((shot) =>
      Effect.promise(() =>
        writeFile(join(out, `${String(shot.index).padStart(5, "0")}.png`), shot.image.data),
      ),
    );

    yield* Effect.log(
      `${summary.frames} frames in ${Math.round(summary.took)} ms, ${summary.sent.length} inputs, ${changed.length} changes, ${summary.passages.length} passage`,
    );
  });

  await Effect.runPromise(
    program.pipe(Effect.provide(Chromium.layer({ pageTime: true, requests }))),
  );
}
