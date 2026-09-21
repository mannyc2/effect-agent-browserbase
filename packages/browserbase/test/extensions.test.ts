import assert from "node:assert/strict";

import { it } from "@effect/vitest";
import { Effect, Layer, Redacted } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import { BrowserbaseClient } from "../src/Client.ts";
import { BrowserbaseExtensions } from "../src/Extensions.ts";
import { ExtensionReference } from "../src/References.ts";

const account = { projectId: "project-1", apiKey: Redacted.make("extension-test-key") };
const layer = BrowserbaseExtensions.layer.pipe(Layer.provide(BrowserbaseClient.layer(account)));

const concat = (...parts: ReadonlyArray<Uint8Array>) => {
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
};

const zip = (entries: ReadonlyArray<readonly [string, string]>) => {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let localOffset = 0;

  for (const [name, text] of entries) {
    const nameBytes = encoder.encode(name);
    const body = encoder.encode(text);
    const local = new Uint8Array(30);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint32(18, body.byteLength, true);
    lv.setUint32(22, body.byteLength, true);
    lv.setUint16(26, nameBytes.byteLength, true);
    locals.push(local, nameBytes, body);

    const central = new Uint8Array(46);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint32(20, body.byteLength, true);
    cv.setUint32(24, body.byteLength, true);
    cv.setUint16(28, nameBytes.byteLength, true);
    cv.setUint32(42, localOffset, true);
    centrals.push(central, nameBytes);
    localOffset += local.byteLength + nameBytes.byteLength + body.byteLength;
  }

  const localBytes = concat(...locals);
  const centralBytes = concat(...centrals);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralBytes.byteLength, true);
  ev.setUint32(16, localBytes.byteLength, true);

  return concat(localBytes, centralBytes, end);
};

const archive = zip([
  ["manifest.json", '{"manifest_version":3,"name":"fixture","version":"1.0.0"}'],
  ["content.js", "globalThis.__fixture = true;"],
]);

const providerExtension = {
  id: "extension-1",
  projectId: "project-1",
  fileName: "extension.zip",
  createdAt: "2026-09-21T00:00:00.000Z",
  updatedAt: "2026-09-21T00:00:00.000Z",
};

const run = <A, E, R>(effect: Effect.Effect<A, E, R>, fetch: typeof globalThis.fetch) =>
  effect.pipe(Effect.provide(layer), Effect.provideService(FetchHttpClient.Fetch, fetch));

it.effect("uploads one bounded ZIP as multipart and returns durable qualified identity", () => {
  let requests = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    requests++;
    const request = new Request(input, init);

    assert.equal(request.method, "POST");
    assert.equal(new URL(request.url).pathname, "/v1/extensions");
    assert.equal(request.headers.get("x-bb-api-key"), "extension-test-key");
    assert.match(request.headers.get("content-type") ?? "", /^multipart\/form-data; boundary=/);
    const form = await request.formData();
    const file = form.get("file");

    assert.ok(file instanceof Blob);
    const uploaded = file as File;
    assert.equal(uploaded.name, "extension.zip");
    assert.deepEqual(new Uint8Array(await uploaded.arrayBuffer()), archive);

    return Response.json(providerExtension);
  };

  return run(
    Effect.gen(function* () {
      const extensions = yield* BrowserbaseExtensions;
      const created = yield* extensions.create({ fileName: "extension.zip", bytes: archive });

      assert.equal(requests, 1);
      assert.deepEqual(created.reference, {
        provider: "browserbase",
        projectId: "project-1",
        extensionId: "extension-1",
      });
      assert.equal(created.fileName, "extension.zip");
    }),
    fetch,
  );
});

it.effect("retrieve and delete require the same project-qualified extension identity", () => {
  const calls: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    calls.push(`${request.method} ${new URL(request.url).pathname}`);
    return request.method === "DELETE"
      ? new Response(null, { status: 204 })
      : Response.json(providerExtension);
  };
  const reference = ExtensionReference.make({
    provider: "browserbase",
    projectId: "project-1",
    extensionId: "extension-1",
  });

  return run(
    Effect.gen(function* () {
      const extensions = yield* BrowserbaseExtensions;
      const value = yield* extensions.retrieve(reference);
      assert.equal(value.reference.extensionId, "extension-1");
      yield* extensions.delete(reference);
      assert.deepEqual(calls, [
        "GET /v1/extensions/extension-1",
        "DELETE /v1/extensions/extension-1",
      ]);
    }),
    fetch,
  );
});

it.effect("foreign extension references fail before transport", () => {
  let requests = 0;
  const reference = ExtensionReference.make({
    provider: "browserbase",
    projectId: "project-2",
    extensionId: "extension-1",
  });

  return run(
    Effect.gen(function* () {
      const extensions = yield* BrowserbaseExtensions;
      for (const action of [extensions.retrieve(reference), extensions.delete(reference)]) {
        const result = yield* action.pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.equal(result.failure.reason, "authorization");
          assert.equal(result.failure.outcome, "undispatched");
        }
      }
      assert.equal(requests, 0);
    }),
    async () => {
      requests++;
      return Response.json({});
    },
  );
});

it.effect("ZIP traversal and missing root manifest are rejected before upload", () => {
  let requests = 0;
  return run(
    Effect.gen(function* () {
      const extensions = yield* BrowserbaseExtensions;
      for (const bytes of [
        zip([
          ["manifest.json", "{}"],
          ["../escape.js", "bad"],
        ]),
        zip([["nested/manifest.json", "{}"]]),
      ]) {
        const result = yield* extensions
          .create({ fileName: "extension.zip", bytes })
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.equal(result.failure.reason, "configuration");
          assert.equal(result.failure.outcome, "undispatched");
        }
      }
      assert.equal(requests, 0);
    }),
    async () => {
      requests++;
      return Response.json(providerExtension);
    },
  );
});

it.effect("uncertain multipart failure is never automatically replayed", () => {
  let requests = 0;
  return run(
    Effect.gen(function* () {
      const extensions = yield* BrowserbaseExtensions;
      const result = yield* extensions
        .create({ fileName: "extension.zip", bytes: archive })
        .pipe(Effect.result);

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

it.effect("known rate-limit rejection stays rejected and is not retried", () => {
  let requests = 0;
  return run(
    Effect.gen(function* () {
      const extensions = yield* BrowserbaseExtensions;
      const result = yield* extensions
        .create({ fileName: "extension.zip", bytes: archive })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure.reason, "rate-limited");
        assert.equal(result.failure.outcome, "rejected");
        assert.equal(result.failure.status, 429);
        assert.equal(result.failure.retryAfterMillis, 2000);
      }
      assert.equal(requests, 1);
    }),
    async () => {
      requests++;
      return Response.json(
        { error: "private" },
        { status: 429, headers: { "retry-after": "2" } },
      );
    },
  );
});
