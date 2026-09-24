import { Context, Effect, Layer } from "effect";
import { LanguageModel } from "effect/unstable/ai";

/** What the host knows about one browser step: facts, never the agent's reasoning. */
export interface Step {
  readonly tool: string;
  /** The label of the control acted on, as the page showed it. */
  readonly target?: string;
  /** Where the step went, origin and path only. */
  readonly address?: string;
  readonly succeeded: boolean;
}

/** Two lines of 42 characters, the Netflix limit; it also keeps a caption readable at 20 cps. */
export const MaxCaption = 84;

const tidy = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();

  return flat.length <= MaxCaption
    ? flat
    : `${flat.slice(0, MaxCaption - 1).replace(/\s\S*$/, "")}…`;
};

/**
 * Writes the caption for a step while that step waits in the delay. It is a separate model from
 * the agent: it describes what happened after the fact, spends none of the agent's budget and
 * changes nothing it does. Page text reaches it as a label, so a caption is untrusted text too.
 */
export class Narrator extends Context.Service<
  Narrator,
  { readonly caption: (step: Step) => Effect.Effect<string> }
>()("effect-agent-browser/examples/livestream/Narrator") {
  static readonly layer = Layer.effect(
    Narrator,
    Effect.gen(function* () {
      const model = yield* LanguageModel.LanguageModel;

      return Narrator.of({
        caption: (step) =>
          model
            .generateText({
              prompt: [
                "Write one caption for people watching an AI agent use a web browser.",
                `Plain text, present tense, at most ${String(MaxCaption)} characters.`,
                "Describe only this step:",
                JSON.stringify(step),
              ].join("\n"),
            })
            .pipe(
              Effect.map((response) => tidy(response.text)),
              // No caption is better than a stalled stream; the step airs without one.
              Effect.orElseSucceed(() => ""),
            ),
      });
    }),
  );
}
