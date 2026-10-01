import { createServer } from "node:http";

import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { BrowserPolicy, ObservedElement } from "effect-browser/browser-data";
import { Chromium } from "effect-browser/chromium";

import { externalChromium } from "../fixtures/StandaloneBrowser.ts";

// An editor with no accessible name: its content is what was entered, not what it is called.
const site = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{ readonly origin: string; readonly close: () => void }>((resolve) => {
        const server = createServer((_request, response) => {
          response.writeHead(200, { "content-type": "text/html" });
          response.end(
            `<!doctype html><div role="textbox" contenteditable="true" style="min-height:2em"></div>`,
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

it.live("real CDP: entered editor content never becomes the control's label", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { origin } = yield* site;
      const host = yield* externalChromium;

      const session = yield* Chromium.attach(host.endpoint, {
        policy: BrowserPolicy.unrestricted({ maxActions: 20, maxElapsedMillis: 60_000 }),
      });

      const page = session.initialPage;

      yield* page.navigate({ url: `${origin}/` });
      const before = yield* page.observe();
      const editor = before.controls[0];

      expect(editor).toBeDefined();
      if (editor === undefined) return;
      yield* page.fillElement(
        ObservedElement.make({ observationId: before.observationId, elementId: editor.elementId }),
        "entered-secret",
      );

      const after = yield* page.observe();

      expect(after.controls.map((control) => control.label)).not.toContain("entered-secret");
      expect(after.text).toContain("entered-secret");
    }).pipe(Effect.provide(Chromium.layer({}).pipe(Layer.provide(NodeCrypto.layer)))),
  ),
);
