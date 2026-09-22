import type { Redacted } from "effect";
import { Effect, Stream } from "effect";
import { BrowserPolicy } from "effect-browser/browser-data";
import * as Capture from "effect-browser/capture";
import { Chromium } from "effect-browser/chromium";

const policy = BrowserPolicy.unrestricted({ maxActions: 20, maxElapsedMillis: 60000 });

/** Launch one owned Chromium and capture a real frame from the page it navigated to. */
export const inspectChromium = (url: string) =>
  Effect.gen(function* () {
    const browser = yield* Chromium;

    return yield* browser.withBrowser(policy, {}, (session) =>
      Effect.gen(function* () {
        yield* session.bind().navigate({ url });
        const observation = yield* session.observe({ scope: "viewport" });
        const interval = yield* Capture.start(session, { maxDurationMillis: 10000 });
        const frames = yield* interval.frames.pipe(Stream.take(1), Stream.runCollect);
        const summary = yield* interval.stop;

        // Capture owns the bytes; callers own encoding, storage and presentation.
        return { observation, frames, summary };
      }),
    );
  }).pipe(Effect.provide(Chromium.layer({ launch: { chromiumSandbox: true } })));

/** Borrow an existing loopback CDP browser. Closing this scope leaves its process running. */
export const inspectExistingChromium = (endpoint: Redacted.Redacted<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const session = yield* (yield* Chromium).attach(endpoint, { policy });
      const observation = yield* session.observe({ scope: "viewport" });

      yield* session.closeChecked;

      return { observation, cleanup: yield* session.close };
    }),
  ).pipe(Effect.provide(Chromium.layer()));
