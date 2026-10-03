import { Effect } from "effect";
import type * as Browser from "effect-browser/browser";

import type { GameSite } from "../fixtures/GameSite.ts";
import type { Driver } from "./Drivers.ts";
import { gamesOperability } from "./Games.ts";
import { gameSegment } from "./GameSegment.ts";
import { BenchError, type Journal } from "./Records.ts";
import { replayDrift } from "./Replay.ts";
import { replayContention } from "./ReplayScenes.ts";
import {
  pictureMetrics,
  stageScene,
  stageScenes,
  type BusyVariant,
  type Stage,
  type Style,
} from "./StageScenes.ts";
import { scenes as understandingScenes, understanding, type Condition } from "./Understanding.ts";

export const scenes = [
  ...stageScenes,
  "games-operability",
  "replay-drift",
  "replay-contention",
  ...understandingScenes,
  "game-segment",
] as const;

export type Scene = (typeof scenes)[number];

export const quantiles = (values: ReadonlyArray<number>) => {
  const sorted = [...values].sort((a, b) => a - b);

  const rank = (p: number) =>
    sorted.length === 0 ? 0 : (sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? 0);

  return { p50: rank(0.5), p95: rank(0.95), max: rank(1) };
};

export const picture = pictureMetrics;

export const execute = Effect.fn("Bench.scene")(function* <OwnerError>(
  journal: Journal,
  browser: Browser.BrowserSession<OwnerError>,
  options: {
    readonly durationMillis: number;
    readonly variant?: BusyVariant;
    readonly style?: Style;
    readonly spins?: number;
    readonly stage?: Stage;
    readonly condition?: Condition;
    readonly driver?: Driver;
    readonly moments?: number;
    readonly pictureScale?: 0.5 | 1;
    readonly site?: GameSite;
    readonly announceThenSpin?: boolean;
    readonly airDelayMillis?: number;
    readonly maxSpins?: number;
  },
) {
  if (journal.manifest.scene === "games-operability")
    return yield* gamesOperability(journal, browser, options);
  if (journal.manifest.scene === "replay-drift") return yield* replayDrift(journal, browser);
  if (journal.manifest.scene === "replay-contention")
    return yield* replayContention(
      journal,
      browser,
      options.stage === undefined ? {} : { stage: options.stage },
    );
  if (journal.manifest.scene === "game-segment") {
    if (options.condition === "text")
      return yield* new BenchError({
        operation: "game-segment",
        message: "Game segments support picture or digest context.",
      });

    return yield* gameSegment(journal, browser, {
      ...options,
      condition: options.condition ?? "picture",
    });
  }
  const narration = understandingScenes.find((scene) => scene === journal.manifest.scene);

  if (narration !== undefined)
    return yield* understanding(journal, browser, { ...options, scene: narration });

  return yield* stageScene(journal, browser, options);
});
