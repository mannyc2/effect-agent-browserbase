/**
 * The page's overlay: one lease at a time, each drawing one call to the page, in turn after the
 * actions asked before it, never two at once. Each new document gets what was last drawn once it
 * has loaded; the lease's scope takes the layer away.
 */
import { Duration, Effect, Schedule, Schema, type Scope, Semaphore } from "effect";

import type { BrowserError } from "../../BrowserError.ts";
import { Box } from "../../BrowserEvent.ts";
import type { Content, Overlay } from "../../Overlay.ts";
import { type Bridge, scriptCall } from "./bridge.ts";
import { decodeWith, type PageContext, refuse } from "./context.ts";

const Drawn = Schema.Array(Box);

export const make = (page: PageContext, bridge: Bridge) => {
  const { lane, owned, span, within } = page;
  const turns = Semaphore.makeUnsafe(1);
  let open = false;
  // What the layer shows, as markup, and where its parts were last drawn.
  let shown: string | null = null;
  let drawn: ReadonlyArray<Box> = [];

  const send = (markup: string | null) =>
    turns.withPermit(
      lane.read("overlay")(
        bridge.evaluate("overlay", scriptCall("overlay", markup)).pipe(
          Effect.flatMap(decodeWith("overlay", Drawn)),
          Effect.tap((boxes) =>
            Effect.sync(() => {
              shown = markup;
              drawn = boxes;
              page.noteInput();
            }),
          ),
          within("overlay"),
        ),
      ),
    );

  const draw = (content: Content) =>
    send(content._tag === "Svg" ? content.markup : null).pipe(span("Overlay.draw"), owned);

  // Once the document after `document` has parsed, it is drawn with what was shown. A redraw that
  // fails leaves the layer off until the next draw, which reports its own failure.
  const redraw = (document: number) =>
    bridge.waitForDocument(document).pipe(
      Effect.andThen(
        Effect.void.pipe(
          Effect.repeat({
            schedule: Schedule.spaced(Duration.millis(50)),
            until: () => bridge.loaded() !== undefined,
          }),
          within("overlay", page.settings.navigationTimeout),
        ),
      ),
      Effect.andThen(Effect.suspend(() => (shown === null ? Effect.void : send(shown)))),
      Effect.ignore,
    );

  const lease: Effect.Effect<Overlay, BrowserError, Scope.Scope> = Effect.gen(function* () {
    if (open) return yield* refuse("overlay", "the page has an overlay already");
    open = true;
    yield* Effect.addFinalizer(() =>
      Effect.suspend(() => {
        open = false;

        return shown === null ? Effect.void : send(null).pipe(Effect.ignore);
      }),
    );
    yield* Effect.forkScoped(
      Effect.suspend(() => redraw(bridge.frameTag().document)).pipe(Effect.forever),
    );

    return { draw };
  });

  return { lease, drawn: () => (shown === null ? undefined : drawn) };
};
