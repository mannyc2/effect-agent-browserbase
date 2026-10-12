// A narrated show: an agent works in a watched browser, its input performed at a person's pace,
// while a host, a second model, opens the video, talks viewers through what the agent does and
// closes with what it found. The host never steers the agent. What the agent reports is checked
// against the site's own record, not taken on its word.
import * as Arms from "bench/Arms.ts";
import type { Trace } from "bench/Recording.ts";
import { Deferred, Duration, Effect, Fiber, Option, type Schema } from "effect";
import type { Page } from "effect-browser/Page";
import * as Presentation from "effect-browser/Presentation";

import * as Narrator from "./narrator.ts";

/** A demo's task, as a take records it. */
export interface Task {
  readonly name: string;
  readonly kind: "operate";
  readonly summary: string;
  readonly start: string;
  readonly prompt: string;
}

export interface ExploreOptions {
  /** How often the host speaks while the agent works. */
  readonly every: Duration.Duration;
  readonly maxSteps: number;
  readonly trace: (entry: Trace) => Effect.Effect<void>;
  /** Wraps each narrator call, such as to switch the model's reasoning off for speed. */
  readonly captionCall: <A, E, R>(call: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
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
  /** What the host is asked for the video's first line. */
  readonly opening: string;
  readonly check: (answer: A) => Effect.Effect<Checked, never, R>;
  /** What the host is asked for the video's last line. */
  readonly closing: (answer: A, checked: Checked) => string;
}

/** The host's brief, for every line it says: a presenter over a screen recording, and the agent's task word for word. */
const brief = (task: Task) =>
  [
    "You are the host of a short screen-recorded demo: an AI agent uses a web browser on its own,",
    "and viewers watch its screen while you talk them through it, the way a presenter talks over a",
    "product demo. You are not the agent: call it the agent, or it, and never say I for what it",
    "does.",
    `It was asked, word for word: "${task.prompt}"`,
  ].join(" ");

/**
 * Words that fit between lines, with a pause after them: the host starts a line `every`, and a
 * voice says about two and a half words a second.
 */
export const wordsFor = (every: Duration.Duration) =>
  Math.max(8, Math.min(20, Math.floor(Duration.toSeconds(every) * 2.2)));

const commentary = (every: Duration.Duration) =>
  [
    "The video is under way; the pictures and events above cover the last few seconds, oldest",
    "first. Say your next line, carrying on from your last one. One or two short sentences, at",
    `most ${wordsFor(every)} words. Do not begin with The agent, and do not begin the way any of`,
    "your recent lines began.",
  ].join(" ");

/** One take on `page`, already at the task's start: the agent works, the host talks, the answer is checked. */
export const perform = <A, I, R>(page: Page, show: Show<A, I, R>, options: ExploreOptions) =>
  Effect.gen(function* () {
    const shown = (yield* Presentation.make()).view(page);

    const host = yield* Narrator.make(shown, {
      brief: brief(show.task),
      trace: options.trace,
      captionCall: options.captionCall,
    });

    // The agent starts once the opening has been said, with a second's pause.
    const opened = yield* host.open(show.opening);

    yield* Effect.sleep(
      Option.match(opened, {
        onNone: () => Duration.zero,
        onSome: (line) => Duration.sum(Narrator.speakingTime(line), Duration.seconds(1)),
      }),
    );
    const stop = yield* Deferred.make<void>();

    const talking = yield* Effect.forkScoped(
      host.commentate(options.every, stop, commentary(options.every)),
    );

    // However the agent ends, the host finishes the line it is writing and starts no other:
    // interrupting a call already sent would leave its charge unknown.
    const result = yield* Arms.operate(5, shown, show.task.prompt, {
      answer: show.answer,
      maxSteps: options.maxSteps,
      onStep: (step) =>
        options.trace({ _tag: "Step", step }).pipe(Effect.andThen(host.hear(step.text))),
    }).pipe(
      Effect.ensuring(Deferred.succeed(stop, undefined).pipe(Effect.andThen(Fiber.await(talking)))),
    );

    const checked = yield* show.check(result.answer);

    yield* host.close(show.closing(result.answer, checked));

    return { pass: checked.pass, detail: checked.detail, ...result };
  });
