// Produce the repository's published demo recording from one real hosted session.
//
// This is documentation evidence, not an acceptance gate: `hosted-acceptance.ts`
// remains the guarded correctness run. Both allocate a paid Browserbase session,
// so both refuse to start without an explicit operator opt-in. No model is
// invoked and no provider recording is requested or downloaded here; the video
// is encoded by the caller from the same live-page frame stream that
// `record-video.ts` demonstrates.
//
// The recording itself lives in `demo-recording.ts` so that `test/native/demo.test.ts`
// can prove the pacing and encoding against a local Chromium over real CDP. A
// hosted session is spent publishing the result, not discovering those.
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { BrowserbaseInteractiveHost } from "@effect-agent/platform-browserbase/interactive-browser";
import { Effect, Redacted } from "effect";
import { InteractiveBrowserPolicy } from "effect-agent/interactive-browser";
import { FetchHttpClient } from "effect/unstable/http";

import { recordDemo } from "./demo-recording.ts";

const apiKey = process.env.BROWSERBASE_API_KEY;
const projectId = process.env.BROWSERBASE_PROJECT_ID;

if (process.env.EFFECT_AGENT_BROWSERBASE_LIVE !== "1" || !apiKey || !projectId) {
  throw new Error(
    "Set EFFECT_AGENT_BROWSERBASE_LIVE=1, BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID",
  );
}

// The demo navigates exactly where a trusted operator configured. A published
// recording shows whatever the page showed, so the destination is deliberate
// host configuration rather than anything derived from page or model data.
const target =
  process.env.BROWSERBASE_DEMO_URL ?? "https://github.com/mannyc2/effect-agent-browserbase";

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

const output = resolve(process.env.BROWSERBASE_DEMO_OUTPUT ?? "demo/hosted-demo.mp4");

const durationMillis = Math.min(
  15_000,
  Math.max(2_000, Number(process.env.BROWSERBASE_DEMO_MILLIS ?? "6000")),
);

// Host-owned output setup belongs to the script, not to the session's error
// channel; the encoder in record-video.ts owns everything after that.
await mkdir(dirname(output), { recursive: true });

const report = (phase: string, result: unknown) => {
  console.log(
    JSON.stringify({ phase, result }, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    ),
  );
};

// Four scrolls, one navigation and one observation stay well inside this action
// bound. The elapsed bound is a ceiling on a stuck run, not the expected cost:
// a successful demo ends as soon as the capture and cleanup finish.
const policy = InteractiveBrowserPolicy.make({
  network: { _tag: "Unrestricted" },
  maxActions: 10,
  maxElapsedMillis: 120_000,
  maxReturnedBytes: 2 * 1024 * 1024,
});

const program = Effect.scoped(
  Effect.gen(function* () {
    const session = yield* (yield* BrowserbaseInteractiveHost).open(policy);

    yield* Effect.sync(() => report("allocated", session.reference));
    const demo = yield* recordDemo(session, targetUrl, output, { durationMillis });
    const cleanup = yield* session.close;

    return { reference: session.reference, output, ...demo, cleanup };
  }).pipe(
    Effect.provide(
      BrowserbaseInteractiveHost.layer({
        projectId,
        apiKey: Redacted.make(apiKey),
        // The demo encodes its own frames and never retrieves provider media,
        // so no artifact delivery origin is approved for this run.
        recordSession: false,
        actionTimeoutMillis: 15_000,
        requestTimeoutMillis: 15_000,
        onCleanup: (cleanup) => Effect.sync(() => report("cleanup", cleanup)),
        onAllocationUncertain: (attempt) =>
          Effect.sync(() => report("allocation-unknown", attempt)),
      }),
    ),
    Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
    Effect.tapError((error) => Effect.sync(() => report("failure", error))),
  ),
);

const result = await Effect.runPromise(program);

report("complete", result);
