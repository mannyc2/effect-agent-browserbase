import { createServer } from "node:http";

import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { BrowserPolicy, ObservedElement } from "effect-browser/browser-data";
import { Chromium } from "effect-browser/chromium";

import { externalChromium } from "../fixtures/StandaloneBrowser.ts";

// An advertisement that reloads its frame changes nothing an observation of the page names, so
// it must not retire that observation or make readings of the page fail as stale.

const site = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{ readonly origin: string; readonly close: () => void }>((resolve) => {
        const server = createServer((request, response) => {
          response.writeHead(200, { "content-type": "text/html" });
          if (request.url?.startsWith("/ad"))
            return void response.end("<body>advertisement</body>");
          response.end(`<!doctype html><p>market words</p>
<button id=buy onclick="bought.textContent='bought'">Buy</button><output id=bought></output>
<iframe id=ad src="/ad?0" width=300 height=100></iframe>
<script>let n=0;setInterval(()=>{document.getElementById("ad").src="/ad?"+(++n)},100)</script>`);
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

it.live(
  "real CDP: a child frame reloading neither retires an observation nor stales a reading",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { origin } = yield* site;
        const host = yield* externalChromium;

        const session = yield* Chromium.attach(host.endpoint, {
          policy: BrowserPolicy.unrestricted({ maxActions: 100, maxElapsedMillis: 120_000 }),
        });

        yield* session.navigate({ url: `${origin}/` });

        for (let i = 0; i < 20; i++) {
          const reading = yield* session.observe({ scope: "viewport" });

          expect(reading.text).toContain("market words");
        }

        const observed = yield* session.observe({ scope: "viewport" });
        const buy = observed.controls.find((control) => control.label === "Buy");

        expect(buy).toBeDefined();
        // Several reloads of the advertisement happen before the click.
        yield* Effect.sleep(500);
        yield* session.clickElement(
          ObservedElement.make({
            observationId: observed.observationId,
            elementId: buy?.elementId ?? "",
          }),
        );
        expect((yield* session.readText({ selector: "#bought" })).text).toBe("bought");

        // The page's own navigation still retires it.
        yield* session.navigate({ url: `${origin}/` });

        const stale = yield* session
          .clickElement(
            ObservedElement.make({
              observationId: observed.observationId,
              elementId: buy?.elementId ?? "",
            }),
          )
          .pipe(Effect.flip);

        expect(stale.reason._tag).toBe("Stale");
      }).pipe(Effect.provide(Chromium.layer({}).pipe(Layer.provide(NodeCrypto.layer)))),
    ),
);
