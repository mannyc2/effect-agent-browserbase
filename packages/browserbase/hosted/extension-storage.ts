// H3, narrowed: does chrome.storage.local survive into a later session on the same context?
// Worker restart, other storage areas and flush timing stay open. The extension and context
// are disposable and are deleted afterwards whatever happens.
import { randomUUID } from "node:crypto";

import { Effect, Schema } from "effect";
import { NavigateRequest, ReadTextRequest } from "effect-browser/browser-data";
import {
  type ContextWriterBackend,
  withWriter,
  type WriterSettlementFacts,
} from "effect-browserbase/context-coordination";
import { BrowserbaseContexts } from "effect-browserbase/contexts";
import { BrowserbaseExtensions } from "effect-browserbase/extensions";
import { recipe } from "effect-browserbase/launch";

import { buildZip } from "../test/fixtures/Zip.ts";
import { hostedCase } from "./harness.ts";

const h = hostedCase("extension-storage");
const marker = randomUUID();
// As in context-durability, this is an observed settle wait, not a provider flush bound.
const settleMillis = 10_000;

const archive = buildZip([
  {
    name: "manifest.json",
    content: JSON.stringify({
      manifest_version: 3,
      name: "effect-agent hosted storage probe",
      version: "1.0",
      permissions: ["storage"],
      content_scripts: [
        { matches: ["https://example.com/*"], js: ["probe.js"], run_at: "document_end" },
      ],
    }),
  },
  {
    name: "probe.js",
    content: `(async () => {
  const write = new URLSearchParams(location.search).get("effect-agent-write");
  if (write !== null) await chrome.storage.local.set({ "effect-agent-probe": write });
  const stored = (await chrome.storage.local.get("effect-agent-probe"))["effect-agent-probe"] ?? null;
  const out = document.createElement("pre");
  out.id = "effect-agent-extension-storage";
  out.textContent = JSON.stringify({ stored });
  document.body.append(out);
})();`,
  },
]);

if (archive.byteLength > h.budget.transferBytes)
  throw new Error("The probe archive is over budget");

const Seen = Schema.fromJsonString(Schema.Struct({ stored: Schema.NullOr(Schema.String) }));

const observe = Effect.fnUntraced(function* (url: string) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const session = yield* h.open();
      const page = session.initialPage;

      yield* page.navigate(NavigateRequest.make({ url }));
      yield* page.waitFor({ selector: "#effect-agent-extension-storage", state: "attached" });

      const { text } = yield* page.readText(
        ReadTextRequest.make({ selector: "#effect-agent-extension-storage" }),
      );

      const seen = yield* Schema.decodeEffect(Seen)(text);
      const cleanup = yield* session.closeChecked;

      return { stored: seen.stored === marker, cleanup };
    }),
  );
});

// This probe is the only writer of its fresh context; a shared context needs a distributed lease.
const backend: ContextWriterBackend<never, never> = {
  acquire: () =>
    Effect.succeed({ settle: (facts: WriterSettlementFacts) => h.report("writer-settled", facts) }),
};

await h.run(
  Effect.gen(function* () {
    const extensions = yield* BrowserbaseExtensions;
    const registered = yield* extensions.register(archive, { maxBytes: h.budget.transferBytes });

    yield* h.report("registered", registered);

    return yield* Effect.gen(function* () {
      const contexts = yield* BrowserbaseContexts;
      const { reference } = yield* contexts.create();

      yield* h.report("context-created", reference);

      return yield* Effect.gen(function* () {
        let readback: Effect.Success<ReturnType<typeof observe>> | undefined;

        const written = yield* withWriter(
          backend,
          reference,
          (permit) =>
            observe(`https://example.com/?effect-agent-write=${marker}`).pipe(
              Effect.tap((seen) => h.established({ written: seen.stored })),
              Effect.provide(
                h.browser({
                  launch: recipe({
                    context: { reference, persist: true },
                    extension: registered.reference,
                  }),
                  contextWriter: permit,
                }),
              ),
            ),
          {
            // The readback stays inside verify so the writer settles released, not quarantined.
            verify: () =>
              Effect.gen(function* () {
                yield* Effect.sleep(settleMillis);

                const seen = yield* observe("https://example.com/").pipe(
                  Effect.provide(
                    h.browser({
                      launch: recipe({
                        context: { reference, persist: false },
                        extension: registered.reference,
                      }),
                    }),
                  ),
                );

                readback = seen;
                if (!seen.stored)
                  return yield* Effect.fail({ _tag: "StorageNotReadBack" as const });
              }),
          },
        );

        yield* h.established({ written: written.stored, readBack: readback?.stored === true });

        return { settleMillis, written, readback };
      }).pipe(
        Effect.ensuring(
          contexts.delete(reference).pipe(
            Effect.tapError((error) => h.report("context-delete-failed", error)),
            Effect.ignore,
          ),
        ),
      );
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
