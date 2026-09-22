// H1, narrowed: does state a persisting session writes come back in a later session on the
// same context? One session writes a cookie and a localStorage marker and ends; a second,
// non-persisting session reads them back. The context is disposable and is deleted afterwards
// whatever happens.
import { randomUUID } from "node:crypto";

import { Effect } from "effect";
import * as Bootstrap from "effect-browser/bootstrap";
import { NavigateRequest, ReadTextRequest } from "effect-browser/browser-data";
import {
  type ContextWriterBackend,
  withWriter,
  type WriterSettlementFacts,
} from "effect-browserbase/context-coordination";
import { BrowserbaseContexts } from "effect-browserbase/contexts";
import { recipe } from "effect-browserbase/launch";

import { hostedCase } from "./harness.ts";

const h = hostedCase("context-durability");

const origin = "https://example.com";
const marker = randomUUID();
// The provider persists a context after the writing session ends, with no documented
// acknowledgement. The readback waits this long and reports it rather than polling for success.
const settleMillis = 10_000;

const write = Bootstrap.init({
  id: "durability-write",
  origins: [origin],
  content: `localStorage.setItem("effect-agent-probe", ${JSON.stringify(marker)});
document.cookie = "effect-agent-probe=${marker}; Max-Age=3600; Path=/; Secure; SameSite=Lax";`,
});

// Readback renders what the document can see, so it is read like any other page text.
const read = Bootstrap.init({
  id: "durability-read",
  origins: [origin],
  content: `document.addEventListener("DOMContentLoaded", () => {
  const cookie = document.cookie.split("; ").find((item) => item.startsWith("effect-agent-probe="));
  const out = document.createElement("pre");
  out.id = "effect-agent-probe";
  out.textContent = JSON.stringify({
    storage: localStorage.getItem("effect-agent-probe"),
    cookie: cookie === undefined ? null : cookie.slice("effect-agent-probe=".length),
  });
  document.body.append(out);
});`,
});

const observe = (bootstrap: Bootstrap.Plan<never, never>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const session = yield* h.open({ bootstrap });
      const target = session;

      yield* target.navigate(NavigateRequest.make({ url: `${origin}/` }));

      const { text } = yield* target.readText(
        ReadTextRequest.make({ selector: "#effect-agent-probe" }),
      );

      const seen = JSON.parse(text) as { storage: unknown; cookie: unknown };
      const cleanup = yield* session.close;

      return {
        reference: session.reference,
        storage: seen.storage === marker,
        cookie: seen.cookie === marker,
        cleanup,
      };
    }),
  );

// This probe is the only writer of a context it created moments ago, so an in-process lease is
// enough. A shared context needs a real distributed lease that retains quarantine facts.
const backend: ContextWriterBackend<never, never> = {
  acquire: () =>
    Effect.succeed({
      settle: (facts: WriterSettlementFacts) => h.report("writer-settled", facts),
    }),
};

await h.run(
  Effect.gen(function* () {
    const contexts = yield* BrowserbaseContexts;
    const { reference } = yield* contexts.create();

    yield* h.report("context-created", reference);

    return yield* Effect.gen(function* () {
      let readback: Effect.Success<ReturnType<typeof observe>> | undefined;

      // The readback runs while the writer lease is still held, which is what lets the writer
      // settle as released rather than quarantined, and so lets the context be deleted.
      const written = yield* withWriter(
        backend,
        reference,
        (permit) =>
          observe(Bootstrap.combine(write, read)).pipe(
            Effect.provide(
              h.browser({
                launch: recipe({ context: { reference, persist: true } }),
                contextWriter: permit,
              }),
            ),
          ),
        {
          verify: () =>
            Effect.gen(function* () {
              yield* Effect.sleep(settleMillis);

              const seen = yield* observe(read).pipe(
                Effect.provide(
                  h.browser({
                    launch: recipe({ context: { reference, persist: false } }),
                  }),
                ),
              );

              readback = seen;
              if (!seen.storage || !seen.cookie) {
                return yield* Effect.fail({ _tag: "MarkersNotReadBack" as const });
              }
            }),
        },
      );

      yield* h.established({ written: written.storage && written.cookie });

      return { settleMillis, written, readback };
    }).pipe(
      Effect.ensuring(
        contexts.delete(reference).pipe(
          Effect.tapError((error) => h.report("context-delete-failed", error)),
          Effect.ignore,
        ),
      ),
    );
  }),
);
