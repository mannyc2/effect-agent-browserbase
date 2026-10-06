// The client against a fake Browserbase API on loopback, and the provider against a local Chromium
// that the fake API hands out as the session's CDP endpoint. Nothing reaches Browserbase.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Redacted } from "effect";
import { Browser } from "effect-browser/Browser";
import { FetchHttpClient } from "effect/http";
import { chromium } from "playwright-core";

import * as Browserbase from "../src/Browserbase.ts";
import { BrowserbaseClient, layer as clientLayer } from "../src/BrowserbaseClient.ts";

interface Received {
  readonly method: string;
  readonly url: string;
  readonly key: string | undefined;
  readonly body: unknown;
}

type Route = (request: Received) => {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
};

const listen = (handle: (request: IncomingMessage, response: ServerResponse) => void) =>
  Effect.acquireRelease(
    Effect.callback<Server>((resume) => {
      const server = createServer(handle);

      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) => Effect.callback<void>((resume) => void server.close(() => resume(Effect.void))),
  ).pipe(
    Effect.map((server) => ({
      server,
      origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    })),
  );

/** A fake API that answers with `route` and records every request it gets. */
const fakeApi = (route: Route) =>
  Effect.gen(function* () {
    const received: Array<Received> = [];

    const { origin } = yield* listen((request, response) => {
      let raw = "";

      request.on("data", (chunk: Buffer) => (raw += chunk.toString()));
      request.on("end", () => {
        const key = request.headers["x-bb-api-key"];

        const entry: Received = {
          method: request.method ?? "",
          url: request.url ?? "",
          key: typeof key === "string" ? key : undefined,
          body: raw === "" ? undefined : (JSON.parse(raw) as unknown),
        };

        received.push(entry);

        const answer =
          entry.key === "test-key"
            ? route(entry)
            : { status: 401, body: { message: "Invalid API key" } };

        response.writeHead(answer.status, {
          "content-type": "application/json",
          ...answer.headers,
        });
        response.end(answer.body === undefined ? "" : JSON.stringify(answer.body));
      });
    });

    const client = clientLayer({ apiKey: Redacted.make("test-key"), baseUrl: origin }).pipe(
      Layer.provide(FetchHttpClient.layer),
    );

    return { received, origin, client };
  });

const session = (id: string, connectUrl?: string) => ({
  id,
  status: "RUNNING",
  region: "us-west-2",
  keepAlive: false,
  createdAt: "2026-10-04T12:00:00.000Z",
  expiresAt: "2026-10-04T12:05:00.000Z",
  projectId: "project",
  proxyBytes: 0,
  ...(connectUrl === undefined ? {} : { connectUrl }),
});

const reasonOf = <A, E extends { readonly reason: { readonly _tag: string } }, R>(
  effect: Effect.Effect<A, E, R>,
) => Effect.flip(effect).pipe(Effect.map((error) => error.reason._tag));

describe("BrowserbaseClient", () => {
  it.live("creates, reads and releases sessions, with the key only in its header", () =>
    Effect.gen(function* () {
      const api = yield* fakeApi((request) =>
        request.method === "POST" && request.url === "/v1/sessions"
          ? { status: 201, body: session("s1", "wss://connect.example/s1?signingKey=secret") }
          : { status: 200, body: session("s1") },
      );

      yield* Effect.gen(function* () {
        const client = yield* BrowserbaseClient;

        const created = yield* client.createSession({
          browserSettings: { viewport: { width: 1280, height: 720 } },
        });

        assert.strictEqual(created.id, "s1");
        assert.isDefined(created.connectUrl);
        assert.isTrue(Redacted.isRedacted(created.connectUrl));
        assert.strictEqual(
          Redacted.value(created.connectUrl ?? Redacted.make("")),
          "wss://connect.example/s1?signingKey=secret",
        );
        assert.strictEqual((yield* client.getSession("s1")).status, "RUNNING");
        yield* client.releaseSession("s1");
      }).pipe(Effect.provide(api.client));

      assert.deepStrictEqual(
        api.received.map((request) => [request.method, request.url, request.key, request.body]),
        [
          [
            "POST",
            "/v1/sessions",
            "test-key",
            { browserSettings: { viewport: { width: 1280, height: 720 } } },
          ],
          ["GET", "/v1/sessions/s1", "test-key", undefined],
          ["POST", "/v1/sessions/s1", "test-key", { status: "REQUEST_RELEASE" }],
        ],
      );
    }),
  );

  it.live("maps refusals to reasons, and retries reads but not writes", () =>
    Effect.gen(function* () {
      let attempts = 0;

      const api = yield* fakeApi((request) => {
        if (request.url === "/v1/sessions/missing")
          return { status: 404, body: { message: "Session not found" } };
        if (request.url === "/v1/sessions/flaky") {
          attempts += 1;

          return attempts < 3
            ? { status: 503, body: { message: "busy" } }
            : { status: 200, body: session("flaky") };
        }
        if (request.url === "/v1/sessions")
          return { status: 429, body: { message: "Too many concurrent sessions" } };

        return { status: 500, body: { message: "broken" } };
      });

      yield* Effect.gen(function* () {
        const client = yield* BrowserbaseClient;
        const missing = yield* Effect.flip(client.getSession("missing"));

        assert.strictEqual(missing.reason._tag, "NotFound");
        assert.strictEqual(
          missing.message,
          "Browserbase getSession failed: not found: Session not found",
        );
        assert.strictEqual(yield* reasonOf(client.createSession()), "RateLimited");
        assert.strictEqual(yield* reasonOf(client.releaseSession("other")), "Status");
        assert.strictEqual((yield* client.getSession("flaky")).id, "flaky");
        assert.strictEqual(
          yield* reasonOf(client.getSession("../../v1/projects")),
          "InvalidRequest",
        );
      }).pipe(Effect.provide(api.client));

      assert.strictEqual(attempts, 3);
      assert.strictEqual(api.received.filter((request) => request.method === "POST").length, 2);
      assert.isFalse(api.received.some((request) => request.url.includes("projects")));

      const wrongKey = clientLayer({ apiKey: Redacted.make("wrong"), baseUrl: api.origin }).pipe(
        Layer.provide(FetchHttpClient.layer),
      );

      assert.strictEqual(
        yield* reasonOf(
          Effect.flatMap(BrowserbaseClient, (client) => client.getSession("s1")).pipe(
            Effect.provide(wrongKey),
          ),
        ),
        "Unauthorized",
      );
    }),
  );

  it.live("refuses a redirect, so the key never reaches another origin", () =>
    Effect.gen(function* () {
      const stolen: Array<string | undefined> = [];

      const elsewhere = yield* listen((request, response) => {
        const key = request.headers["x-bb-api-key"];

        stolen.push(typeof key === "string" ? key : undefined);
        response.end("{}");
      });

      const api = yield* fakeApi(() => ({
        status: 302,
        headers: { location: `${elsewhere.origin}/v1/sessions/s1` },
      }));

      const error = yield* Effect.flatMap(BrowserbaseClient, (client) =>
        client.getSession("s1"),
      ).pipe(Effect.provide(api.client), Effect.flip);

      assert.strictEqual(error.reason._tag, "Status");
      assert.deepStrictEqual(stolen, []);
    }),
  );

  it.live("searches, fetches, issues redacted live view links and manages contexts", () =>
    Effect.gen(function* () {
      const api = yield* fakeApi((request) => {
        switch (`${request.method} ${request.url.split("?")[0]}`) {
          case "POST /v1/search":
            return {
              status: 200,
              body: {
                requestId: "r",
                query: "effect",
                results: [{ id: "1", url: "https://effect.website", title: "Effect" }],
              },
            };
          case "POST /v1/fetch":
            return {
              status: 200,
              body: {
                id: "f",
                statusCode: 200,
                headers: {},
                content: "# Example",
                contentType: "text/markdown",
                encoding: "utf-8",
              },
            };
          case "GET /v1/sessions/s1/debug":
            return {
              status: 200,
              body: {
                debuggerFullscreenUrl: "https://live.example/secret",
                debuggerUrl: "https://live.example/secret-tools",
                wsUrl: "wss://live.example/ws",
                pages: [
                  {
                    id: "t",
                    url: "https://a.example",
                    title: "A",
                    faviconUrl: "",
                    debuggerUrl: "x",
                    debuggerFullscreenUrl: "y",
                  },
                ],
              },
            };
          case "POST /v1/contexts":
            return {
              status: 201,
              body: {
                id: "c1",
                publicKey: "k",
                cipherAlgorithm: "AES-256-CBC",
                initializationVectorSize: 16,
              },
            };
          case "DELETE /v1/contexts/c1":
            return { status: 204 };
          default:
            return { status: 404, body: { message: "no route" } };
        }
      });

      yield* Effect.gen(function* () {
        const client = yield* BrowserbaseClient;
        const results = yield* client.search("effect", { results: 1 });
        const page = yield* client.fetch("https://example.com", { format: "markdown" });
        const live = yield* client.liveView("s1", { expiresInSeconds: 600 });

        assert.deepStrictEqual(
          results.map((result) => result.title),
          ["Effect"],
        );
        assert.strictEqual(page.content, "# Example");
        assert.isTrue(Redacted.isRedacted(live.debuggerFullscreenUrl));
        assert.strictEqual((yield* client.createContext({ name: "trading" })).id, "c1");
        yield* client.deleteContext("c1");
      }).pipe(Effect.provide(api.client));

      assert.deepStrictEqual(api.received[0]?.body, { query: "effect", numResults: 1 });
      assert.deepStrictEqual(api.received[1]?.body, {
        url: "https://example.com",
        format: "markdown",
      });
      assert.strictEqual(api.received[2]?.url, "/v1/sessions/s1/debug?expiresIn=600");
    }),
  );
});

describe("Browserbase", () => {
  it.live("opens a browser on a new session and releases the session when the scope closes", () =>
    Effect.gen(function* () {
      const port = yield* listen(() => undefined).pipe(
        Effect.map(({ server }) => (server.address() as AddressInfo).port),
        Effect.scoped,
      );

      yield* Effect.acquireRelease(
        Effect.promise(() => chromium.launch({ args: [`--remote-debugging-port=${port}`] })),
        (local) => Effect.promise(() => local.close()),
      );

      const api = yield* fakeApi((request) =>
        request.method === "POST" && request.url === "/v1/sessions"
          ? { status: 201, body: session("s1", `http://127.0.0.1:${port}`) }
          : { status: 200, body: { ...session("s1"), status: "COMPLETED" } },
      );

      yield* Effect.gen(function* () {
        const browser = yield* Browser;
        const page = yield* browser.page;

        yield* page.goto("data:text/html,<title>Hosted</title><button>Go</button>");
        assert.deepStrictEqual([browser.id, browser.provider], ["s1", "browserbase"]);
        assert.include((yield* page.snapshot()).text, 'button "Go"');
      }).pipe(
        Effect.provide(
          Browserbase.layer({ session: { timeout: 300 } }).pipe(Layer.provide(api.client)),
        ),
      );

      assert.deepStrictEqual(
        api.received.map((request) => [request.method, request.url, request.body]),
        [
          ["POST", "/v1/sessions", { timeout: 300 }],
          ["POST", "/v1/sessions/s1", { status: "REQUEST_RELEASE" }],
        ],
      );
    }),
  );
});
