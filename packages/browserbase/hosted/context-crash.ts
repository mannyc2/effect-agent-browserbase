// H1, narrowed to a crash: does state a persisting session wrote come back after the writer's
// process is killed without releasing its session? A child process runs the writer: it opens a
// persisting session on a fresh context, writes a cookie and a localStorage marker, reads them
// back in that document, says so and waits. The parent kills it with SIGKILL, waits until the
// provider reports that session terminal and then as long as context-durability waits after a
// release, and reads the markers from a non-persisting session on the same context. The context is disposable and is deleted afterwards.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { Clock, Effect, Schema } from "effect";
import * as Bootstrap from "effect-browser/bootstrap";
import type { AnySession } from "effect-browser/browser";
import { NavigateRequest, ReadTextRequest } from "effect-browser/browser-data";
import {
  type ContextWriterBackend,
  withWriter,
  type WriterSettlementFacts,
} from "effect-browserbase/context-coordination";
import { BrowserbaseContexts } from "effect-browserbase/contexts";
import { recipe } from "effect-browserbase/launch";
import { ContextReference, SessionReference } from "effect-browserbase/references";
import { BrowserbaseSessions } from "effect-browserbase/sessions";

import { hostedCase } from "./harness.ts";

const h = hostedCase("context-crash");

const origin = "https://example.com";
// The writer's provider lifetime: the latest the provider can end a session nobody releases.
const writerTimeoutSeconds = 120;
// The provider persists a context after its session ends, with no documented acknowledgement.
// As in context-durability, the readback waits this long after the session is terminal.
const settleMillis = 10_000;

const probe = Bootstrap.init({
  id: "crash-read",
  origins: [origin],
  content: `document.addEventListener("DOMContentLoaded", () => {
  const cookie = document.cookie.split("; ").find((item) => item.startsWith("effect-agent-crash="));
  const out = document.createElement("pre");
  out.id = "effect-agent-crash";
  out.textContent = JSON.stringify({
    storage: localStorage.getItem("effect-agent-crash"),
    cookie: cookie === undefined ? null : cookie.slice("effect-agent-crash=".length),
  });
  document.body.append(out);
});`,
});

const writing = (marker: string) =>
  Bootstrap.init({
    id: "crash-write",
    origins: [origin],
    content: `localStorage.setItem("effect-agent-crash", ${JSON.stringify(marker)});
document.cookie = "effect-agent-crash=${marker}; Max-Age=3600; Path=/; Secure; SameSite=Lax";`,
  });

const Seen = Schema.fromJsonString(
  Schema.Struct({ storage: Schema.NullOr(Schema.String), cookie: Schema.NullOr(Schema.String) }),
);

const read = Effect.fnUntraced(function* (session: AnySession) {
  yield* session.navigate(NavigateRequest.make({ url: `${origin}/` }));

  const { text } = yield* session.readText(
    ReadTextRequest.make({ selector: "#effect-agent-crash" }),
  );

  return yield* Schema.decodeEffect(Seen)(text);
});

// The writer holds an in-process lease that the kill leaves unsettled, as a crashed host would.
const backend: ContextWriterBackend<never, never> = {
  acquire: () =>
    Effect.succeed({
      settle: (facts: WriterSettlementFacts) => h.report("writer-settled", facts),
    }),
};

/** The child: write, confirm in the same document, report, and wait to be killed. */
const writer = (reference: ContextReference, marker: string) =>
  withWriter(backend, reference, (permit) =>
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* h.open({ bootstrap: Bootstrap.combine(writing(marker), probe) });
        const seen = yield* read(session);

        yield* h.report("written", {
          session: session.reference,
          storage: seen.storage === marker,
          cookie: seen.cookie === marker,
        });

        return yield* Effect.never;
      }),
    ).pipe(
      Effect.provide(
        h.browser({
          launch: recipe({
            context: { reference, persist: true },
            remoteTimeoutSeconds: writerTimeoutSeconds,
          }),
          contextWriter: permit,
        }),
      ),
    ),
  );

const Written = Schema.fromJsonString(
  Schema.Struct({
    check: Schema.Literal("context-crash"),
    phase: Schema.Literal("written"),
    result: Schema.Struct({
      session: SessionReference,
      storage: Schema.Boolean,
      cookie: Schema.Boolean,
    }),
  }),
);

interface Killed {
  readonly written: typeof Written.Type.result;
  readonly signal: string | null;
  /** From the writer's report to its process exiting after SIGKILL. */
  readonly exitAfterMillis: number;
}

/**
 * Run the writer as a child and kill it once it reports the write. Its records are passed
 * through, so its allocation counts against this check's session budget.
 */
const killWriter = (reference: ContextReference, marker: string) =>
  Effect.callback<Killed, { readonly _tag: "WriterEnded"; readonly code: number | null }>(
    (resume) => {
      const child = spawn(
        process.execPath,
        [fileURLToPath(import.meta.url), "writer", JSON.stringify(reference), marker],
        { stdio: ["ignore", "pipe", "inherit"] },
      );

      let written: typeof Written.Type.result | undefined;
      let reportedAt = 0;

      createInterface({ input: child.stdout }).on("line", (line) => {
        console.log(line);
        const decoded = Schema.decodeOption(Written)(line);

        if (written === undefined && decoded._tag === "Some") {
          written = decoded.value.result;
          reportedAt = performance.now();
          child.kill("SIGKILL");
        }
      });
      child.once("exit", (code, signal) => {
        resume(
          written === undefined
            ? Effect.fail({ _tag: "WriterEnded" as const, code })
            : Effect.succeed({
                written,
                signal,
                exitAfterMillis: performance.now() - reportedAt,
              }),
        );
      });

      return Effect.sync(() => {
        child.kill("SIGKILL");
      });
    },
  );

const parent = Effect.gen(function* () {
  const contexts = yield* BrowserbaseContexts;
  const sessions = yield* BrowserbaseSessions;
  const { reference } = yield* contexts.create();
  const marker = randomUUID();

  yield* h.report("context-created", reference);

  return yield* Effect.gen(function* () {
    const killed = yield* killWriter(reference, marker);

    yield* h.report("killed", { signal: killed.signal, exitAfterMillis: killed.exitAfterMillis });
    const waitStarted = yield* Clock.currentTimeMillis;

    const terminal = yield* sessions.waitForTerminal(killed.written.session, {
      timeoutMillis: (writerTimeoutSeconds + 60) * 1000,
      pollIntervalMillis: 1000,
    });

    const terminalAfterMillis = (yield* Clock.currentTimeMillis) - waitStarted;

    yield* h.report("terminal", { status: terminal.status, afterMillis: terminalAfterMillis });
    yield* Effect.sleep(settleMillis);

    const readback = yield* Effect.scoped(
      Effect.gen(function* () {
        const session = yield* h.open({ bootstrap: probe });
        const seen = yield* read(session);

        return {
          storage: seen.storage === marker,
          cookie: seen.cookie === marker,
          cleanup: yield* session.close,
        };
      }),
    ).pipe(
      Effect.provide(h.browser({ launch: recipe({ context: { reference, persist: false } }) })),
    );

    yield* h.report("readback", readback);
    yield* h.established({
      "the writer saw its markers": killed.written.storage && killed.written.cookie,
      "the writer was killed": killed.signal === "SIGKILL",
      "the storage marker came back": readback.storage,
      "the cookie came back": readback.cookie,
    });

    return {
      killed: { signal: killed.signal, exitAfterMillis: killed.exitAfterMillis },
      terminal: { status: terminal.status, afterMillis: terminalAfterMillis },
      settleMillis,
      readback: { storage: readback.storage, cookie: readback.cookie },
    };
  }).pipe(
    Effect.ensuring(
      contexts.delete(reference).pipe(
        Effect.tapError((error) => h.report("context-delete-failed", error)),
        Effect.ignore,
      ),
    ),
  );
});

// The same file is the writer when the parent starts it with the context to write.
const [role, context, childMarker] = process.argv.slice(2);

if (role === "writer" && context !== undefined && childMarker !== undefined) {
  await h.run(
    Schema.decodeEffect(Schema.fromJsonString(ContextReference))(context).pipe(
      Effect.flatMap((reference) => writer(reference, childMarker)),
    ),
  );
} else {
  await h.run(parent);
}
