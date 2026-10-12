// A watched show: an agent works in a watched browser, its input performed at a person's pace,
// and what it writes beside its tool calls is what viewers hear. It speaks for itself, in the
// first person, from the moments of the page its thread holds: what each action did, in pictures
// and words. What the agent reports is checked against the site's own record, not taken on its
// word.
import * as Arms from "bench/Arms.ts";
import type { Trace } from "bench/Recording.ts";
import { Effect, type Schema } from "effect";
import type { Page } from "effect-browser/Page";
import * as Presentation from "effect-browser/Presentation";

/** A demo's task, as a take records it. */
export interface Task {
  readonly name: string;
  readonly kind: "operate";
  readonly summary: string;
  readonly start: string;
  readonly prompt: string;
}

export interface ExploreOptions {
  readonly maxSteps: number;
  readonly trace: (entry: Trace) => Effect.Effect<void>;
}

/** How a reported answer compared with the site's own record. */
export interface Checked {
  readonly pass: boolean;
  readonly matched: number;
  readonly detail: string;
}

export interface Show<A, I, R> {
  readonly task: Task;
  readonly answer: Schema.Codec<A, I>;
  readonly check: (answer: A) => Effect.Effect<Checked, never, R>;
}

/** Who the agent is to its viewers: what it writes beside its tool calls is spoken over the video. */
export const persona = [
  "- People watch your screen, and what you write beside your tool calls is read aloud to them.",
  "Talk to them in the first person, one short sentence a turn, two at most: what you notice and",
  "what you'll do next. In your first turn, say briefly what you're setting out to do; beside done,",
  "say how it went. Give amounts and names as the screen shows them, and don't say how something",
  "turned out before you've seen it.",
].join(" ");

/** One take on `page`, already at the task's start: the agent works and talks, the answer is checked. */
export const perform = <A, I, R>(page: Page, show: Show<A, I, R>, options: ExploreOptions) =>
  Effect.gen(function* () {
    const shown = (yield* Presentation.make()).view(page);
    let turn = 0;

    const result = yield* Arms.operate(6, shown, show.task.prompt, {
      answer: show.answer,
      maxSteps: options.maxSteps,
      persona,
      onStep: (step) => options.trace({ _tag: "Step", step }),
      onMoment: (moment) =>
        options.trace({
          _tag: "Moment",
          moment,
          question: `What the agent was shown before turn ${(turn += 1)}`,
        }),
    });

    const checked = yield* show.check(result.answer);

    return { pass: checked.pass, detail: checked.detail, ...result };
  });
