import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as Capture from "@effect-agent/platform-browserbase/capture";
import { BrowserbaseInteractiveHost } from "@effect-agent/platform-browserbase/interactive-browser";
import { expect, it } from "@effect/vitest";
import { Effect, Schema, Stream } from "effect";
import { BrowserNavigateRequest } from "effect-agent/interactive-browser";

import { recordInterval } from "../../examples/record-video.ts";
import { localBrowser, policy, withProvider } from "../fixtures/LocalBrowser.ts";

const Probe = Schema.Struct({
  streams: Schema.Array(
    Schema.Struct({
      codec_type: Schema.String,
      width: Schema.optionalKey(Schema.Finite),
      height: Schema.optionalKey(Schema.Finite),
      duration: Schema.optionalKey(Schema.String),
    }),
  ),
  format: Schema.Struct({ duration: Schema.optionalKey(Schema.String) }),
});

it.live(
  "real CDP capture: caller encoder produces decodable moving video with source timing and no claimed audio",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* localBrowser;

        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "browserbase-video-test-"))),
          (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
        );

        const output = join(directory, "capture.mp4");

        yield* withProvider(
          fixture,
          Effect.gen(function* () {
            const session = yield* (yield* BrowserbaseInteractiveHost).open(policy);

            yield* session.handle.navigate(BrowserNavigateRequest.make({ url: fixture.url }));

            // Spend Chromium's screencast startup outside the measured interval.
            // Pinned Playwright's Screencast.addClient calls _startScreencast
            // without awaiting it, which calls delegate.startScreencast without
            // awaiting it either, so a resolved Capture.start means the client is
            // registered — not that Page.startScreencast was acknowledged, and not
            // that a frame exists. Measured at that exact boundary on two loaded
            // cores: the first frame arrives after 34ms at the median and 41ms at
            // p90, but with a 1,939ms tail, and 4 of 16 2,000ms windows produced
            // no frame at all. Charged against a 2,000ms budget that is what left
            // the interval below the two frames an encoder needs (#19).
            //
            // Taking one frame proves the pipeline is delivering; ending the stream
            // stops this throwaway interval and releases its lease, so the measured
            // interval below starts on an already-warm page. The duration bounds
            // the wait, so a page that never produces a frame still reaches the
            // assertions below with the same values as before.
            yield* Effect.scoped(
              Effect.gen(function* () {
                const warm = yield* Capture.start(session, {
                  maxFrames: 2,
                  maxDurationMillis: 4_000,
                });

                yield* warm.frames.pipe(Stream.take(1), Stream.runDrain);
              }),
            );
            const result = yield* recordInterval(session, output, 2_000);
            // Malformed ffprobe output should fail this fixture synchronously, not widen its Effect error type.
            // @effect-diagnostics-next-line schemaSyncInEffect:off
            const probe = Schema.decodeUnknownSync(Probe)(result.decoded);
            const video = probe.streams.find((stream) => stream.codec_type === "video");

            expect(video).toBeDefined();
            expect(video?.width).toBeGreaterThan(100);
            expect(video?.height).toBeGreaterThan(100);
            expect(Number(probe.format.duration ?? video?.duration ?? "0")).toBeGreaterThan(0.5);
            expect(probe.streams.some((stream) => stream.codec_type === "audio")).toBe(false);
            expect(result.summary.delivered).toBeGreaterThan(1);
            if (
              result.summary.sourceFirstMillis === null ||
              result.summary.sourceLastMillis === null
            ) {
              return yield* Effect.die("capture summary omitted source timestamps");
            }
            expect(
              result.summary.sourceLastMillis - result.summary.sourceFirstMillis,
            ).toBeGreaterThan(250);
            const times = result.decodedFrames.map((frame) => frame.presentationTimeMillis);
            const decodedSpan = Math.max(...times) - Math.min(...times);
            const sourceSpan = result.summary.sourceLastMillis - result.summary.sourceFirstMillis;

            const distinctFrames = new Set(result.decodedFrames.map((frame) => frame.checksum))
              .size;

            expect(result.decodedFrames.length).toBeGreaterThan(1);
            expect(distinctFrames).toBeGreaterThan(1);
            expect(times.every((time, index) => index === 0 || time > times[index - 1]!)).toBe(
              true,
            );
            expect(decodedSpan).toBeGreaterThan(250);
            // The concat demuxer quantizes JPEG durations to 25 Hz. Allow four
            // ticks for endpoint rounding, not seconds of fabricated timing.
            expect(Math.abs(decodedSpan - sourceSpan)).toBeLessThan(160);
            expect((yield* Effect.promise(() => stat(output))).size).toBeGreaterThan(1_000);
            const evidenceDirectory = process.env.BROWSERBASE_VIDEO_EVIDENCE_DIR;

            if (evidenceDirectory !== undefined) {
              yield* Effect.promise(async () => {
                await mkdir(evidenceDirectory, { recursive: true });
                await copyFile(output, join(evidenceDirectory, "capture.mp4"));
                await writeFile(
                  join(evidenceDirectory, "verification.json"),
                  JSON.stringify(
                    { probe, sourceSpan, decodedSpan, frames: result.decodedFrames },
                    null,
                    2,
                  ) + "\n",
                );
              });
            }
            // Child capture/encoding ended; the same browser remains usable.
            expect((yield* session.observe()).text).toContain("Local browser fixture");
          }),
        );
      }),
    ),
);
