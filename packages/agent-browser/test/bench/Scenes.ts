import { Effect } from "effect";
import type * as Browser from "effect-browser/browser";

import { stageSite } from "../fixtures/StageSite.ts";
import { filming } from "./Backends.ts";
import { BenchError, type Journal, json } from "./Records.ts";

export const scenes = ["smoke"] as const;
export type Scene = (typeof scenes)[number];

export const quantiles = (values: ReadonlyArray<number>) => {
  const sorted = [...values].sort((a, b) => a - b);

  const rank = (p: number) =>
    sorted.length === 0 ? 0 : (sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? 0);

  return { p50: rank(0.5), p95: rank(0.95), max: rank(1) };
};

export const picture = (journal: Journal) => {
  const recording = journal.recording;
  const frames = recording?.frames ?? [];

  const gaps = frames
    .slice(1)
    .map(
      (frame, index) =>
        Number(
          BigInt(frame.receivedMonotonicNanos) -
            BigInt(frames[index]?.receivedMonotonicNanos ?? frame.receivedMonotonicNanos),
        ) / 1e6,
    );

  const durationMillis = recording === undefined ? 0 : recording.endedAt - recording.startedAt;

  return {
    frames: frames.length,
    durationMillis,
    fps: durationMillis > 0 ? (frames.length * 1000) / durationMillis : 0,
    gapMillis: quantiles(gaps),
    delivered: frames.length,
    discarded: recording?.discardedFrames ?? 0,
  };
};

export const execute = Effect.fn("Bench.scene")(function* <OwnerError>(
  journal: Journal,
  browser: Browser.BrowserSession<OwnerError>,
  options: { readonly durationMillis: number; readonly fixtureOrigin?: string },
) {
  if (journal.manifest.scene !== "smoke")
    return yield* new BenchError({ operation: "scene", message: "Unknown bench scene." });
  const site = yield* stageSite;
  const page = browser.initialPage;

  yield* page.navigate({ url: `${options.fixtureOrigin ?? site.url}/smoke` });
  yield* filming(journal, page, Effect.sleep(options.durationMillis));
  journal.truth = json({ events: site.events(), lost: site.lost() });
  journal.metrics = json(picture(journal));
});
