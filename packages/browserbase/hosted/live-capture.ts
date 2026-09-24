import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// What a delayed or live stream of a hosted browser depends on, measured at real round trips:
// how captured frames are paced while a page scrolls, whether the last picture before the page
// goes still reaches the host, and what a viewport reading of a page under a transparent
// pass-through container returns and costs. Pictures are saved for comparison offline; no address, session id or
// target id is written except in the gate's own allocation record.
import { Clock, Effect, Fiber, Result, Stream } from "effect";
import { NavigateRequest, PointerMoveRequest, WheelRequest } from "effect-browser/browser-data";
import * as Capture from "effect-browser/capture";
import type { BrowserError } from "effect-browser/errors";
import { recipe } from "effect-browserbase/launch";

import { hostedCase } from "./harness.ts";

const h = hostedCase("live-capture");

const millis = (nanos: bigint) => Number(nanos) / 1e6;

const spread = (values: ReadonlyArray<number>) => {
  const sorted = [...values].sort((left, right) => left - right);

  const rank = (quantile: number) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(quantile * sorted.length) - 1))] ??
    null;

  return { count: sorted.length, p50: rank(0.5), p95: rank(0.95), max: sorted.at(-1) ?? null };
};

const scrolling = Effect.scoped(
  Effect.gen(function* () {
    const session = yield* h.open();

    mkdirSync(h.output, { recursive: true });
    yield* session.navigate(
      NavigateRequest.make({ url: "https://en.wikipedia.org/wiki/Web_browser" }),
    );
    yield* session.pointerMove(PointerMoveRequest.make({ to: { x: 640, y: 400 } }));

    const cycles = [];

    for (let cycle = 0; cycle < 3; cycle++) {
      const interval = yield* Capture.start(session, {
        lifetime: "page",
        size: { width: 1280, height: 720 },
        maxFrames: 256,
        maxFrameBytes: 4 * 1024 * 1024,
        maxBufferedBytes: 64 * 1024 * 1024,
        maxDurationMillis: 4000,
        quality: 80,
      });

      const collecting = yield* Stream.runCollect(interval.frames).pipe(Effect.forkScoped);
      let lastInput = 0n;

      for (let wheel = 0; wheel < 3; wheel++) {
        const receipt = yield* session.wheel(WheelRequest.make({ deltaX: 0, deltaY: 500 }));

        lastInput = receipt.completedMonotonicNanos;
        yield* Effect.sleep(120);
      }
      // Still: nothing changes now, so the last picture on the page is settled.
      yield* Effect.sleep(1500);
      const summary = yield* interval.stop;
      const frames = yield* Fiber.join(collecting);
      const received = frames.map((frame) => frame.receivedMonotonicNanos);
      const last = frames.at(-1);
      // A screenshot forces a fresh frame, so it is taken only after the interval stopped.
      const shot = yield* session.screenshot({ fullPage: false });

      if (last !== undefined)
        writeFileSync(join(h.output, `last-${String(cycle)}.jpg`), last.bytes);
      writeFileSync(join(h.output, `shot-${String(cycle)}.png`), shot.bytes);
      cycles.push({
        frames: frames.length,
        framesAfterLastInput: received.filter((at) => at > lastInput).length,
        lastFrameAfterInputMillis:
          last === undefined ? null : millis(last.receivedMonotonicNanos - lastInput),
        interFrameMillis: spread(
          received.slice(1).map((at, index) => millis(at - (received[index] ?? at))),
        ),
        // Frames that arrived within 5 ms of the one before: acknowledgements released a burst.
        burstFrames: received
          .slice(1)
          .filter((at, index) => millis(at - (received[index] ?? at)) < 5).length,
        summary: {
          reason: summary.reason,
          received: summary.received,
          delivered: summary.delivered,
          discarded: summary.discarded,
          late: summary.late,
          overflow: summary.overflow,
          nativeStop: summary.nativeStop,
        },
      });
    }

    return { cycles, cleanup: yield* session.close };
  }).pipe(
    Effect.provide(
      h.browser({ launch: recipe({ viewport: { _tag: "Fixed", width: 1280, height: 720 } }) }),
    ),
  ),
);

const occlusion = Effect.scoped(
  Effect.gen(function* () {
    const session = yield* h.open();

    yield* session.navigate(NavigateRequest.make({ url: "https://www.coingecko.com/" }));
    yield* Effect.sleep(7000);

    // A live page may change its document under a read, which is refused undispatched and
    // said to be safe to repeat; the attempts are reported with the reading.
    const timed = <A>(read: Effect.Effect<A, BrowserError>) =>
      Effect.gen(function* () {
        let attempts = 0;

        for (;;) {
          attempts++;
          const started = yield* Clock.monotonicTimeNanos;
          const result = yield* read.pipe(Effect.result);

          if (Result.isSuccess(result))
            return {
              result: result.success,
              attempts,
              millis: millis((yield* Clock.monotonicTimeNanos) - started),
            };
          const reason = result.failure.reason._tag;

          if (attempts >= 3 || result.failure.outcome !== "undispatched")
            return yield* result.failure;
          if (reason !== "Stale" && reason !== "TargetChanged") return yield* result.failure;
          yield* Effect.sleep(1000);
        }
      });

    const viewport = yield* timed(
      session.observe({ scope: "viewport", maxControls: 32, maxTextBytes: 6000 }),
    );

    const document = yield* timed(
      session.observe({ scope: "document", maxControls: 0, maxTextBytes: 6000 }),
    );

    return {
      viewport: {
        millis: viewport.millis,
        attempts: viewport.attempts,
        textBytes: new TextEncoder().encode(viewport.result.text).length,
        controls: viewport.result.controls.length,
        evidence: viewport.result.viewport,
      },
      document: {
        millis: document.millis,
        attempts: document.attempts,
        textBytes: new TextEncoder().encode(document.result.text).length,
      },
      cleanup: yield* session.close,
    };
  }).pipe(
    Effect.provide(
      h.browser({ launch: recipe({ viewport: { _tag: "Fixed", width: 908, height: 602 } }) }),
    ),
  ),
);

await h.run(
  Effect.gen(function* () {
    const capture = yield* scrolling;

    yield* h.report("capture", capture);
    const reading = yield* occlusion;

    yield* h.report("occlusion", reading);
    yield* h.established({
      "frames arrived in every cycle": capture.cycles.every((cycle) => cycle.frames > 0),
      "every interval stopped cleanly": capture.cycles.every(
        (cycle) => cycle.summary.nativeStop === "confirmed",
      ),
      "the viewport reading returned text": reading.viewport.textBytes > 0,
    });

    return { capture, reading };
  }),
);
