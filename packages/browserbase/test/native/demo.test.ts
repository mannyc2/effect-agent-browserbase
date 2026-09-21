import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BrowserbaseBrowser } from "@effect-agent/browserbase/browser";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { recordDemo } from "../../examples/demo-recording.ts";
import { localBrowser, policy, withProvider } from "../fixtures/LocalBrowser.ts";

// The published demo is recorded by a hosted session, but its pacing, its
// action budget and its encoding are ordinary integration behavior. Proving
// them here over real CDP keeps a paid session for publishing the result.
it.live(
  "the published demo's driver scrolls inside its own capture window and encodes moving video",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* localBrowser;

        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "browserbase-demo-test-"))),
          (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
        );

        const output = join(directory, "demo.mp4");

        yield* withProvider(
          fixture,
          Effect.gen(function* () {
            const session = yield* (yield* BrowserbaseBrowser).open(policy);

            const demo = yield* recordDemo(session, fixture.url, output, {
              durationMillis: 3_000,
            });

            // Every scroll must land before the encoder stops collecting;
            // a driver that outlives its capture window is the failure this
            // test exists to keep out of a hosted run.
            expect(demo.scrolled.dispatched).toBe(4);
            expect(demo.scrolled.deltaY).toBe(1_280);
            expect(demo.capture.delivered).toBeGreaterThan(1);
            expect(demo.decodedFrames).toBeGreaterThan(1);
            expect(demo.distinctFrames).toBeGreaterThan(1);
            expect((yield* Effect.promise(() => stat(output))).size).toBeGreaterThan(1_000);
            // Scrolling borrows the live page; it must not end the session.
            expect((yield* session.observe()).text).toContain("Local browser fixture");
            expect((yield* session.close).remote).toBe("confirmed");
          }),
        );
      }),
    ),
);
