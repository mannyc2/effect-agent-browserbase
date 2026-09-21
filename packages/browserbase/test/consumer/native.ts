// Installed-package workflow for a consumer that owns a real browser.
//
// It runs as an ordinary program on the pinned Node and Bun against a local
// Chromium process over real CDP, using only the installed package's public
// exports. The provider control plane is scripted; the browser is not.
import { BrowserbaseBrowser } from "@effect-agent/browserbase/browser";
import { NavigateRequest } from "@effect-agent/browserbase/browser-data";
import * as Capture from "@effect-agent/browserbase/capture";
import { Effect, Schema, Stream } from "effect";

import { localBrowser, policy, withProvider } from "../fixtures/LocalBrowser.ts";

const expect = (condition: boolean, message: string) => {
  if (!condition) throw new Error(`Consumer assertion failed: ${message}`);
};

const program = Effect.scoped(
  Effect.gen(function* () {
    const fixture = yield* localBrowser;

    return yield* withProvider(
      fixture,
      Effect.gen(function* () {
        const session = yield* (yield* BrowserbaseBrowser).open(policy);

        yield* session.bind().navigate(NavigateRequest.make({ url: fixture.url }));
        const observation = yield* session.observe({ maxTextBytes: 4096, maxControls: 8 });

        expect(observation.text.includes("Local browser fixture"), "real page text is observed");
        expect(observation.controls.length > 0, "real controls are observed");

        const captured = yield* Effect.scoped(
          Effect.gen(function* () {
            const interval = yield* Capture.start(session, {
              maxFrames: 4,
              maxDurationMillis: 5000,
              size: { width: 320, height: 240 },
            });

            const frames = yield* Stream.runCollect(interval.frames.pipe(Stream.take(1)));

            expect(frames.length === 1, "live capture delivers a frame from the owned page");
            expect(
              Schema.is(Capture.CapturedFrame)(frames[0]),
              "a delivered frame is the public CapturedFrame value",
            );

            return yield* interval.stop;
          }),
        );

        expect(captured.dropped === 0, "no frame is dropped inside the bounded window");
        expect(captured.duplicates === 0, "no frame is delivered twice");

        const cleanup = yield* session.close;

        expect(cleanup.ownership === "owned", "this consumer owned the session");
        expect(cleanup.local === "closed", "the local connection is closed");
        expect(cleanup.remote === "confirmed", "release is confirmed by a terminal read");
        expect(cleanup.issues.length === 0, "cleanup reports no issue");
        expect(fixture.releaseIds.length === 1, "exactly one release was requested");

        return {
          reference: cleanup.reference.sessionId,
          text: observation.text.length,
          delivered: captured.delivered,
          nativeStop: captured.nativeStop,
        };
      }),
    );
  }),
);

const result = await Effect.runPromise(program);

console.log(JSON.stringify({ profile: "generic", ...result }));
