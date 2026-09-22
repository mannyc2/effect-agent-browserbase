// H3, narrowed: does a registered extension keep its identity, and does selecting it at launch
// actually load it? A minimal MV3 content script marks the page; reading the mark is the load
// receipt the provider does not give. Worker restart and extension storage stay open. The
// extension is deleted afterwards whatever happens.
import { randomUUID } from "node:crypto";

import { Effect } from "effect";
import { NavigateRequest, ReadTextRequest } from "effect-browser/browser-data";
import { BrowserbaseExtensions } from "effect-browserbase/extensions";
import { recipe } from "effect-browserbase/launch";

import { buildZip } from "../test/fixtures/Zip.ts";
import { hostedCase } from "./harness.ts";

const h = hostedCase("extension-identity");

const marker = randomUUID();

const archive = buildZip([
  {
    name: "manifest.json",
    content: JSON.stringify({
      manifest_version: 3,
      name: "effect-agent hosted probe",
      version: "1.0",
      content_scripts: [
        { matches: ["https://example.com/*"], js: ["probe.js"], run_at: "document_end" },
      ],
    }),
  },
  {
    name: "probe.js",
    content: `const out = document.createElement("pre");
out.id = "effect-agent-extension";
out.textContent = ${JSON.stringify(marker)};
document.body.append(out);`,
  },
]);

if (archive.byteLength > h.budget.transferBytes)
  throw new Error("The probe archive is over budget");

await h.run(
  Effect.gen(function* () {
    const extensions = yield* BrowserbaseExtensions;
    const registered = yield* extensions.register(archive, { maxBytes: h.budget.transferBytes });

    yield* h.report("registered", registered);

    return yield* Effect.gen(function* () {
      const retrieved = yield* extensions.retrieve(registered.reference);

      const loaded = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* h.open();

          yield* session.navigate(NavigateRequest.make({ url: "https://example.com/" }));
          yield* session.waitFor({ selector: "#effect-agent-extension", state: "attached" });

          const { text } = yield* session

            .readText(ReadTextRequest.make({ selector: "#effect-agent-extension" }));

          const cleanup = yield* session.close;

          return { reference: session.reference, marker: text === marker, cleanup };
        }).pipe(Effect.provide(h.browser({ launch: recipe({ extension: registered.reference }) }))),
      );

      yield* h.established({
        sameIdentity: retrieved.reference.extensionId === registered.reference.extensionId,
        loaded: loaded.marker,
      });

      return {
        registered,
        sameIdentity: retrieved.reference.extensionId === registered.reference.extensionId,
        loaded,
      };
    }).pipe(
      Effect.ensuring(
        extensions.delete(registered.reference).pipe(
          Effect.tapError((error) => h.report("extension-delete-failed", error)),
          Effect.ignore,
        ),
      ),
    );
  }),
);
