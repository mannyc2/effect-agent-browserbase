import { createServer } from "node:http";

import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { BrowserPolicy } from "effect-browser/browser-data";
import { Chromium } from "effect-browser/chromium";

import { externalChromium } from "../fixtures/StandaloneBrowser.ts";

// The page replaces Array.prototype.push, so every array it builds, including the node array a
// descriptor read builds in its main world, also gains an enumerable element property.
const site = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{ readonly origin: string; readonly close: () => void }>((resolve) => {
        const server = createServer((_request, response) => {
          response.writeHead(200, { "content-type": "text/html" });
          response.end(`<!doctype html><script>
const push = Array.prototype.push;
Array.prototype.push = function (...items) {
  Object.defineProperty(this, "hostile" + this.length, { enumerable: true, value: document.documentElement });
  return push.apply(this, items);
};
</script>
<button onclick="clicked.textContent='clicked'">Accept</button><output id=clicked></output>`);
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

it.live("real CDP: page-added array properties never widen a descriptor's node extraction", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { origin } = yield* site;
      const host = yield* externalChromium;

      const session = yield* Chromium.attach(host.endpoint, {
        policy: BrowserPolicy.unrestricted({ maxActions: 20, maxElapsedMillis: 60_000 }),
      });

      yield* session.initialPage.navigate({ url: `${origin}/` });
      yield* session.initialPage.run({
        version: 1,
        steps: [
          {
            id: "accept",
            action: {
              _tag: "Click",
              target: {
                _tag: "Descriptor",
                descriptor: { kind: "button", label: "Accept", matchScope: "document" },
              },
            },
          },
        ],
      });

      expect((yield* session.initialPage.readText({ selector: "#clicked" })).text).toBe("clicked");
    }).pipe(Effect.provide(Chromium.layer({}).pipe(Layer.provide(NodeCrypto.layer)))),
  ),
);
