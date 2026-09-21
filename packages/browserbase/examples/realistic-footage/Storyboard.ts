import { Effect, Schema } from "effect";
import type { BrowserbaseSession } from "effect-browserbase/browser";
import { Selector } from "effect-browserbase/browser-data";

import * as Actor from "./Actor.ts";

/**
 * A performance as data. A storyboard can be written by hand, kept in a file
 * or proposed by a model; decoding it is what makes it safe to perform, and
 * its selectors are held to the same bound as the library's own requests.
 */
export const Scene = Schema.TaggedUnion({
  /** Show a lower-third caption; an empty string clears it. A navigation clears it too. */
  Caption: { text: Schema.String.check(Schema.isMaxLength(120)) },
  Pause: { millis: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 30_000 })) },
  /** Rest as long as it takes to skim this many freshly revealed words. */
  Read: { words: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2_000 })) },
  ScrollTo: { selector: Selector },
  MoveTo: { selector: Selector },
  Click: { selector: Selector },
  /** A click that loads another document. */
  Follow: { selector: Selector },
  Type: { selector: Selector, text: Schema.String.check(Schema.isMaxLength(200)) },
});

export type Scene = typeof Scene.Type;

export const Storyboard = Schema.Array(Scene).check(Schema.isMinLength(1), Schema.isMaxLength(200));

export type Storyboard = typeof Storyboard.Type;

export const perform = (session: BrowserbaseSession, storyboard: Storyboard) =>
  Effect.forEach(
    storyboard,
    Scene.match({
      Caption: ({ text }) => Actor.caption(text),
      Pause: ({ millis }) => Effect.sleep(millis),
      Read: ({ words }) => Actor.read(words),
      ScrollTo: ({ selector }) => Actor.scrollTo(selector),
      MoveTo: ({ selector }) => Actor.moveTo(session, selector),
      Click: ({ selector }) => Effect.asVoid(Actor.click(session, selector)),
      Follow: ({ selector }) => Effect.asVoid(Actor.follow(session, selector)),
      Type: ({ selector, text }) => Actor.type(session, selector, text),
    }),
    { discard: true },
  );
