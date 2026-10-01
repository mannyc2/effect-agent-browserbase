import { createServer } from "node:http";

import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import * as BrowserTools from "effect-agent-browser/tools";
import { BrowserPolicy, ObservedElement } from "effect-browser/browser-data";
import { Chromium } from "effect-browser/chromium";

// A button that opens a dialog. Under the pause policy the dialog quarantines its page.
const site = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{ readonly origin: string; readonly close: () => void }>((resolve) => {
        const server = createServer((_request, response) => {
          response.writeHead(200, { "content-type": "text/html" });
          response.end(`<!doctype html><p id=answer></p>
<button onclick="answer.textContent=String(confirm('Proceed?'))">Ask</button>`);
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
  "real CDP: once a dialog quarantines the bound page, tools tell the model it is closed",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { origin } = yield* site;
        const chromium = yield* Chromium;

        const session = yield* (yield* chromium.acquire(
          BrowserPolicy.unrestricted({ maxActions: 50, maxElapsedMillis: 60_000 }),
        )).connect;

        const page = session.initialPage;

        yield* page.navigate({ url: `${origin}/` });
        const host = yield* BrowserTools.makeHost(session, page);
        const tools = yield* BrowserTools.toolkit.pipe(Effect.provide(host.handlers));
        const observed = yield* page.observe();
        const ask = observed.controls.find((control) => control.label === "Ask");

        expect(ask).toBeDefined();
        // The click opens the dialog, so the owner quarantines this page for an operator.
        yield* page
          .clickElement(
            ObservedElement.make({
              observationId: observed.observationId,
              elementId: ask?.elementId ?? "",
            }),
          )
          .pipe(Effect.flip);
        expect(yield* page.status).toMatchObject({ phase: "paused" });

        // Nothing on this exact page works again: recovery issues fresh Pages after the handoff.
        expect(
          (yield* Stream.runCollect(yield* tools.handle("browser_inspect", {})))[0]?.encodedResult,
        ).toEqual({ _tag: "BrowserToolFailure", reason: "closed", outcome: "undispatched" });
      }).pipe(
        Effect.provide(
          Chromium.layer({
            launch: {
              ...(process.env.BROWSERBASE_CHROMIUM === undefined
                ? {}
                : { executablePath: process.env.BROWSERBASE_CHROMIUM }),
              chromiumSandbox: false,
              startupTimeoutMillis: 25000,
            },
            dialogPolicy: "pause",
          }).pipe(Layer.provide(NodeCrypto.layer)),
        ),
      ),
    ),
);
