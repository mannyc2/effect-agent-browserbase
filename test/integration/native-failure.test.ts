import { expect, it } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { BrowserError, BrowserOperation, Reasons } from "effect-browser/errors";
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

import { fromNativeAttempt } from "../../packages/browser/src/internal/browser/Binding.ts";
import type { Driver } from "../../packages/browser/src/internal/browser/Driver.ts";
import {
  failure,
  publicError,
  safeDecode,
  sanitize,
} from "../../packages/browser/src/internal/browser/NativeCalls.ts";
import { makeOwner, native } from "../../packages/browser/src/internal/browser/Owner.ts";
import { BrowserbaseClient } from "../../packages/browserbase/src/Client.ts";
import { elapse } from "./fixtures/Time.ts";

const limits = {
  maxActions: 10,
  maxHostReads: 10_000,
  maxElapsedMillis: 60_000,
  actionTimeoutMillis: 1000,
};

it("an operation is a closed vocabulary, so a misspelling is refused rather than merely compiled", () => {
  expect(Schema.is(BrowserOperation)("navigate")).toBe(true);
  for (const drifted of ["navigation", "capture-source", "target-count", "", "PRIVATE"])
    expect(Schema.is(BrowserOperation)(drifted)).toBe(false);
  expect(() =>
    Schema.decodeUnknownSync(BrowserError)({
      _tag: "BrowserError",
      operation: "target-count",
      reason: Reasons.Malformed.make({}),
      outcome: "undispatched",
    }),
  ).toThrow(Schema.SchemaError);
});

it("a native failure keeps its reason and outcome and takes the caller's operation", () => {
  const fallback = { reason: Reasons.Provider.make({}), outcome: "unknown" } as const;

  expect(
    publicError(failure(Reasons.NotFound.make({}), "undispatched"), "click", fallback),
  ).toMatchObject({
    _tag: "BrowserError",
    operation: "click",
    reason: { _tag: "NotFound" },
    outcome: "undispatched",
  });

  // The native reason keeps its measured fields and takes required outcome evidence from the owner.
  const limited = publicError(
    failure(Reasons.Limit.make({ dimension: "returned-bytes", maximum: 10, observed: 11 })),
    "observe",
    fallback,
  );

  expect(limited).toMatchObject({
    reason: { _tag: "Limit", dimension: "returned-bytes", maximum: 10, observed: 11 },
    outcome: "unknown",
  });

  // A fenced ticket already speaks publicly, and keeps the operation the owner gave it.
  const fenced = BrowserError.make({
    operation: "fill",
    reason: Reasons.Stale.make({}),
    outcome: "unknown",
  });

  expect(publicError(fenced, "click", fallback)).toBe(fenced);
  // Anything else, a raw native exception included, is only ever the caller's fallback.
  expect(publicError(new Error("PRIVATE-NATIVE-TEXT"), "navigate", fallback)).toMatchObject({
    operation: "navigate",
    reason: { _tag: "Provider" },
    outcome: "unknown",
  });
});

it("no raw native exception crosses the private boundary, and a typed one passes unchanged", async () => {
  await expect(sanitize(() => Promise.reject(new Error("PRIVATE")))).rejects.toMatchObject({
    _tag: "NativeFailure",
    reason: { _tag: "Provider" },
  });
  const typed = failure(Reasons.Ambiguous.make({}), "undispatched");

  const fenced = BrowserError.make({
    operation: "wait",
    reason: Reasons.Stale.make({}),
    outcome: "undispatched",
  });

  await expect(sanitize(() => Promise.reject(typed))).rejects.toBe(typed);
  await expect(sanitize(() => Promise.reject(fenced))).rejects.toBe(fenced);
  expect(() => safeDecode(Schema.Natural, -1)).toThrow(
    expect.objectContaining({ _tag: "NativeFailure", reason: { _tag: "Malformed" } }),
  );
});

it.effect("the owner stamps the admitted operation on whatever the native step raised", () =>
  Effect.gen(function* () {
    const owner = yield* makeOwner(limits);

    owner.state.phase = "open";

    const refused = yield* owner
      .guard("select-files", (ticket) =>
        native("select-files", ticket, () =>
          Promise.reject(failure(Reasons.Unsupported.make({}), "undispatched")),
        ),
      )
      .pipe(Effect.flip);

    expect(refused).toMatchObject({
      _tag: "BrowserError",
      operation: "select-files",
      reason: { _tag: "Unsupported" },
      outcome: "undispatched",
    });

    // Once dispatched, a step that knows nothing about its outcome is unknown, not undispatched.
    const lost = yield* owner
      .guard(
        "navigate",
        (ticket) =>
          native("navigate", ticket, () => {
            ticket.dispatch();

            return Promise.reject(new Error("PRIVATE"));
          }),
        { mutation: true },
      )
      .pipe(Effect.flip);

    expect(lost).toMatchObject({
      operation: "navigate",
      reason: { _tag: "Provider" },
      outcome: "unknown",
    });
  }),
);

it.effect("a refused connection keeps the reason the native attempt gave", () =>
  Effect.gen(function* () {
    const request = {
      connection: "wss://connect.browserbase.com/?session=1",
      identity: { namespace: "connection", bindings: "bindings" },
      options: {
        viewport: { width: 640, height: 480 },
        popupPolicy: "retain",
        dialogPolicy: "dismiss",
        maxPages: 4,
      },
      events: { invalidate: () => {}, disconnected: () => {}, pause: () => {}, fault: () => {} },
      onAbandoned: () => {},
      onSettled: () => {},
    } as const;

    const attempt = (raised: unknown) =>
      fromNativeAttempt(() => Promise.reject<Driver>(raised))
        .connect(request)
        .pipe(Effect.flip);

    // Two pages where one was required is "ambiguous", never a generic provider failure.
    expect(yield* attempt(failure(Reasons.Ambiguous.make({})))).toMatchObject({
      _tag: "BrowserError",
      operation: "connect",
      reason: { _tag: "Ambiguous" },
    });
    expect(yield* attempt(new Error("PRIVATE"))).toMatchObject({
      operation: "connect",
      reason: { _tag: "Provider" },
    });
  }),
);

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
