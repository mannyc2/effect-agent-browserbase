import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import {
  BrowserPolicy,
  ClickRequest,
  NavigateRequest,
  ReadTextRequest,
} from "effect-browser/browser-data";
import { Chromium } from "effect-browser/chromium";

import { localSite } from "../fixtures/StandaloneBrowser.ts";

const launch = {
  ...(process.env.BROWSERBASE_CHROMIUM === undefined
    ? {}
    : { executablePath: process.env.BROWSERBASE_CHROMIUM }),
  chromiumSandbox: false,
  startupTimeoutMillis: 25000,
};

// In Bando a planner's click on a background page timed out and fenced the whole session,
// taking the page on air down with it.
it.live("a click that never lands on a background page closes only that page", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const site = yield* localSite;

      const session = yield* (yield* Chromium).launch(
        BrowserPolicy.unrestricted({ maxElapsedMillis: 60000 }),
      );

      yield* session.navigate(
        NavigateRequest.make({ url: new URL("/pinned?name=stage", site.url).href }),
      );
      const planner = yield* session.createPage;
      const pinned = yield* session.pinPage(planner);

      yield* pinned.navigate({ url: site.url });

      // The box never stops moving, so the engine's click is sent and never finishes.
      expect(
        yield* pinned.click(ClickRequest.make({ selector: "#motion" })).pipe(Effect.flip),
      ).toMatchObject({ operation: "click", outcome: "unknown" });
      expect(yield* session.status).toMatchObject({ phase: "open", unresolvedDispatch: false });
      expect((yield* session.diagnostics).records).toMatchObject([
        { reason: "page-contained", disposition: "confirmed" },
      ]);
      expect(yield* session.pages).toMatchObject([{ selected: true }]);
      expect(yield* session.describePage(planner).pipe(Effect.flip)).toMatchObject({
        reason: { _tag: "NotFound" },
        outcome: "undispatched",
      });

      yield* session.click(ClickRequest.make({ selector: "#increment" }));
      expect((yield* session.readText(ReadTextRequest.make({ selector: "#count" }))).text).toBe(
        "1",
      );
      expect(yield* session.createPage).toMatchObject({ selected: false });
    }),
  ).pipe(
    Effect.provide(
      Chromium.layer({ launch, actionTimeoutMillis: 2000 }).pipe(Layer.provide(NodeCrypto.layer)),
    ),
  ),
);
