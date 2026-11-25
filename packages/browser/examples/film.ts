/**
 * Film a page on held time with a plain drawing over it. It opens a page, reads its layout, and
 * films three seconds at 30 frames a second: a ring glides to a button, presses it on its frame,
 * and rides with it as the page scrolls on an eased curve. It writes each frame as a numbered PNG;
 * encoding them is the caller's, for instance `ffmpeg -framerate 30 -i %05d.png film.mp4`.
 *
 * bun --conditions=@effect-browser/source packages/browser/examples/film.ts [out directory] [url]
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Data, Effect, Stream } from "effect";
import { Browser } from "effect-browser";
import * as Chromium from "effect-browser/Chromium";
import * as Film from "effect-browser/Film";
import * as Layout from "effect-browser/Layout";

const fps = 30;
const duration = 3000;
const press = 1000;
const scrolled = 200;

const rows = Array.from({ length: 40 }, (_, index) => `<p>Row ${index + 1}</p>`).join("");

/** A page with a button that answers on its own time, and rows below it to scroll through. */
export const demo = `data:text/html,${encodeURIComponent(`<!doctype html><meta charset=utf-8>
<style>body { margin: 0; font: 20px system-ui } main { padding: 120px 80px }
button { font: inherit; padding: 12px 24px }</style>
<main><h1>A page to film</h1><button id=copy>Copy</button>${rows}</main>
<script>copy.onclick = () => { copy.textContent = "Copied"; setTimeout(() => (copy.textContent = "Copy"), 1500) }</script>`)}`;

// From 0 to 1 and back to rest, slow at each end.
const ease = (x: number) => {
  const t = Math.min(1, Math.max(0, x));

  return t * t * (3 - 2 * t);
};

// The page's scroll at film time `t`: still, then 200 px down over the last second and a half.
const scrollAt = (t: number) => Math.round(scrolled * ease((t - 1400) / 1500));

// The ring at film time `t`, in viewport CSS pixels: from the corner to the button's middle, a
// press there, and then with the button as the page moves under it.
const ring = (layout: Layout.Layout, button: Layout.Place, t: number): Film.At => {
  const { width, height } = layout.viewport;

  const to = {
    x: button.page.x + button.page.width / 2,
    y: button.page.y + button.page.height / 2 - scrollAt(t),
  };

  const glide = ease(t / 900);
  const x = width - 60 + (to.x - (width - 60)) * glide;
  const y = height - 60 + (to.y - (height - 60)) * glide;
  const radius = t >= press && t < press + 200 ? 12 : 22;

  return {
    scroll: scrollAt(t),
    overlay: {
      _tag: "Svg",
      markup: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"><circle cx="${x}" cy="${y}" r="${radius}" fill="none" stroke="rgb(230, 60, 30)" stroke-width="5"/></svg>`,
    },
  };
};

export class NotOnPage extends Data.TaggedError("NotOnPage")<{ readonly pick: string }> {}

/** Film `url`, handing each frame to `write`, and say what the film cost. */
export const film = <E>(url: string, write: (shot: Film.Shot) => Effect.Effect<void, E>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* Browser.Browser;
      const page = yield* browser.newPage();

      // Scrollbars go from the next document on, so paint before loading it.
      yield* page.paint({ scrollbars: false });
      yield* page.goto(url);
      yield* page.ready();
      const layout = yield* page.layout({ button: { role: "button", choose: "first" } });
      const button = Layout.place(layout, "button");

      if (button === undefined) return yield* new NotOnPage({ pick: "button" });
      const time = yield* page.hold;
      const overlay = yield* page.overlay;

      return yield* Film.frames(page, {
        times: { fps, to: duration },
        time,
        overlay,
        image: { format: "png" },
        inputs: [{ t: press, action: { _tag: "Click", target: button.ref }, label: "press" }],
        at: (t) => Effect.succeed(ring(layout, button, t)),
      }).pipe(Stream.tap(write), Film.summary);
    }),
  );

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [out = "film-frames", url = demo] = process.argv.slice(2);

  const program = Effect.gen(function* () {
    yield* Effect.promise(() => mkdir(out, { recursive: true }));

    const summary = yield* film(url, (shot) =>
      Effect.promise(() =>
        writeFile(join(out, `${String(shot.index).padStart(5, "0")}.png`), shot.image.data),
      ),
    );

    yield* Effect.log(
      `${summary.frames} frames in ${Math.round(summary.took)} ms, ${summary.sent.length} input`,
    );
  });

  await Effect.runPromise(program.pipe(Effect.provide(Chromium.layer({ pageTime: true }))));
}
