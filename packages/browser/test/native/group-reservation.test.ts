import { createServer } from "node:http";

import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { BrowserPolicy } from "effect-browser/browser-data";
import { Chromium } from "effect-browser/chromium";

import { externalChromium } from "../fixtures/StandaloneBrowser.ts";

const lists = [1, 2, 3] as const;
const choices = Array.from({ length: 50 }, (_, index) => index);

// Three multi-selects of fifty short options: 153 targets that each retain only a few bytes.
const site = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{ readonly origin: string; readonly close: () => void }>((resolve) => {
        const server = createServer((_request, response) => {
          response.writeHead(200, { "content-type": "text/html" });
          response.end(
            `<!doctype html><form>${lists
              .map(
                (list) =>
                  `<select multiple size=4 aria-label="List ${String(list)}">${choices
                    .map(
                      (choice) =>
                        `<option value="${String(choice)}">${String(list)}-${String(choice)}</option>`,
                    )
                    .join("")}</select>`,
              )
              .join("")}</form><output id=count></output><script>
document.addEventListener("change", () => {
  count.textContent = String(document.querySelectorAll("option:checked").length);
});</script>`,
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

const descriptor = (kind: "select" | "other", label: string) =>
  ({ _tag: "Descriptor", descriptor: { kind, label } }) as const;

it.live(
  "real CDP: a large group reserves what its targets retain, not a fixed worst case each",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { origin } = yield* site;
        const host = yield* externalChromium;

        const session = yield* Chromium.attach(host.endpoint, {
          policy: BrowserPolicy.unrestricted({ maxActions: 20, maxElapsedMillis: 120_000 }),
        });

        const page = session.initialPage;

        yield* page.navigate({ url: `${origin}/` });
        yield* page.run(
          {
            version: 1,
            steps: [
              {
                id: "pick",
                action: {
                  _tag: "FillForm",
                  fields: lists.map((list) => ({
                    _tag: "Options",
                    target: descriptor("select", `List ${String(list)}`),
                    options: choices.map((choice) =>
                      descriptor("other", `${String(list)}-${String(choice)}`),
                    ),
                  })),
                },
              },
            ],
          },
          { within: "90 seconds", timeoutMillis: 60_000 },
        );

        expect((yield* page.readText({ selector: "#count" })).text).toBe("150");
      }).pipe(Effect.provide(Chromium.layer({}).pipe(Layer.provide(NodeCrypto.layer)))),
    ),
);
