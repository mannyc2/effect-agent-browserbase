/**
 * A trial whose input is performed for viewers, as `--humanize` asks: its browser's pages are one
 * presenter's views, so the scripted solutions and the agent's tools glide, type and scroll at a
 * person's pace, and a recording shows it.
 */
import { Effect, Layer, Option } from "effect";
import * as Browser from "effect-browser/Browser";
import * as Presentation from "effect-browser/Presentation";

export const layer = <E, R>(browser: Layer.Layer<Browser.Browser, E, R>) =>
  Layer.effect(
    Browser.Browser,
    Effect.gen(function* () {
      const plain = yield* Browser.Browser;
      const { view } = yield* Presentation.make();

      return Browser.Browser.of({
        ...plain,
        pages: Effect.map(plain.pages, (pages) => pages.map(view)),
        page: (id) => Effect.map(plain.page(id), Option.map(view)),
        firstPage: Effect.map(plain.firstPage, view),
        newPage: (url) => Effect.map(plain.newPage(url), view),
      });
    }),
  ).pipe(Layer.provide(browser));
