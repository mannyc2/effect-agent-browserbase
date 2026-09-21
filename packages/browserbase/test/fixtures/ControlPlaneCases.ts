import assert from "node:assert/strict";

import { Effect, Layer, Redacted } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import { BrowserbaseClient } from "../../src/Client.ts";
import { BrowserbaseContexts } from "../../src/Contexts.ts";
import { BrowserbaseSessions } from "../../src/Sessions.ts";
import { ContextReference, SessionReference } from "../../src/References.ts";

const account = {
  projectId: "project-1",
  apiKey: Redacted.make("test-account-key"),
};

const sessionReference = SessionReference.make({
  provider: "browserbase",
  projectId: "project-1",
  sessionId: "session-1",
});

const contextReference = ContextReference.make({
  provider: "browserbase",
  projectId: "project-1",
  contextId: "context-1",
});

const providerSession = (status: "PENDING" | "RUNNING" | "ERROR" | "TIMED_OUT" | "COMPLETED") => ({
  id: "session-1",
  projectId: "project-1",
  status,
  createdAt: "2026-09-20T19:00:00.000Z",
  updatedAt: "2026-09-20T19:01:00.000Z",
  expiresAt: "2026-09-20T20:00:00.000Z",
  startedAt: "2026-09-20T19:00:01.000Z",
  keepAlive: true,
  proxyBytes: 0,
  region: "us-east-1" as const,
});

const resourceLayer = Layer.merge(BrowserbaseSessions.layer, BrowserbaseContexts.layer).pipe(
  Layer.provide(BrowserbaseClient.layer(account)),
);

export const controlPlaneCases = [
  {
    name: "one immutable Client captures account authority and does no work during construction",
    run: Effect.gen(function* () {
      let requests = 0;
      const options = {
        ...account,
        artifactOrigins: ["https://media.example.test"],
      };
      const fetch: typeof globalThis.fetch = async (input, init) => {
        requests++;
        const request = new Request(input, init);
        assert.equal(request.headers.get("x-bb-api-key"), "test-account-key");
        return Response.json(providerSession("COMPLETED"));
      };

      yield* Effect.gen(function* () {
        const client = yield* BrowserbaseClient;
        assert.equal(requests, 0);
        assert.equal(client.projectId, "project-1");
        assert.equal(Object.isFrozen(client), true);
        options.artifactOrigins.push("https://other.example.test");
        assert.equal(client.validateMediaUrl("https://media.example.test/file"), true);
        assert.equal(client.validateMediaUrl("https://other.example.test/file"), false);
        yield* client.json("GET", "/v1/sessions/session-1");
        assert.equal(requests, 1);
      }).pipe(
        Effect.provide(BrowserbaseClient.layer(options)),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      );
    }),
  },
  {
    name: "Sessions separates passive inspection from explicit release",
    run: Effect.gen(function* () {
      const requests: Array<{ readonly method: string; readonly path: string; readonly body: unknown }> = [];
      const fetch: typeof globalThis.fetch = async (input, init) => {
        const request = new Request(input, init);
        const body = request.method === "POST" ? await request.json() : undefined;
        const url = new URL(request.url);
        requests.push({ method: request.method, path: `${url.pathname}${url.search}`, body });
        if (url.pathname === "/v1/sessions" && request.method === "GET") {
          return Response.json([providerSession("RUNNING")]);
        }
        return Response.json(providerSession(request.method === "POST" ? "COMPLETED" : "RUNNING"));
      };

      yield* Effect.gen(function* () {
        const sessions = yield* BrowserbaseSessions;
        const inspected = yield* sessions.retrieve(sessionReference);
        assert.equal(inspected.status, "RUNNING");
        assert.deepEqual(requests.map(({ method }) => method), ["GET"]);

        const listed = yield* sessions.list({ status: "RUNNING", q: "user:42" });
        assert.equal(listed.length, 1);
        assert.match(requests[1]!.path, /^\/v1\/sessions\?/);
        assert.equal(requests[1]!.method, "GET");

        const released = yield* sessions.requestRelease(sessionReference);
        assert.equal(released.status, "COMPLETED");
        assert.deepEqual(requests[2], {
          method: "POST",
          path: "/v1/sessions/session-1",
          body: { projectId: "project-1", status: "REQUEST_RELEASE" },
        });
      }).pipe(
        Effect.provide(resourceLayer),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      );
    }),
  },
  {
    name: "Contexts provision, inspect and explicitly delete project-qualified resources",
    run: Effect.gen(function* () {
      const requests: Array<{ readonly method: string; readonly path: string; readonly body: unknown }> = [];
      const fetch: typeof globalThis.fetch = async (input, init) => {
        const request = new Request(input, init);
        const body = request.method === "POST" ? await request.json() : undefined;
        const path = new URL(request.url).pathname;
        requests.push({ method: request.method, path, body });
        if (request.method === "POST") {
          return Response.json({
            id: "context-1",
            cipherAlgorithm: "AES-256-CBC",
            initializationVectorSize: 16,
            publicKey: "not-consumer-state",
            uploadUrl: "https://deprecated.invalid",
          });
        }
        if (request.method === "DELETE") return new Response(null, { status: 204 });
        return Response.json({
          id: "context-1",
          projectId: "project-1",
          createdAt: "2026-09-20T18:00:00.000Z",
          updatedAt: "2026-09-20T19:00:00.000Z",
          name: "support-account-42",
        });
      };

      yield* Effect.gen(function* () {
        const contexts = yield* BrowserbaseContexts;
        const created = yield* contexts.create({ name: "support-account-42" });
        assert.deepEqual(created.reference, contextReference);
        const metadata = yield* contexts.retrieve(created.reference);
        assert.equal(metadata.name, "support-account-42");
        yield* contexts.delete(created.reference);
        assert.deepEqual(requests, [
          {
            method: "POST",
            path: "/v1/contexts",
            body: { projectId: "project-1", name: "support-account-42" },
          },
          { method: "GET", path: "/v1/contexts/context-1", body: undefined },
          { method: "DELETE", path: "/v1/contexts/context-1", body: undefined },
        ]);
      }).pipe(
        Effect.provide(resourceLayer),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      );
    }),
  },
  {
    name: "resource services reject foreign project identities before transport",
    run: Effect.gen(function* () {
      let requests = 0;
      const foreignSession = SessionReference.make({ ...sessionReference, projectId: "project-2" });
      const foreignContext = ContextReference.make({ ...contextReference, projectId: "project-2" });

      yield* Effect.gen(function* () {
        const sessions = yield* BrowserbaseSessions;
        const contexts = yield* BrowserbaseContexts;
        for (const effect of [sessions.retrieve(foreignSession).pipe(Effect.result), contexts.retrieve(foreignContext).pipe(Effect.result)]) {
          const result = yield* effect;
          assert.equal(result._tag, "Failure");
          if (result._tag === "Failure") {
            assert.equal(result.failure.reason, "authorization");
            assert.equal(result.failure.outcome, "undispatched");
          }
        }
        assert.equal(requests, 0);
      }).pipe(
        Effect.provide(resourceLayer),
        Effect.provideService(FetchHttpClient.Fetch, async () => {
          requests++;
          return Response.json({});
        }),
      );
    }),
  },
];
