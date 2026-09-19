import type { BrowserbaseSession } from "@effect-agent/platform-browserbase/interactive-browser";
import { Effect, Fiber } from "effect";
import { BrowserNavigateRequest, BrowserScrollRequest } from "effect-agent/interactive-browser";

import { recordInterval } from "./record-video.ts";

export interface DemoOptions {
  readonly durationMillis?: number;
  readonly scrollSteps?: number;
  readonly scrollDelta?: number;
}

/**
 * Record one bounded demo interval of a session driving itself.
 *
 * The encoder stays caller-owned in `record-video.ts`; this only supplies the
 * motion, so the recording shows real bounded actions rather than one still
 * frame. Scrolling is the deliberate choice because a frame carries CSS
 * viewport dimensions, which a scroll leaves unchanged; resizing the viewport
 * would segment the interval instead. `test/native/demo.test.ts` is what
 * actually holds that to account over real CDP.
 *
 * This is separate from `hosted-demo.ts` so the same code can run against a
 * local Chromium over real CDP. Proving the pacing and encoding locally means a
 * hosted run is not spent discovering them.
 */
export const recordDemo = (
  session: BrowserbaseSession,
  url: string,
  outputPath: string,
  options: DemoOptions = {},
) =>
  Effect.gen(function* () {
    const durationMillis = options.durationMillis ?? 6_000;
    const scrollSteps = options.scrollSteps ?? 4;
    const scrollDelta = options.scrollDelta ?? 320;

    yield* session.handle.navigate(BrowserNavigateRequest.make({ url }));

    const driver = Effect.gen(function* () {
      let dispatched = 0;

      // Leave two intervals of headroom so the scrolls finish inside the
      // capture window rather than after the encoder has stopped collecting.
      for (let step = 0; step < scrollSteps; step++) {
        yield* Effect.sleep(Math.floor(durationMillis / (scrollSteps + 2)));
        // Re-verify the selected target between actions, the way the
        // model-facing scroll Tool does, rather than reusing a handle taken
        // before the navigation.
        const handle = yield* session.currentHandle;

        yield* handle.scroll(BrowserScrollRequest.make({ deltaX: 0, deltaY: scrollDelta }));
        dispatched++;
      }

      return { dispatched, deltaY: dispatched * scrollDelta };
    });

    const driving = yield* driver.pipe(Effect.forkChild);
    const recording = yield* recordInterval(session, outputPath, durationMillis);
    const scrolled = yield* Fiber.join(driving);
    const observation = yield* session.observe({ maxTextBytes: 8 * 1024, maxControls: 8 });

    return {
      target: observation.url,
      scrolled,
      capture: recording.summary,
      // Distinct pixel checksums are what separate a recorded page from a still
      // image encoded repeatedly; publish the count alongside the video.
      decodedFrames: recording.decodedFrames.length,
      distinctFrames: new Set(recording.decodedFrames.map((frame) => frame.checksum)).size,
    };
  });
