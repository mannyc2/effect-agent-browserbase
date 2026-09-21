import assert from "node:assert/strict";

import { it } from "@effect/vitest";
import { Effect, Layer, Redacted } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import { BrowserbaseClient } from "../src/Client.ts";
import { BrowserbaseExtensions } from "../src/Extensions.ts";
import { compileLaunch } from "../src/internal/provider/Launch.ts";
import { extensionArchive } from "./fixtures/Zip.ts";

const account = { projectId: "project-1", apiKey: Redacted.make("extension-test-key") };
const layer = BrowserbaseExtensions.layer.pipe(Layer.provide(BrowserbaseClient.layer(account)));

const archive = extensionArchive([{ name: "content.js", content: "globalThis.__fixture = true;" }]);

const providerExtension = {
  id: "extension-1",
  projectId: "project-1",
  fileName: "extension.zip",
  createdAt: "2026-09-21T00:00:00.000Z",
  updatedAt: "2026-09-21T00:00:00.000Z",
};

const run = <A, E, R>(effect: Effect.Effect<A, E, R>, fetch: typeof globalThis.fetch) =>
  effect.pipe(Effect.provide(layer), Effect.provideService(FetchHttpClient.Fetch, fetch));

it.effect("uploads once and reuses the durable qualified reference at launch", () => {
  let requests = 0;

  const fetch: typeof globalThis.fetch = async (input, init) => {
    requests++;
    const request = new Request(input, init);

    assert.equal(request.method, "POST");
    assert.equal(new URL(request.url).pathname, "/v1/extensions");
    assert.equal(request.headers.get("x-bb-api-key"), "extension-test-key");
    assert.match(request.headers.get("content-type") ?? "", /^multipart\/form-data; boundary=/);
    const file = (await request.formData()).get("file");

    assert.ok(file instanceof File);
    assert.equal(file.name, "extension.zip");
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), archive);

    return Response.json(providerExtension);
  };

  return run(
    Effect.gen(function* () {
      const extensions = yield* BrowserbaseExtensions;
      const registered = yield* extensions.register(archive);

      assert.deepEqual(
        { ...registered.reference },
        { provider: "browserbase", projectId: "project-1", extensionId: "extension-1" },
      );

      const compiled = yield* compileLaunch(
        {
          remoteTimeoutSeconds: 60,
          extension: registered.reference,
          viewport: { _tag: "ProviderManaged" },
          provider: {},
        },
        { projectId: "project-1", attemptId: "attempt-extension", requestedAtMillis: 1 },
      );

      assert.deepEqual(
        (compiled.body as { readonly extensionId?: string }).extensionId,
        "extension-1",
      );
      assert.equal(requests, 1, "launch reuses the durable reference without another upload");
    }),
    fetch,
  );
});

it.effect("a lost reply to an accepted upload stays unknown and is never replayed", () => {
  let requests = 0;

  return run(
    Effect.gen(function* () {
      const extensions = yield* BrowserbaseExtensions;
      const result = yield* extensions.register(archive).pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure.reason, "transport");
        assert.equal(result.failure.outcome, "unknown");
      }
      assert.equal(requests, 1);
    }),
    async () => {
      requests++;
      throw new Error("response lost after dispatch");
    },
  );
});

it.effect("a known rate-limit rejection stays rejected and is not retried", () => {
  let requests = 0;

  return run(
    Effect.gen(function* () {
      const extensions = yield* BrowserbaseExtensions;
      const result = yield* extensions.register(archive).pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure.reason, "rate-limited");
        assert.equal(result.failure.outcome, "rejected");
        assert.equal(result.failure.status, 429);
        assert.equal(result.failure.retryAfterMillis, 2000);
        assert.equal(JSON.stringify(result.failure).includes("private"), false);
      }
      assert.equal(requests, 1);
    }),
    async () => {
      requests++;

      return Response.json({ error: "private" }, { status: 429, headers: { "retry-after": "2" } });
    },
  );
});
