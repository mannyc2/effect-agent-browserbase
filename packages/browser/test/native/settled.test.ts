import { createServer } from "node:http";

import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { BrowserPolicy } from "effect-browser/browser-data";
import { Chromium } from "effect-browser/chromium";

import { externalChromium } from "../fixtures/StandaloneBrowser.ts";

// The first document replaces itself while a settled wait observes it.
const site = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{ readonly origin: string; readonly close: () => void }>((resolve) => {
        const server = createServer((request, response) => {
          response.writeHead(200, { "content-type": "text/html" });
          if (request.url === "/next") return void response.end("<!doctype html><p>next</p>");
          response.end(
            `<!doctype html><p>first</p><script>setTimeout(() => { location.href = "/next"; }, 800)</script>`,
          );
        });

        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          const port = typeof address === "object" && address !== null ? address.port : 0;

          resolve({ origin: `http://127.0.0.1:${String(port)}`, close: () => server.close() });
        });
      }),
  ),
  (server) => Effect.sync(server.close),
);

it.live("real CDP: a page-initiated navigation ends a settled wait Stale and frees its slot", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { origin } = yield* site;
      const host = yield* externalChromium;

      const session = yield* Chromium.attach(host.endpoint, {
        policy: BrowserPolicy.unrestricted({ maxActions: 20, maxElapsedMillis: 60_000 }),
      });

      const page = session.initialPage;

      yield* page.navigate({ url: `${origin}/` });
      expect(
        yield* page.settled({ quiet: "5 seconds", within: "10 seconds" }).pipe(Effect.flip),
      ).toMatchObject({ reason: { _tag: "Stale" }, outcome: "undispatched" });

      // The replaced document's observer is gone, so the page's one wait slot is free again.
      yield* Effect.sleep("500 millis");
      const evidence = yield* page.settled({ quiet: "100 millis", within: "5 seconds" });

      expect(evidence.signals).toHaveLength(4);
    }).pipe(Effect.provide(Chromium.layer({}).pipe(Layer.provide(NodeCrypto.layer)))),
  ),
);
