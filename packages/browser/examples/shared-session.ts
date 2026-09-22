import { Context, Effect, Layer } from "effect";
import * as Browser from "effect-browser/browser";
import { BrowserPolicy } from "effect-browser/browser-data";
import {
  Chromium,
  type ChromiumCleanupResult,
  type ChromiumSession,
} from "effect-browser/chromium";

const policy = BrowserPolicy.unrestricted({ maxElapsedMillis: 300_000 });

/** The Layer shares one finite lifetime; application code chooses how to supervise it. */
export class SharedBrowser extends Context.Service<SharedBrowser, ChromiumSession>()(
  "examples/SharedBrowser",
) {}

export const sharedLayer = (onCleanup: (receipt: ChromiumCleanupResult) => Effect.Effect<void>) =>
  Layer.effect(SharedBrowser, Chromium.launch(policy)).pipe(
    Layer.provide(Chromium.layer({ onCleanup })),
  );

export const readSharedPage = Effect.gen(function* () {
  const browser = yield* SharedBrowser;

  return yield* browser.observe({ scope: "viewport" });
});

/** The single receipt slot belongs to the host, outside the workflow selected by the timeout. */
export const racedWorkflow = Effect.fnUntraced(function* (url: string) {
  let receipt: ChromiumCleanupResult | undefined;

  const result = yield* Browser.scoped(Chromium.launch(policy), (browser) =>
    browser.navigate({ url }),
  ).pipe(
    Effect.timeoutOption("30 seconds"),
    Effect.provide(
      Chromium.layer({
        onCleanup: (value) =>
          Effect.sync(() => {
            receipt = value;
          }),
      }),
    ),
  );

  return { result, receipt };
});

/** Explicit checked closure returns the concrete receipt; the scoped finalizer reuses it. */
export const checkedWorkflow = (url: string) =>
  Browser.scoped(Chromium.launch(policy), (browser) =>
    Effect.gen(function* () {
      yield* browser.navigate({ url });

      return yield* browser.closeChecked;
    }),
  ).pipe(Effect.provide(Chromium.layer()));
