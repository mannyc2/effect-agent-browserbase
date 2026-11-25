/**
 * Reading where things are: `Page.layout`, in one call to the page that takes its turn as other
 * reads do and shares its work with identical ones. The page gives each place's viewport box; the
 * document box is that box moved by the scroll read with it.
 */
import { Effect, Schema } from "effect";

import { NotActionable } from "../../BrowserError.ts";
import { Box, Subject } from "../../BrowserEvent.ts";
import { Point } from "../../Geometry.ts";
import { Layout, type Picks, Place, Word } from "../../Layout.ts";
import { pickRequests } from "../../Matching.ts";
import * as Url from "../../Url.ts";
import { type Bridge, scriptCall } from "../page/bridge.ts";
import { contextGone, decodeWith, failWith, type PageContext, refuse } from "../page/context.ts";

// What `layout` reads back, before its document boxes are added.
const LayoutResult = Schema.Union([
  Schema.Struct({
    layout: Schema.Struct({
      url: Schema.String,
      viewport: Schema.Struct({ width: Schema.Finite, height: Schema.Finite }),
      scroll: Point,
      scale: Schema.Finite,
      missing: Schema.Array(Schema.String),
      places: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          ref: Schema.String,
          subject: Subject,
          box: Box,
          fixed: Schema.Boolean,
          words: Schema.optional(Schema.Array(Schema.Struct({ text: Schema.String, box: Box }))),
        }),
      ),
    }),
  }),
  Schema.Struct({ invalid: Schema.String }),
]);

export const make = (page: PageContext, bridge: Bridge) => {
  const { now, span, owned, within, lane } = page;
  const { evaluate } = bridge;
  const layouts = lane.shared<Layout>("layout", true);

  const layout = (picks: Picks) => {
    const asked = pickRequests(picks);

    // The boxes and the scroll describe the document the call ran in, which is the one current
    // before and after it; a document that replaced it meanwhile is read again, once.
    const once = Effect.gen(function* () {
      const before = bridge.frameTag().document;

      const result = yield* evaluate("layout", scriptCall("layout", asked)).pipe(
        Effect.flatMap(decodeWith("layout", LayoutResult)),
      );

      if ("invalid" in result) return yield* refuse("layout", result.invalid);
      if (bridge.frameTag().document !== before)
        return yield* failWith(
          "layout",
          new NotActionable({ detail: "the page's document changed while it was read" }),
        );
      const { places, scroll, ...read } = result.layout;
      const moved = (box: Box) => ({ ...box, x: box.x + scroll.x, y: box.y + scroll.y });

      return new Layout({
        ...read,
        url: Url.redact(read.url),
        page: page.id,
        connection: page.connection,
        document: before,
        at: now(),
        scroll,
        places: places.map(
          ({ words, ...place }) =>
            new Place({
              ...place,
              page: moved(place.box),
              words: words?.map((word) => new Word({ ...word, page: moved(word.box) })),
            }),
        ),
      });
    });

    return layouts(
      JSON.stringify(asked),
      once.pipe(
        Effect.retry({
          times: 1,
          while: (error) =>
            contextGone(error) ||
            (error.reason._tag === "NotActionable" && error.operation === "layout"),
        }),
        within("layout"),
      ),
    ).pipe(span("Page.layout", { picks: asked.length }), owned);
  };

  return layout;
};
