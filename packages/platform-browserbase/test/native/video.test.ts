import { expect, it } from "@effect/vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { BrowserbaseInteractiveHost } from "@effect-agent/platform-browserbase/interactive-browser";
import { BrowserNavigateRequest } from "effect-agent/interactive-browser";
import { recordInterval } from "../../examples/record-video.ts";
import { localBrowser, policy, withProvider } from "../fixtures/LocalBrowser.ts";

const Probe = Schema.Struct({
  streams: Schema.Array(Schema.Struct({
    codec_type: Schema.String,
    width: Schema.optionalKey(Schema.Number),
    height: Schema.optionalKey(Schema.Number),
    duration: Schema.optionalKey(Schema.String),
  })),
  format: Schema.Struct({ duration: Schema.optionalKey(Schema.String) }),
});

it.live("real CDP capture: caller encoder produces decodable moving video with source timing and no claimed audio", () =>
  Effect.scoped(Effect.gen(function* () {
    const fixture = yield* localBrowser;
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "browserbase-video-test-"))),
      (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
    );
    const output = join(directory, "capture.mp4");
    yield* withProvider(fixture, Effect.gen(function* () {
      const session = yield* (yield* BrowserbaseInteractiveHost).open(policy);
      yield* session.handle.navigate(BrowserNavigateRequest.make({ url: fixture.url }));
      const result = yield* recordInterval(session, output, 2_000);
      const probe = Schema.decodeUnknownSync(Probe)(result.decoded);
      const video = probe.streams.find((stream) => stream.codec_type === "video");
      expect(video).toBeDefined();
      expect(video?.width).toBeGreaterThan(100);
      expect(video?.height).toBeGreaterThan(100);
      expect(Number(probe.format.duration ?? video?.duration ?? "0")).toBeGreaterThan(0.5);
      expect(probe.streams.some((stream) => stream.codec_type === "audio")).toBe(false);
      expect(result.summary.delivered).toBeGreaterThan(1);
      if (result.summary.sourceFirstMillis === null || result.summary.sourceLastMillis === null) {
        return yield* Effect.die("capture summary omitted source timestamps");
      }
      expect(result.summary.sourceLastMillis - result.summary.sourceFirstMillis).toBeGreaterThan(250);
      expect((yield* Effect.promise(() => stat(output))).size).toBeGreaterThan(1_000);
      // Child capture/encoding ended; the same browser remains usable.
      expect((yield* session.observe()).text).toContain("Local browser fixture");
    }));
  })),
);
