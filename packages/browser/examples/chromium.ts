import type { Redacted } from "effect";
import { Effect, Stream } from "effect";
import * as Browser from "effect-browser/browser";
import { BrowserPolicy } from "effect-browser/browser-data";
import * as Capture from "effect-browser/capture";
import { Chromium } from "effect-browser/chromium";

const policy = BrowserPolicy.unrestricted({ maxActions: 20, maxElapsedMillis: 60000 });

/** Launch one owned Chromium and capture a real frame from the page it navigated to. */
export const inspectChromium = (url: string) =>
  Browser.scoped(Chromium.launch(policy), (session) =>
    Effect.gen(function* () {
      yield* session.navigate({ url });
      const observation = yield* session.observe({ scope: "viewport" });
      const interval = yield* Capture.start(session, { maxDurationMillis: 10000 });
      const frames = yield* interval.frames.pipe(Stream.take(1), Stream.runCollect);
      const summary = yield* interval.stop;

      // Capture owns the bytes; callers own encoding, storage and presentation.
      return { observation, frames, summary };
    }),
  ).pipe(Effect.provide(Chromium.layer({ launch: { chromiumSandbox: true } })));

/** Borrow an existing loopback CDP browser. Closing this scope leaves its process running. */
export const inspectExistingChromium = (endpoint: Redacted.Redacted<string>) =>
  Browser.scoped(Chromium.attach(endpoint, { policy }), (session) =>
    session.observe({ scope: "viewport" }),
  ).pipe(Effect.provide(Chromium.layer()));
