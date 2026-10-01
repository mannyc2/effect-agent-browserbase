import { Effect, Schema } from "effect";
import type { AnySession } from "effect-browser/browser";
import { Selector } from "effect-browser/browser-data";
import { Step } from "effect-browser/plan-data";

import * as Actor from "./Actor.ts";

/**
 * A performance as data. A storyboard can be written by hand, kept in a file
 * or proposed by a model; decoding it is what makes it safe to perform. Its
 * browser steps and typed text use the library's own bounds, so a line
 * break that would press Enter is refused here, before anything is filmed.
 */
export const Scene = Schema.TaggedUnion({
  /** Show a lower-third caption; an empty string clears it. A navigation clears it too. */
  Caption: { text: Schema.String.check(Schema.isMaxLength(120)) },
  Pause: { millis: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 30_000 })) },
  /** Rest as long as it takes to skim this many freshly revealed words. */
  Read: { words: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2_000 })) },
  ScrollTo: { selector: Selector },
  MoveTo: { selector: Selector },
  /** Original bounded browser intent; presentation cues remain application choreography. */
  Browser: { step: Step },
});

export type Scene = typeof Scene.Type;

export const Storyboard = Schema.Array(Scene).check(Schema.isMinLength(1), Schema.isMaxLength(200));

export type Storyboard = typeof Storyboard.Type;

export const perform = Effect.fn("Storyboard.perform")(function* (
  session: AnySession,
  storyboard: Storyboard,
) {
  for (const scene of storyboard) {
    switch (scene._tag) {
      case "Caption":
        yield* Actor.caption(scene.text);
        break;
      case "Pause":
        yield* Effect.sleep(scene.millis);
        break;
      case "Read":
        yield* Actor.read(scene.words);
        break;
      case "ScrollTo":
        yield* Actor.scrollTo(scene.selector);
        break;
      case "MoveTo":
        yield* Actor.moveTo(session, scene.selector);
        break;
      case "Browser":
        yield* Actor.perform(session.initialPage, scene.step);
        break;
    }
  }
});
