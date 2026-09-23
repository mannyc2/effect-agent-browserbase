import { expect, it } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import {
  ArtifactError,
  CertificateError,
  ClientError,
  ContextError,
  ExtensionError,
  FileError,
  PlatformError,
  ProjectError,
  SessionError,
} from "effect-browserbase/errors";
import { FetchHttpClient } from "effect/unstable/http";

import { BrowserbaseClient } from "../src/Client.ts";
import { elapse } from "./fixtures/Time.ts";

it("every control-plane error names only its own service's operations", () => {
  // One real operation per class, and the spellings that had drifted into the source.
  const cases = [
    [ClientError, "provider-read", ["provider-request", "live-view", "download"]],
    [SessionError, "session-retrieve", ["session", "context-create"]],
    [ContextError, "writer-settle", ["writer-flush", "session-wait"]],
    [ExtensionError, "extension-archive", ["extension-archive-limit", "extension-archive-name"]],
    [ProjectError, "project-usage", ["project"]],
    [CertificateError, "certificate-list", ["certificate"]],
    [FileError, "download-wait", ["downloads-wait", "recording-download"]],
    [ArtifactError, "replay-playlist", ["replay-download", "download"]],
  ] as const;

  for (const [error, real, drifted] of cases) {
    const operation = error.fields.operation;

    expect(Schema.is(operation)(real), `${error.name} ${real}`).toBe(true);
    for (const value of drifted)
      expect(Schema.is(operation)(value), `${error.name} ${value}`).toBe(false);
  }
  expect(Schema.is(PlatformError.fields.operation)("search-web")).toBe(true);
  expect(Schema.is(PlatformError.fields.operation)("search")).toBe(false);
});

it.effect("a request that times out is labelled like the same request failing any other way", () =>
  Effect.gen(function* () {
    // The reply never arrives; only the request's own abort settles it.
    const fetch: typeof globalThis.fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });

    const attempt = (method: "GET" | "POST") =>
      Effect.gen(function* () {
        const client = yield* BrowserbaseClient;

        return yield* elapse(client.json(method, "/v1/projects").pipe(Effect.flip), 1000);
      }).pipe(
        Effect.provide(
          BrowserbaseClient.layer({
            projectId: "project-1",
            apiKey: Redacted.make("fixture-key-not-a-credential"),
            requestTimeoutMillis: 50,
          }),
        ),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      );

    // It used to be `provider-request`, a name nothing else in the transport produced.
    expect(yield* attempt("GET")).toMatchObject({ operation: "provider-read", reason: "timeout" });
    expect(yield* attempt("POST")).toMatchObject({
      operation: "provider-mutation",
      reason: "timeout",
      outcome: "unknown",
    });
  }),
);
