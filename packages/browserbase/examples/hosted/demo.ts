// Produce the repository's published demo recording from one real hosted session.
//
// This is documentation evidence, not an acceptance gate. No model is invoked and no provider
// recording is requested or downloaded here; the video is encoded by the caller from the same
// live-page frame stream that `record-video.ts` demonstrates.
//
// The recording itself lives in `demo-recording.ts` so that `test/native/demo.test.ts` can
// prove the pacing and encoding against a local Chromium over real CDP. A hosted session is
// spent publishing the result, not discovering those.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { recipe } from "@effect-agent/browserbase/launch";
import { Effect } from "effect";

import { recordDemo } from "../demo-recording.ts";
import { hostedCase } from "./harness.ts";

const h = hostedCase("demo");

// The demo navigates exactly where a trusted operator configured. A published recording shows
// whatever the page showed, so the destination is deliberate host configuration rather than
// anything derived from page or model data.
const target =
  h.setting("BROWSERBASE_DEMO_URL") ?? "https://github.com/mannyc2/effect-agent-browserbase";

const targetUrl = (() => {
  try {
    const url = new URL(target);

    if (url.protocol !== "https:" || !!url.username || !!url.password) return undefined;

    return url.href;
  } catch {
    return undefined;
  }
})();

if (targetUrl === undefined) {
  throw new Error("BROWSERBASE_DEMO_URL must be an exact credential-free HTTPS URL");
}

const output = join(h.output, "hosted-demo.mp4");

const durationMillis = Math.min(
  h.budget.captureSeconds * 1000,
  Math.max(2_000, Number(h.setting("BROWSERBASE_DEMO_MILLIS") ?? "6000")),
);

// Host-owned output setup belongs to the script, not to the session's error channel; the
// encoder in record-video.ts owns everything after that.
await mkdir(h.output, { recursive: true });

await h.run(
  Effect.scoped(
    Effect.gen(function* () {
      const session = yield* h.open();
      const demo = yield* recordDemo(session, targetUrl, output, { durationMillis });
      const cleanup = yield* session.close;

      return { reference: session.reference, output, ...demo, cleanup };
    }).pipe(
      Effect.provide(
        h.browser({
          launch: recipe({
            viewport: { _tag: "Fixed", width: 1280, height: 720 },
            // The demo encodes its own frames and never retrieves provider media, so no
            // artifact delivery origin is approved for this run.
            provider: { browserSettings: { recordSession: false } },
          }),
        }),
      ),
    ),
  ),
);
