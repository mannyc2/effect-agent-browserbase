// A long session at real round trips: an action allowance above the former 1,000 cap is spent
// to its maximum while one live capture interval runs throughout, then the next action is
// refused. It reports what status said along the way, how fast actions went and what capture
// delivered. No address, session id or target id is written except in the gate's own
// allocation record.
import { Clock, Effect, Fiber, Result, Stream } from "effect";
import {
  NavigateRequest,
  PointerMoveRequest,
  ReadTextRequest,
  WheelRequest,
} from "effect-browser/browser-data";
import * as Capture from "effect-browser/capture";
import type { BrowserError } from "effect-browser/errors";
import { recipe } from "effect-browserbase/launch";

import { hostedCase } from "./harness.ts";

const h = hostedCase("long-session");

const pages = [
  "https://en.wikipedia.org/wiki/Web_browser",
  "https://en.wikipedia.org/wiki/Web_page",
] as const;

// A navigation this often shows the interval following its page across documents.
const navigateEvery = 250;
// Status is read this often, beside the host's own count of attempts.
const sampleEvery = 100;

const millis = (nanos: bigint) => Number(nanos) / 1e6;

const spread = (values: ReadonlyArray<number>) => {
  const sorted = [...values].sort((left, right) => left - right);

  const rank = (quantile: number) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(quantile * sorted.length) - 1))] ??
    null;

  return { count: sorted.length, p50: rank(0.5), p95: rank(0.95), max: sorted.at(-1) ?? null };
};

const soak = Effect.scoped(
  Effect.gen(function* () {
    const session = yield* h.open();
    const started = yield* Clock.monotonicTimeNanos;
    let attempts = 0;
    let document = 0;

    const latencies: Record<string, Array<number>> = {};

    const failures: Array<{ attempt: number; operation: string; reason: string; outcome: string }> =
      [];

    const samples: Array<{ attempts: number; used: number; elapsedMillis: number }> = [];

    // Every step is one charged operation; a refusal for the spent allowance ends the loop.
    const step = (
      operation: string,
      effect: Effect.Effect<unknown, BrowserError>,
    ): Effect.Effect<BrowserError | undefined> =>
      Effect.gen(function* () {
        const before = yield* Clock.monotonicTimeNanos;
        const result = yield* Effect.result(effect);
        const after = yield* Clock.monotonicTimeNanos;

        if (Result.isSuccess(result)) {
          attempts++;
          (latencies[operation] ??= []).push(millis(after - before));

          return undefined;
        }
        const error = result.failure;

        if (error.reason._tag === "Limit" && error.reason.dimension === "actions") return error;
        attempts++;
        failures.push({
          attempt: attempts,
          operation,
          reason: error.reason._tag,
          outcome: error.outcome,
        });

        return undefined;
      });

    yield* step("navigate", session.navigate(NavigateRequest.make({ url: pages[0] })));

    const interval = yield* Capture.start(session, {
      lifetime: "page",
      size: { width: 1280, height: 720 },
      maxFrames: 64,
      maxFrameBytes: 4 * 1024 * 1024,
      maxBufferedBytes: 64 * 1024 * 1024,
      maxDurationMillis: h.budget.captureSeconds * 1000,
      quality: 60,
    });

    // A viewer that keeps up: it keeps only receipt times, never the pictures.
    const received: Array<bigint> = [];

    const viewer = yield* interval.frames.pipe(
      Stream.runForEach((frame) => Effect.sync(() => received.push(frame.receivedMonotonicNanos))),
      Effect.forkScoped,
    );

    yield* step(
      "pointer-move",
      session.pointerMove(PointerMoveRequest.make({ to: { x: 640, y: 400 } })),
    );

    let refused: BrowserError | undefined;

    for (let index = 0; refused === undefined; index++) {
      if (index > 0 && index % navigateEvery === 0) {
        document++;
        refused = yield* step(
          "navigate",
          session.navigate(
            NavigateRequest.make({ url: pages[document % pages.length] ?? pages[0] }),
          ),
        );
      } else {
        const phase = index % 10;

        refused =
          phase < 4
            ? yield* step("wheel", session.wheel(WheelRequest.make({ deltaX: 0, deltaY: 400 })))
            : phase < 8
              ? yield* step("wheel", session.wheel(WheelRequest.make({ deltaX: 0, deltaY: -400 })))
              : phase === 8
                ? yield* step(
                    "observe",
                    session.observe({ scope: "viewport", maxControls: 16, maxTextBytes: 2000 }),
                  )
                : yield* step(
                    "read-text",
                    session.readText(ReadTextRequest.make({ selector: "#firstHeading" })),
                  );
      }
      if (attempts % sampleEvery === 0 && refused === undefined) {
        const status = yield* session.status;

        samples.push({
          attempts,
          used: status.actions.used,
          elapsedMillis: millis((yield* Clock.monotonicTimeNanos) - started),
        });
      }
    }
    const spent = yield* Clock.monotonicTimeNanos;
    const status = yield* session.status;
    // Host reads have their own allowance, so a checkpoint still runs once actions are spent.
    const checkpoint = yield* session.checkpoint({ picture: false }).pipe(Effect.result);
    const summary = yield* interval.stop;

    yield* Fiber.join(viewer);

    // Frames per quarter of the time actions were spent: capture ran through all of it.
    const span = spent - started;

    const quarters = [0, 1, 2, 3].map(
      (quarter) =>
        received.filter(
          (at) =>
            at >= started + (span * BigInt(quarter)) / 4n &&
            at < started + (span * BigInt(quarter + 1)) / 4n,
        ).length,
    );

    const gaps = received.slice(1).map((at, index) => millis(at - (received[index] ?? at)));

    return {
      attempts,
      failures,
      samples,
      refused: { reason: refused.reason, outcome: refused.outcome },
      status: { phase: status.phase, reason: status.reason, actions: status.actions },
      checkpoint: Result.isSuccess(checkpoint)
        ? { ok: true as const }
        : { ok: false as const, reason: checkpoint.failure.reason._tag },
      elapsedMillis: millis(spent - started),
      latencyMillis: Object.fromEntries(
        Object.entries(latencies).map(([operation, values]) => [operation, spread(values)]),
      ),
      capture: {
        frames: received.length,
        framesPerQuarter: quarters,
        interFrameMillis: spread(gaps),
        summary: {
          reason: summary.reason,
          received: summary.received,
          delivered: summary.delivered,
          discarded: summary.discarded,
          late: summary.late,
          overflow: summary.overflow,
          nativeStop: summary.nativeStop,
          documents: summary.documentBoundaries.length,
        },
      },
      cleanup: yield* session.close,
    };
  }).pipe(
    Effect.provide(
      h.browser({
        launch: recipe({
          remoteTimeoutSeconds: h.budget.browserSeconds,
          viewport: { _tag: "Fixed", width: 1280, height: 720 },
        }),
      }),
    ),
  ),
);

await h.run(
  Effect.gen(function* () {
    const result = yield* soak;
    const maximum = h.budget.actions;

    yield* h.report("soak", result);
    yield* h.established({
      "the allowance is above the former 1,000 cap": maximum > 1000,
      "status counted every attempt up to the maximum": result.status.actions.used === maximum,
      "the host attempted exactly the maximum before the refusal": result.attempts === maximum,
      "status agreed with the host at every sample": result.samples.every(
        (sample) => sample.used === sample.attempts,
      ),
      "the next action was refused Limit, undispatched, at the maximum":
        result.refused.reason._tag === "Limit" &&
        result.refused.reason.maximum === maximum &&
        result.refused.reason.observed === maximum &&
        result.refused.outcome === "undispatched",
      "the owner stayed open": result.status.phase === "open" && result.status.reason === null,
      "a host read still ran": result.checkpoint.ok,
      "frames arrived in every quarter": result.capture.framesPerQuarter.every(
        (count) => count > 0,
      ),
      "the interval stopped cleanly": result.capture.summary.nativeStop === "confirmed",
      "the session released": result.cleanup.remote === "confirmed",
    });

    return result;
  }),
);
