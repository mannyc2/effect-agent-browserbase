/**
 * Holding a page's time: one hold at a time, each step one call to the page that takes the page
 * to itself, as an action does, so no read sees a step half made. See `PageTime`.
 */
import { Duration, Effect, Option, Schema, type Scope } from "effect";

import { type BrowserError, NotActionable } from "../../BrowserError.ts";
import { Box } from "../../BrowserEvent.ts";
import { Point } from "../../Geometry.ts";
import type { Held, Step } from "../../PageTime.ts";
import { type Bridge, scriptCall } from "./bridge.ts";
import { decodeWith, failWith, type PageContext, refuse } from "./context.ts";
import type { Overlays } from "./overlay.ts";
import type { StepRequest } from "./time.inpage.ts";

const Stepped = Schema.Struct({
  told: Schema.Boolean,
  drawn: Schema.NullOr(Schema.Array(Box)),
  scroll: Point,
});

export const make = (page: PageContext, bridge: Bridge, overlays: Overlays) => {
  const { lane, owned, span, within } = page;
  let holding = false;

  // One step, the page to itself, the overlay's turn too when it draws.
  const step = (operation: string, request: StepRequest) => {
    const sent = lane
      .write(
        operation,
        page.settings.actionTimeout,
      )(
        bridge.evaluate(operation, scriptCall("step", request)).pipe(
          Effect.flatMap(decodeWith(operation, Stepped)),
          Effect.tap(({ drawn }) =>
            Effect.sync(() => {
              if (drawn !== null && request.markup !== undefined)
                overlays.record(request.markup, drawn);
              page.noteInput();
            }),
          ),
          within(operation),
        ),
      )
      .pipe(span(`PageTime.${operation}`), owned);

    return request.markup === undefined ? sent : overlays.turn(sent);
  };

  const unclocked = (operation: string) =>
    failWith(operation, new NotActionable({ detail: "the page's document has no page clock" }));

  const hold: Effect.Effect<Held, BrowserError, Scope.Scope> = Effect.gen(function* () {
    const clock = page.settings.pageTime;

    if (clock === undefined)
      return yield* refuse("hold", "holding page time needs the browser's pageTime option");
    if (holding) return yield* refuse("hold", "the page's time is held already");
    holding = true;
    let ended = false;

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => (ended = true)).pipe(
        Effect.andThen(step("release", { clock, op: "release", by: 0, scroll: null })),
        Effect.ignore,
        Effect.ensuring(Effect.sync(() => (holding = false))),
      ),
    );
    const held = yield* step("hold", { clock, op: "hold", by: 0, scroll: null });

    if (!held.told) return yield* unclocked("hold");
    let elapsed = 0;

    const advance = (by: Duration.Input, options: Step = {}) =>
      Effect.gen(function* () {
        const millis = Option.map(Duration.fromInput(by), Duration.toMillis).pipe(
          Option.getOrElse(() => Number.NaN),
        );

        if (ended) return yield* refuse("advance", "the hold has ended");
        if (!Number.isFinite(millis) || millis < 0)
          return yield* refuse("advance", "page time moves on by a finite, nonnegative duration");
        if (options.scroll !== undefined && !Number.isFinite(options.scroll))
          return yield* refuse("advance", "the scroll must be finite");
        if (options.overlay !== undefined && !overlays.open())
          return yield* refuse("advance", "drawing needs the page's overlay open");

        const stepped = yield* step("advance", {
          clock,
          op: "advance",
          by: millis,
          scroll: options.scroll ?? null,
          markup:
            options.overlay === undefined
              ? undefined
              : options.overlay._tag === "Svg"
                ? options.overlay.markup
                : null,
        });

        if (!stepped.told) return yield* unclocked("advance");
        elapsed += millis;

        return stepped.scroll;
      });

    return { advance, elapsed: Effect.sync(() => Duration.millis(elapsed)) };
  });

  return { hold };
};
