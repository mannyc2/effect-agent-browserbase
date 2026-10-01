import { Effect, Schema } from "effect";
import type { Page } from "effect-browser/browser";
import { InputReceipt } from "effect-browser/browser-data";
import { Step } from "effect-browser/plan-data";

import { Presentation } from "./Presentation.ts";
import { Telemetry } from "./Telemetry.ts";

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
  /** Original bounded browser intent; presentation cues remain application choreography. */
  Browser: { step: Step },
});

export type Scene = typeof Scene.Type;

export const Storyboard = Schema.Array(Scene).check(Schema.isMinLength(1), Schema.isMaxLength(200));

export type Storyboard = typeof Storyboard.Type;

export const perform = Effect.fn("Storyboard.perform")(function* (
  page: Page,
  storyboard: Storyboard,
  seed: number,
) {
  const presentation = yield* Presentation;
  const telemetry = yield* Telemetry;

  for (const scene of storyboard) {
    switch (scene._tag) {
      case "Caption":
        yield* presentation.caption(scene.text);
        break;
      case "Pause":
        yield* Effect.sleep(scene.millis);
        break;
      case "Read":
        yield* Effect.sleep(Math.max(900, (scene.words * 60_000) / 240));
        break;
      case "Browser": {
        const kind =
          scene.step.action._tag.charAt(0).toLowerCase() + scene.step.action._tag.slice(1);

        const ran = yield* telemetry.action(
          kind,
          page.run({ version: 1, steps: [scene.step] }, { style: { seed }, within: "15 seconds" }),
        );

        for (const performed of ran.steps) {
          const receipt = performed.receipt;

          const input = Schema.is(InputReceipt)(receipt)
            ? receipt
            : receipt !== undefined && "input" in receipt
              ? receipt.input
              : undefined;

          if (Schema.is(InputReceipt)(input))
            yield* telemetry.input(input.kind, Effect.succeed(input));
        }
        if (scene.step.action._tag === "Click" || scene.step.action._tag === "Navigate")
          yield* page.ready();
        break;
      }
    }
  }
});
