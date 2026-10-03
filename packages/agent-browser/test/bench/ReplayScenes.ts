import { Effect, Exit } from "effect";
import type * as Browser from "effect-browser/browser";

import { filming } from "./Backends.ts";
import * as Picture from "./Picture.ts";
import { BenchError, type Journal, json } from "./Records.ts";
import { matrix, type ReplayCell, type ReplayOptions } from "./Replay.ts";
import { prepareStage, type Stage } from "./StageScenes.ts";

export interface ContentionOptions extends ReplayOptions {
  readonly stage?: Stage;
  readonly beforeAfterMillis?: number;
  readonly baseline?: ReadonlyArray<ReplayCell>;
}

/** The exact on-air Page stays captured while each replay receives its own fresh Page. */
export const replayContention = Effect.fn("Bench.replayContention")(function* <OwnerError>(
  journal: Journal,
  browser: Browser.BrowserSession<OwnerError>,
  options: ContentionOptions = {},
) {
  const beforeAfterMillis = options.beforeAfterMillis ?? 5000;

  if (
    !Number.isSafeInteger(beforeAfterMillis) ||
    beforeAfterMillis < 100 ||
    beforeAfterMillis > 10000
  )
    return yield* new BenchError({
      operation: "replay",
      message: "Contention sampling window exceeds its bound.",
    });
  if (journal.manifest.backend !== "chromium")
    return yield* new BenchError({
      operation: "replay",
      message: "Replay drift currently needs the local controlled fixture.",
    });
  const stage = options.stage ?? (yield* prepareStage(journal));
  const page = browser.initialPage;

  const stamp = Effect.gen(function* () {
    const monotonicNanos = String(yield* browser.monotonicTimeNanos);

    return { monotonicNanos, millis: journal.elapsedMillis() };
  });

  yield* page.navigate({ url: stage.url("/animation") });

  const sampled = yield* filming(
    journal,
    page,
    Effect.gen(function* () {
      const beforeStart = yield* stamp;

      yield* Effect.sleep(beforeAfterMillis);
      const replayStart = yield* stamp;
      const result = yield* matrix(browser, options).pipe(Effect.exit);
      const replayEnd = yield* stamp;

      yield* Effect.sleep(beforeAfterMillis);
      const afterEnd = yield* stamp;

      return { result, beforeStart, replayStart, replayEnd, afterEnd };
    }),
  );

  const intervals = [
    { phase: "before", start: sampled.beforeStart, end: sampled.replayStart },
    { phase: "during", start: sampled.replayStart, end: sampled.replayEnd },
    { phase: "after", start: sampled.replayEnd, end: sampled.afterEnd },
  ];

  const frames = journal.recording?.frames ?? [];

  const retentionStopped =
    journal.recording?.limitReached !== null || journal.recording?.error !== null;

  const measuredEnd = retentionStopped
    ? (frames.at(-1)?.receivedAt ?? journal.recording?.startedAt ?? 0)
    : (journal.recording?.endedAt ?? 0);

  const picture = intervals.map(({ phase, start, end }) => {
    const window = { start: start.millis, end: Math.min(end.millis, measuredEnd) };
    const measured = window.end > window.start;

    return {
      phase,
      alignment: {
        startMonotonicNanos: start.monotonicNanos,
        endMonotonicNanos: end.monotonicNanos,
      },
      measurement: !measured ? "unmeasured" : window.end < end.millis ? "partial" : "complete",
      cadence: measured ? Picture.cadence(frames, window) : null,
      freezes: measured ? Picture.freezes(frames, [window], window) : null,
      viewerHeldAfterRetentionMillis: retentionStopped
        ? Math.max(0, end.millis - Math.max(start.millis, measuredEnd))
        : 0,
      expectedChangingBasis:
        "continuous controlled stage animation; host ticks and visibility retained in truth",
    };
  });

  const replay = Exit.isSuccess(sampled.result) ? sampled.result.value : null;

  const lostSteps =
    replay?.cells.reduce((sum, cell) => sum + cell.total - cell.completed, 0) ?? null;

  const baseline = options.baseline;

  const matchingBaseline =
    replay === null || baseline === undefined
      ? []
      : baseline.filter((cell) =>
          replay.cells.some(
            (other) =>
              cell.walk === other.walk &&
              cell.path === other.path &&
              cell.operator === other.operator &&
              cell.seed === other.seed,
          ),
        );

  const baselineLostSteps =
    replay !== null && matchingBaseline.length === replay.cells.length
      ? matchingBaseline.reduce((sum, cell) => sum + cell.total - cell.completed, 0)
      : null;

  journal.truth = json({
    replay:
      replay === null
        ? null
        : { cells: replay.cells, events: replay.truthEvents, lost: replay.lostTruthEvents },
    stage: { events: stage.events(), lost: stage.lost() },
  });
  journal.metrics = json({
    replay:
      replay === null
        ? null
        : {
            groups: replay.groups,
            recording: replay.recording,
            lostSteps,
            baselineLostSteps,
            additionalLostSteps:
              baselineLostSteps === null || lostSteps === null
                ? null
                : lostSteps - baselineLostSteps,
          },
    picture,
    retention: {
      frames: frames.length,
      bytes: journal.recording?.totalBytes ?? 0,
      limitReached: journal.recording?.limitReached ?? null,
      discarded: journal.recording?.discardedFrames ?? 0,
      nativeStop: journal.recording?.nativeStop ?? "missing",
      error: journal.recording?.error ?? null,
    },
  });

  if (Exit.isFailure(sampled.result)) return yield* Effect.failCause(sampled.result.cause);

  return sampled.result.value;
});
