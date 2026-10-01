import { createServer } from "node:http";

import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { BrowserPolicy } from "effect-browser/browser-data";
import { Chromium } from "effect-browser/chromium";

import { externalChromium } from "../fixtures/StandaloneBrowser.ts";

// Each page mirrors what a person would see into the DOM, so assertions read it publicly.
const pages: Record<string, string> = {
  // Two fields; every key event and the focused field are written to #log and #focus.
  "/keys": `<input aria-label="First" id="first"><input aria-label="Second" id="second">
<p id="log"></p><p id="focus"></p><p id="values"></p>
<script>
const log = [];
for (const type of ["keydown", "keyup"])
  document.addEventListener(type, (event) => {
    log.push(type + ":" + event.key);
    document.getElementById("log").textContent = log.join(",");
  }, true);
document.addEventListener("focusin", () => {
  document.getElementById("focus").textContent = document.activeElement.id;
});
document.addEventListener("input", () => {
  document.getElementById("values").textContent =
    first.value + "|" + second.value;
});
</script>`,
};

const site = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{ readonly origin: string; readonly close: () => void }>((resolve) => {
        const server = createServer((request, response) => {
          const body = pages[new URL(request.url ?? "/", "http://site").pathname];

          if (body === undefined) return void response.writeHead(404).end();
          response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          response.end(`<!doctype html><body>${body}</body>`);
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

const layer = Chromium.layer({}).pipe(Layer.provide(NodeCrypto.layer));

const open = (path: string) =>
  Effect.gen(function* () {
    const { origin } = yield* site;
    const host = yield* externalChromium;

    const session = yield* Chromium.attach(host.endpoint, {
      policy: BrowserPolicy.unrestricted({ maxActions: 1000, maxElapsedMillis: 120_000 }),
    });

    yield* session.initialPage.navigate({ url: `${origin}${path}` });

    return session;
  });

const input = (label: string) =>
  ({
    _tag: "Descriptor",
    descriptor: { kind: "input", label, matchScope: "document" },
  }) as const;

it.live("real CDP: a performed key that moves focus keeps its stroke balanced and its page", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const session = yield* open("/keys");
      const page = session.initialPage;

      yield* page.run(
        {
          version: 1,
          steps: [
            { id: "focus", action: { _tag: "Click", target: input("First") } },
            { id: "next", action: { _tag: "Press", target: input("First"), key: "Tab" } },
            {
              id: "back",
              action: {
                _tag: "Press",
                target: input("Second"),
                key: "Tab",
                modifiers: ["Shift"],
              },
            },
          ],
        },
        { style: { seed: 7 } },
      );

      expect((yield* page.readText({ selector: "#log" })).text).toBe(
        "keydown:Tab,keyup:Tab,keydown:Shift,keydown:Tab,keyup:Tab,keyup:Shift",
      );
      expect((yield* page.readText({ selector: "#focus" })).text).toBe("first");
      // Nothing is left held: the next plain key lands unshifted where focus is now.
      yield* page.type({ text: "x" });
      expect((yield* page.readText({ selector: "#values" })).text).toBe("x|");
    }).pipe(Effect.provide(layer)),
  ),
);
