import { createServer } from "node:http";

import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { BrowserPolicy } from "effect-browser/browser-data";
import { Chromium } from "effect-browser/chromium";

import { externalChromium } from "../fixtures/StandaloneBrowser.ts";

// Every input event is mirrored, so any key that reached the field is visible afterwards.
const site = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{ readonly origin: string; readonly close: () => void }>((resolve) => {
        const server = createServer((_request, response) => {
          response.writeHead(200, { "content-type": "text/html" });
          response.end(`<!doctype html><input aria-label="Name" id="field"><output id="mirror"></output>
<script>field.addEventListener("input", () => { mirror.textContent = field.value; });</script>`);
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

const fill = (value: string) =>
  ({
    version: 1,
    steps: [
      {
        id: "name",
        action: {
          _tag: "Fill",
          target: { _tag: "Descriptor", descriptor: { kind: "input", label: "Name" } },
          value: { _tag: "Literal", value },
        },
      },
    ],
  }) as const;

const layer = Chromium.layer({}).pipe(Layer.provide(NodeCrypto.layer));

const open = Effect.fnUntraced(function* () {
  const { origin } = yield* site;
  const host = yield* externalChromium;

  const session = yield* Chromium.attach(host.endpoint, {
    policy: BrowserPolicy.unrestricted({ maxActions: 20, maxElapsedMillis: 60_000 }),
  });

  yield* session.initialPage.navigate({ url: `${origin}/` });

  return session.initialPage;
});

it.live("real CDP: the timeline says which performed acknowledgements were preparatory", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const page = yield* open();

      yield* page.run(fill("ab"), { style: { seed: 7 }, within: "20 seconds" });

      const acknowledged = (yield* page.timeline.snapshot()).events.flatMap((event) =>
        event.event._tag === "Acknowledged" ? [event.event] : [],
      );

      expect(acknowledged).toContainEqual(
        expect.objectContaining({
          acknowledgement: { subphase: "focus", logicalComplete: false },
        }),
      );
      expect((yield* page.readText({ selector: "#mirror" })).text).toBe("ab");
    }).pipe(Effect.provide(layer)),
  ),
);
