// Records one trial into a directory for replay: each page's screencast frames as JPEG files as
// they arrive, and at the end one recording.json with the events, turns, moments and outcome.
// Recording starts a screencast on every page, which adds capture load to an operate trial.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Clock, Effect, Schema, Stream, type Tracer } from "effect";
import { Browser } from "effect-browser/Browser";
import type { RecordedEvent } from "effect-browser/BrowserEvent";

import { BenchError } from "./Budget.ts";
import {
  plain,
  RecordedFrame,
  RecordedMoment,
  RecordedSpan,
  RecordedStep,
  RecordedViewport,
  Recording,
  type Trace,
} from "./Recording.ts";
import { timed } from "./Trace.ts";

/** How long a recording continues after the trial, so it ends on the page's settled paint. */
export const tailMillis = 500;

export interface Recorder {
  /** Give to the task, which reports its turns and moments here. */
  readonly trace: (entry: Trace) => Effect.Effect<void>;
  /** Record the trial's browser while `work` runs. */
  readonly around: <A, E, R>(work: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R | Browser>;
  /** Write recording.json, with the trial's spans when traced; a trial that never ran writes none. */
  readonly finish: (
    details: Pick<Recording, "task" | "run" | "outcome"> & {
      readonly spans?: ReadonlyArray<Tracer.Span> | undefined;
    },
  ) => Effect.Effect<void, BenchError>;
}

const write = <A>(operation: () => A) =>
  Effect.try({
    try: operation,
    catch: (error) =>
      new BenchError({
        message: `could not write the recording: ${error instanceof Error ? error.message : String(error)}`,
      }),
  });

export const make = (directory: string): Recorder => {
  let now: Effect.Effect<number> | undefined;
  let startedAt: number | undefined;
  // The epoch clock spans use, read with the host clock, to move spans onto the host clock.
  let epoch = 0n;
  let endedAt = Number.NaN;
  const events: Array<RecordedEvent> = [];
  const frames: Array<RecordedFrame> = [];
  const steps: Array<RecordedStep> = [];
  const moments: Array<RecordedMoment> = [];
  // A recording that lost frames or events says so instead of looking complete.
  const problems: Array<string> = [];
  const viewports: Array<RecordedViewport> = [];

  const trace = (entry: Trace) =>
    Effect.gen(function* () {
      if (entry._tag === "Moment") {
        const index = moments.length;

        const pictures = yield* write(() => {
          mkdirSync(join(directory, "moments"), { recursive: true });

          return entry.moment.frames.map((frame, order) => {
            const file = `moments/${index}-${order}.jpg`;

            writeFileSync(join(directory, file), frame.data);

            return { file, hostTime: frame.hostTime };
          });
        }).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              problems.push(error.message);

              return [];
            }),
          ),
        );

        moments.push(
          new RecordedMoment({
            at: entry.moment.at,
            from: entry.moment.from,
            frames: pictures,
            question: entry.question,
            ...(entry.expected === undefined ? {} : { expected: plain(entry.expected) }),
            ...(entry.caption === undefined ? {} : { caption: entry.caption }),
            readyAt: now === undefined ? Number.NaN : yield* now,
          }),
        );

        return;
      }

      const { step } = entry;

      steps.push(
        new RecordedStep({
          at: now === undefined ? Number.NaN : yield* now,
          step: step.step,
          text: step.text,
          calls: step.calls.map((call) => ({ name: call.name, params: plain(call.params) })),
          results: step.results.map((result) => ({
            name: result.name,
            result: plain(result.result),
            isFailure: result.isFailure,
          })),
          inputTokens: step.usage.inputTokens,
          outputTokens: step.usage.outputTokens,
          ...(step.rejected === undefined ? {} : { rejected: step.rejected }),
        }),
      );
    });

  const around = <A, E, R>(work: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const browser = yield* Browser;
      let pageCount = 0;

      // A failure to write here loses frames, not the trial; finish reports it.
      yield* write(() => mkdirSync(join(directory, "frames"), { recursive: true })).pipe(
        Effect.catch((error) => Effect.sync(() => problems.push(error.message))),
      );
      now = browser.now;
      epoch = yield* Clock.currentTimeNanos;
      startedAt = yield* browser.now;

      // Each page's frames, from the moment its opening event is read until it closes.
      const follow = (id: string) =>
        Effect.gen(function* () {
          const page = (yield* browser.pages).find((candidate) => candidate.id === id);

          if (page === undefined) return;
          const index = pageCount++;
          let count = 0;

          // Pointer events use CSS pixels; frames can have more device pixels than that.
          yield* page.viewport.pipe(
            Effect.map((size) => viewports.push(new RecordedViewport({ page: id, ...size }))),
            Effect.catch((error) =>
              Effect.sync(() => problems.push(`no viewport for ${id}: ${error.reason._tag}`)),
            ),
          );

          yield* page.screencast().pipe(
            Stream.runForEach((frame) =>
              write(() => {
                const file = `frames/${index}-${String(++count).padStart(6, "0")}.jpg`;

                writeFileSync(join(directory, file), frame.data);
                frames.push(
                  new RecordedFrame({
                    page: id,
                    file,
                    hostTime: frame.hostTime,
                    width: frame.width,
                    height: frame.height,
                  }),
                );
              }),
            ),
            Effect.catchTag("BenchError", (error) =>
              Effect.sync(() => problems.push(error.message)),
            ),
            // The screencast ends with an error when its page closes.
            Effect.ignore,
          );
        });

      yield* browser.events({ after: 0 }).pipe(
        Stream.runForEach((record) =>
          Effect.gen(function* () {
            events.push(record);
            if (record.event._tag === "PageOpened")
              yield* Effect.forkScoped(follow(record.event.page));
          }),
        ),
        Effect.catch((error) =>
          Effect.sync(() => problems.push(`events stopped: ${error.reason._tag}`)),
        ),
        Effect.forkScoped,
      );

      return yield* work.pipe(
        Effect.tap(() => Effect.sleep(tailMillis)),
        Effect.ensuring(
          browser.now.pipe(
            Effect.map((at) => {
              endedAt = at;
            }),
          ),
        ),
      );
    }).pipe(Effect.scoped);

  const finish = ({
    spans,
    ...details
  }: Pick<Recording, "task" | "run" | "outcome"> & {
    readonly spans?: ReadonlyArray<Tracer.Span> | undefined;
  }) =>
    startedAt === undefined
      ? Effect.void
      : Effect.gen(function* () {
          const recording = new Recording({
            version: 1,
            ...details,
            ...(spans === undefined
              ? {}
              : {
                  spans: timed(spans, { epoch, host: startedAt ?? Number.NaN }).map(
                    (span) => new RecordedSpan({ ...span, attributes: { ...span.attributes } }),
                  ),
                }),
            startedAt: startedAt ?? Number.NaN,
            endedAt,
            events,
            frames: frames.toSorted((left, right) => left.hostTime - right.hostTime),
            steps,
            moments,
            viewports,
            problems,
          });

          const json = yield* Schema.encodeEffect(Recording)(recording).pipe(
            Effect.mapError(
              (error) =>
                new BenchError({ message: `could not encode the recording: ${error.message}` }),
            ),
          );

          yield* write(() =>
            writeFileSync(join(directory, "recording.json"), `${JSON.stringify(json)}\n`),
          );
        });

  return { trace, around, finish };
};
