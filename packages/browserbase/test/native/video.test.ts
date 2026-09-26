import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { NavigateRequest } from "effect-browser/browser-data";
import { BrowserbaseBrowser } from "effect-browserbase/browser";

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
            const session = yield* (yield* BrowserbaseBrowser).open(policy);

            yield* session.navigate(NavigateRequest.make({ url: fixture.url }));

            // #19: recordInterval awaits a real first write on the measured recording.
            const result = yield* recordInterval(session, output, 2_000);

            // Malformed ffprobe output is a fixture defect: it dies rather than widening the error type.
            const probe = yield* Schema.decodeUnknownEffect(Probe)(result.decoded).pipe(
              Effect.orDie,
            );

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
            const sourceSpan = result.artifact.sourceLastMillis - result.artifact.sourceFirstMillis;

            const distinctFrames = new Set(result.decodedFrames.map((frame) => frame.checksum))
              .size;

            expect(result.decodedFrames.length).toBeGreaterThan(1);
            expect(distinctFrames).toBeGreaterThan(1);
            expect(times.every((time, index) => index === 0 || time > times[index - 1]!)).toBe(
              true,
            );
            expect(decodedSpan).toBeGreaterThan(250);
            // The maintained writer resamples source time onto a 25 Hz timeline. Allow
            // four ticks for endpoint rounding, not seconds of fabricated timing.
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
