import { Effect, Exit, Schema } from "effect";
import type { Frame, Page } from "effect-browser/browser";
import { InputReceipt } from "effect-browser/browser-data";
import { BrowserError, BrowserOutcome } from "effect-browser/errors";
import { SnapshotJson, type Stamp } from "effect-browser/timeline-data";
import { Tool, Toolkit } from "effect/ai";

import type { GameSite } from "../fixtures/GameSite.ts";
import { json, tagOf, type Journal } from "./Records.ts";
import type { StepFact } from "./StepDigest.ts";

export const GameKey = Schema.Literals([" ", "ArrowUp", "ArrowDown"]);

class GameKeyFailure extends Schema.TaggedError<GameKeyFailure>()("BenchGameKeyFailure", {
  reason: Schema.String,
  outcome: BrowserOutcome,
}) {}

export const gameKeyboardToolkit = Toolkit.make(
  Tool.make("bench_game_press", {
    description:
      "Send one plain native key to the already focused game canvas: a single space starts a spin, ArrowUp or ArrowDown changes the bet. This keyboard path remains plain even in a performed segment. It shares the episode's one input attempt with browser_click_at. It never focuses or retries. The receipt acknowledges input, not a game result; choose a pause and inspect the next picture.",
    parameters: Schema.Struct({ key: GameKey }),
    success: Schema.Struct({ key: GameKey, dispatched: Schema.Boolean, receipt: Schema.Json }),
    failure: GameKeyFailure,
    failureMode: "return",
  }),
);

export interface GameKeyFact {
  readonly key: typeof GameKey.Type;
  readonly execution: "plain";
  readonly phase: string;
  readonly steps: ReadonlyArray<StepFact>;
  readonly receipt: Schema.Json;
  readonly failure: {
    readonly tag: string;
    readonly reason: string;
    readonly outcome: BrowserOutcome;
    readonly native: Schema.Json;
  } | null;
}

/** The original Page issues this fixture's Frame; plain public input keeps its exact canvas focus guard. */
export const makeGameKeyboard = (
  journal: Journal,
  page: Page,
  site: GameSite,
  deadlineMillis: number,
) => {
  const facts: GameKeyFact[] = [];

  const layer = gameKeyboardToolkit.toLayer({
    bench_game_press: ({ key }) =>
      Effect.scoped(
        Effect.gen(function* () {
          let frame: Frame | undefined;
          let anchor: Stamp | undefined;
          let phase = "prepare-frame";
          let receipt: Schema.Json = null;
          let failure: GameKeyFact["failure"] = null;

          const work = Effect.gen(function* () {
            const frames = yield* page.listFrames();

            const matches = frames.filter((frame) =>
              frame.url.startsWith(`${site.frameOrigin}/frame/reels?`),
            );

            const info = matches.length === 1 ? matches[0] : undefined;

            if (info === undefined)
              return yield* new GameKeyFailure({
                reason: "MissingGameFrame",
                outcome: "undispatched",
              });
            frame = yield* page.frame(info);

            anchor = yield* page.timeline.now;
            const remaining = Math.floor(deadlineMillis - journal.elapsedMillis());

            if (remaining <= 0)
              return yield* new GameKeyFailure({
                reason: "SegmentDeadline",
                outcome: "undispatched",
              });
            phase = "press";

            const input = yield* frame.press(
              { key, into: "#game-canvas" },
              {
                timeoutMillis: Math.min(10000, remaining),
              },
            );

            phase = "acknowledged";
            receipt = json(yield* Schema.encodeEffect(Schema.toCodecJson(InputReceipt))(input));

            return { key, dispatched: true, receipt };
          }).pipe(
            Effect.tapError((error) =>
              Effect.gen(function* () {
                failure = {
                  tag: error._tag,
                  reason:
                    error._tag === "BrowserError"
                      ? error.reason._tag
                      : error._tag === "BenchGameKeyFailure"
                        ? error.reason
                        : error._tag,
                  outcome:
                    error._tag === "BrowserError" || error._tag === "BenchGameKeyFailure"
                      ? error.outcome
                      : phase === "acknowledged"
                        ? "performed"
                        : phase === "press"
                          ? "unknown"
                          : "undispatched",
                  native:
                    error._tag === "BrowserError"
                      ? json(yield* Schema.encodeEffect(Schema.toCodecJson(BrowserError))(error))
                      : null,
                };
              }),
            ),
            Effect.onExit((exit) =>
              Effect.gen(function* () {
                const timeline =
                  frame === undefined
                    ? undefined
                    : yield* page.timeline.snapshot().pipe(Effect.exit);

                const currentAnchor = anchor;

                const nativeTimeline =
                  timeline !== undefined && Exit.isSuccess(timeline) && currentAnchor !== undefined
                    ? yield* Schema.encodeEffect(SnapshotJson)({
                        ...timeline.value,
                        events: timeline.value.events.filter(
                          (event) =>
                            event.clockId === currentAnchor.clockId &&
                            event.at.offsetNanos >= currentAnchor.offsetNanos,
                        ),
                      }).pipe(Effect.exit)
                    : undefined;

                if (Exit.isFailure(exit) && failure === null)
                  failure = {
                    tag: tagOf(exit.cause),
                    reason: tagOf(exit.cause),
                    outcome:
                      phase === "press"
                        ? "unknown"
                        : phase === "acknowledged"
                          ? "performed"
                          : "undispatched",
                    native: null,
                  };

                const fact: GameKeyFact = {
                  key,
                  execution: "plain",
                  phase,
                  steps:
                    phase === "acknowledged"
                      ? [{ action: "Press", targetLabel: null, outcome: "performed" }]
                      : [],
                  receipt,
                  failure,
                };

                facts.push(fact);
                journal.append({
                  kind: "host",
                  turn: null,
                  value: json({
                    gameKey: fact,
                    nativeTimeline:
                      nativeTimeline !== undefined && Exit.isSuccess(nativeTimeline)
                        ? json(nativeTimeline.value)
                        : null,
                    timelineQualification:
                      "original Page timeline since pre-press stamp; Frame targets remain attributed and no Run receipt is fabricated",
                  }),
                });
              }),
            ),
            Effect.mapError((error) =>
              error._tag === "BenchGameKeyFailure"
                ? error
                : new GameKeyFailure({
                    reason: failure?.reason ?? error._tag,
                    outcome: failure?.outcome ?? "unknown",
                  }),
            ),
          );

          return yield* work;
        }),
      ),
  });

  return { layer, facts };
};
