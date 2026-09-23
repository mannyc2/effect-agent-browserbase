import { Effect, Stream } from "effect";
import * as Browser from "effect-browser/browser";
import { BrowserPolicy } from "effect-browser/browser-data";
import * as Capture from "effect-browser/capture";
import { Chromium } from "effect-browser/chromium";
import { BrowserError, Reasons } from "effect-browser/errors";

// Each browser Layer here takes Effect's `Crypto` from the caller's platform Layer, such as
// `NodeServices.layer`, so these compositions still require it.

/** Inspect a scout tab while reading and capturing the pinned presentation page. */
export const inspectWithStage = (stageUrl: string, scoutUrl: string) =>
  Browser.scoped(
    Chromium.launch(BrowserPolicy.unrestricted({ maxActions: 40, maxElapsedMillis: 60000 })),
    (browser) =>
      Effect.gen(function* () {
        const stageInfo = (yield* browser.pages).find((page) => page.selected);

        if (stageInfo === undefined)
          return yield* BrowserError.make({
            operation: "target",
            reason: Reasons.NotFound.make({}),
            outcome: "undispatched",
          });

        const stage = yield* browser.pinPage(stageInfo);

        yield* stage.navigate({ url: stageUrl });
        yield* browser.selectPage(yield* browser.createPage);
        yield* browser.navigate({ url: scoutUrl });

        // The selected scout supplies the observation and its exact-node references.
        const scout = yield* browser.observe({ scope: "viewport" });
        // These operations keep the scout selected and do not replace its observation.
        const stageText = yield* stage.readText({});

        const frames = yield* Capture.stream(browser, {
          target: stageInfo,
          lifetime: "page",
          maxDurationMillis: 5000,
        }).pipe(Stream.take(1), Stream.runCollect);

        // Only detached data leaves the owning scope. Encoding remains the caller's choice.
        return { scout, stageText: stageText.text, frame: frames[0] };
      }),
  ).pipe(Effect.provide(Chromium.layer({ viewport: { width: 1280, height: 720 } })));
