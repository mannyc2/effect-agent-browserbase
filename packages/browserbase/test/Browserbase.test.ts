// The client's requests against an API on loopback; then the provider against the in-memory
// API, with a local Chromium as each session's DevTools address. Nothing reaches Browserbase.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { assert, describe, it } from "@effect/vitest";
import {
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Redacted,
  Schedule,
  Schema,
  Scope,
  Stream,
} from "effect";
import { Browser } from "effect-browser/Browser";
import type * as Supervisor from "effect-browser/Supervisor";
import { FetchHttpClient, HttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import { chromium } from "playwright-core";

import * as Browserbase from "../src/Browserbase.ts";
import { BrowserbaseClient, layer as clientLayer } from "../src/BrowserbaseClient.ts";
import { BrowserbaseError } from "../src/BrowserbaseError.ts";
import * as ContextLease from "../src/ContextLease.ts";
import * as TestBrowserbase from "../src/testing/TestBrowserbase.ts";

interface Received {
  readonly method: string;
  readonly url: string;
  readonly key: string | undefined;
  /** Parsed JSON, or the raw text of any other body. */
  readonly body: unknown;
  readonly at: number;
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
          body:
            raw === ""
              ? undefined
              : request.headers["content-type"]?.startsWith("application/json") === true
                ? (JSON.parse(raw) as unknown)
                : raw,
          at: performance.now(),
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
        if (request.url === "/v1/sessions/malformed")
          return { status: 400, body: { message: "Invalid Session ID" } };
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
        // Browserbase refuses an id of the wrong shape with 400, as it does a malformed request.
        assert.strictEqual(yield* reasonOf(client.getSession("malformed")), "InvalidRequest");
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

  it.live(
    "uploads, reads and deletes extensions, refusing an empty or oversized archive unsent",
    () =>
      Effect.gen(function* () {
        const extension = {
          id: "e1",
          fileName: "marker.zip",
          createdAt: "2026-10-06T12:00:00.000Z",
          updatedAt: "2026-10-06T12:00:00.000Z",
          projectId: "project",
        };

        const api = yield* fakeApi((request) => {
          switch (`${request.method} ${request.url}`) {
            case "POST /v1/extensions":
            case "GET /v1/extensions/e1":
              return { status: 200, body: extension };
            case "DELETE /v1/extensions/e1":
              return { status: 204 };
            default:
              return { status: 404, body: { message: "Extension not found" } };
          }
        });

        yield* Effect.gen(function* () {
          const client = yield* BrowserbaseClient;
          const archive = new TextEncoder().encode("PK-archive-bytes");
          const uploaded = yield* client.uploadExtension(archive, { fileName: "marker.zip" });

          assert.deepStrictEqual([uploaded.id, uploaded.fileName], ["e1", "marker.zip"]);
          assert.strictEqual((yield* client.getExtension("e1")).id, "e1");
          yield* client.deleteExtension("e1");
          assert.strictEqual(yield* reasonOf(client.getExtension("gone")), "NotFound");
          assert.strictEqual(
            yield* reasonOf(client.uploadExtension(new Uint8Array())),
            "InvalidRequest",
          );
          assert.strictEqual(
            yield* reasonOf(client.uploadExtension(new Uint8Array(100 * 1024 * 1024 + 1))),
            "InvalidRequest",
          );
        }).pipe(Effect.provide(api.client));

        const [upload, ...rest] = api.received;
        const body = String(upload?.body);

        assert.include(body, 'name="file"; filename="marker.zip"');
        assert.include(body, "Content-Type: application/zip");
        assert.include(body, "PK-archive-bytes");
        assert.deepStrictEqual(
          rest.map((request) => [request.method, request.url]),
          [
            ["GET", "/v1/extensions/e1"],
            ["DELETE", "/v1/extensions/e1"],
            ["GET", "/v1/extensions/gone"],
          ],
        );
      }),
  );
});

/** A local Chromium's DevTools address, which the fake hands out as each session's. */
const chromiumEndpoint = Effect.gen(function* () {
  const port = yield* listen(() => undefined).pipe(
    Effect.map(({ server }) => (server.address() as AddressInfo).port),
    Effect.scoped,
  );

  yield* Effect.acquireRelease(
    Effect.promise(() => chromium.launch({ args: [`--remote-debugging-port=${port}`] })),
    (local) => Effect.promise(() => local.close()),
  );

  return `http://127.0.0.1:${port}`;
});

/** An address with nothing listening, so each connect fails at once and its session is released. */
const nowhere = listen(() => undefined).pipe(
  Effect.map(({ origin }) => origin),
  Effect.scoped,
);

/** The in-memory API, and the lease within this process, as one process would have them. */
const hostedFake = (script?: TestBrowserbase.Script) =>
  Layer.merge(TestBrowserbase.layer(script), ContextLease.layer);

const kept = Effect.flatMap(TestBrowserbase.TestBrowserbase, (fake) => fake.sessions);
const asked = Effect.flatMap(TestBrowserbase.TestBrowserbase, (fake) => fake.requests);

/** The fake's sessions' ids, oldest first; it hands out UUIDs, as Browserbase does. */
const ids = Effect.map(kept, (sessions) => sessions.map(({ id }) => id));

/** What an open failed at: the Browserbase operation, or the error's own tag. */
const step = (error: { readonly _tag: string; readonly operation?: string | undefined }) =>
  error.operation ?? error._tag;

/** Why a Browserbase call failed, or the error's own tag for any other. */
const reason = (error: { readonly _tag: string; readonly reason?: { readonly _tag: string } }) =>
  error.reason?._tag ?? error._tag;

const persisting = (id: string) => ({
  timeout: 3600,
  browserSettings: { context: { id, persist: true } },
});

/** Move the test clock on a second at a time until the fiber is done, letting real work run. */
const finish = <A, E>(fiber: Fiber.Fiber<A, E>) =>
  Effect.gen(function* () {
    for (let second = 0; fiber.pollUnsafe() === undefined; second++) {
      assert.isBelow(second, 600, "it finishes within ten minutes");
      yield* TestClock.adjust("1 second");
      yield* TestClock.withLive(Effect.sleep("2 millis"));
    }

    return yield* Fiber.join(fiber);
  });

/** Move the test clock on `seconds`, a second at a time, letting real work run. */
const pass = (seconds: number) =>
  Effect.forEach(
    Array.from({ length: seconds }),
    () =>
      TestClock.adjust("1 second").pipe(
        Effect.andThen(TestClock.withLive(Effect.sleep("2 millis"))),
      ),
    { discard: true },
  );

describe("Browserbase", () => {
  it.effect("settles a session create that never answers, without sending it again", () =>
    Effect.gen(function* () {
      let creates = 0;

      const silent = HttpClient.make((request) =>
        Effect.sync(() => {
          if (request.method === "POST") creates += 1;
        }).pipe(Effect.andThen(Effect.never)),
      );

      const client = clientLayer({
        apiKey: Redacted.make("test-key"),
        baseUrl: "http://127.0.0.1:9",
      }).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, silent)));

      const open = Browserbase.open().pipe(
        Effect.scoped,
        Effect.provide(Layer.merge(client, ContextLease.layer)),
      );

      // Alone, the create fails at its deadline with the reason that says it may exist, once the
      // search for the session it may have made has given up on an answer.
      const error = yield* finish(yield* Effect.forkChild(Effect.flip(open)));

      assert.deepStrictEqual([step(error), reason(error)], ["createSession", "Transport"]);

      // A caller that stops waiting, such as a trial timeout, finishes once the create settles.
      const stopped = yield* Effect.forkChild(open);
      const stopping = yield* Effect.forkChild(Fiber.interrupt(stopped));

      yield* TestClock.adjust("60 seconds");
      yield* Fiber.join(stopping);
      assert.strictEqual(creates, 2);
    }),
  );

  it.live("ends the session a lost create made, found by its own label, and no other", () =>
    Effect.gen(function* () {
      const connectUrl = yield* chromiumEndpoint;

      yield* Effect.gen(function* () {
        // The first open's session runs on; the second's create answer is lost.
        yield* Browserbase.open();
        const error = yield* Effect.flip(Browserbase.open().pipe(Effect.scoped));

        assert.deepStrictEqual([step(error), reason(error)], ["createSession", "Transport"]);
        assert.deepStrictEqual(
          (yield* kept).map(({ status }) => status),
          ["RUNNING", "COMPLETED"],
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(hostedFake({ connectUrl, creates: [{ _tag: "Accept" }, { _tag: "Lost" }] })),
      );
    }),
  );

  it.effect("looks for a lost create's session until Browserbase lists it, and ends it", () =>
    Effect.gen(function* () {
      const error = yield* finish(
        yield* Effect.forkChild(Effect.flip(Browserbase.open().pipe(Effect.scoped))),
      );

      assert.deepStrictEqual([step(error), reason(error)], ["createSession", "Transport"]);
      assert.deepStrictEqual(
        (yield* kept).map(({ status }) => status),
        ["COMPLETED"],
      );
    }).pipe(Effect.provide(hostedFake({ creates: [{ _tag: "Lost", listedAfter: 5000 }] }))),
  );

  it.effect("releases a created session whose answer does not decode", () =>
    Effect.gen(function* () {
      const error = yield* Browserbase.open().pipe(Effect.scoped, Effect.flip);
      const [session] = yield* kept;

      assert.deepStrictEqual([step(error), reason(error)], ["createSession", "Decode"]);
      assert.isTrue(
        error._tag === "BrowserbaseError" &&
          error.reason._tag === "Decode" &&
          error.reason.released === true,
      );
      assert.isDefined(session);
      assert.deepStrictEqual(
        (yield* kept).map(({ status, releases }) => [status, releases]),
        [["COMPLETED", 1]],
      );
    }).pipe(Effect.provide(hostedFake({ creates: [{ _tag: "Malformed" }] }))),
  );

  it.live("keeps the session's connect URL out of a failed connect", () =>
    Effect.gen(function* () {
      const { origin } = yield* listen((_request, response) => {
        response.writeHead(401);
        response.end();
      });

      const signingKey = "bb-signing-key-0123456789";

      const error = yield* Effect.gen(function* () {
        const { id } = yield* Effect.flatMap(BrowserbaseClient, (client) => client.createSession());

        return yield* Effect.flip(Browserbase.attach(id).pipe(Effect.scoped));
      }).pipe(Effect.provide(hostedFake({ connectUrl: `${origin}/?signingKey=${signingKey}` })));

      assert.strictEqual(error._tag, "BrowserError");
      assert.notInclude(error.message, signingKey);
      assert.notInclude(JSON.stringify(error), signingKey);
      assert.include(error.message, origin);
    }),
  );

  it.live("opens a browser on a new session, then releases it and confirms it ended", () =>
    Effect.gen(function* () {
      const connectUrl = yield* chromiumEndpoint;

      yield* Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const browser = yield* Browser;
          const page = yield* browser.firstPage;

          yield* page.goto("data:text/html,<title>Hosted</title><button>Go</button>");
          assert.deepStrictEqual([browser.id, browser.provider], [...(yield* ids), "browserbase"]);
          assert.include((yield* page.snapshot()).text, 'button "Go"');
        }).pipe(Effect.provide(Browserbase.layer({ session: { timeout: 300 } })));
        const [id] = yield* ids;

        assert.deepStrictEqual(yield* asked, [
          "POST /v1/sessions",
          `POST /v1/sessions/${id}`,
          `GET /v1/sessions/${id}`,
        ]);
        assert.deepStrictEqual(
          (yield* kept).map(({ status }) => status),
          ["COMPLETED"],
        );
      }).pipe(Effect.provide(hostedFake({ connectUrl })));
    }),
  );

  it.live("reports an early release as settled, and the scope's close releases nothing more", () =>
    Effect.gen(function* () {
      const connectUrl = yield* chromiumEndpoint;

      yield* Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const hosted = yield* Browserbase.open();

          assert.strictEqual((yield* hosted.release)._tag, "Settled");
          assert.deepStrictEqual(
            (yield* kept).map(({ status }) => status),
            ["COMPLETED"],
          );
        }).pipe(Effect.scoped);

        assert.deepStrictEqual(
          (yield* kept).map(({ releases }) => releases),
          [1],
        );
      }).pipe(Effect.provide(hostedFake({ connectUrl })));
    }),
  );

  it.effect("has the next writer end a session its release left running before it writes", () =>
    Effect.gen(function* () {
      const connectUrl = yield* nowhere;

      yield* Effect.gen(function* () {
        const { id } = yield* Effect.flatMap(BrowserbaseClient, (client) => client.createContext());
        const open = Browserbase.open({ session: persisting(id) }).pipe(Effect.scoped, Effect.flip);

        // The first session's release stays pending past its deadline, so it may still save.
        assert.strictEqual(step(yield* finish(yield* Effect.forkChild(open))), "connect");

        // The next writer asks it to end again, and while it runs on, writes nothing.
        const held = yield* finish(yield* Effect.forkChild(open));

        assert.deepStrictEqual(
          [held._tag, held._tag === "ContextHeld" && held.context],
          ["ContextHeld", id],
        );
        assert.deepStrictEqual(
          (yield* kept).map(({ status, releases }) => [status, releases]),
          [["RUNNING", 2]],
        );

        // Once it has ended, the writer after it goes on, so the hold has a way out.
        assert.strictEqual(step(yield* finish(yield* Effect.forkChild(open))), "connect");
        const [first, second] = yield* ids;

        assert.isBelow(
          (yield* asked).lastIndexOf(`GET /v1/sessions/${first}`),
          (yield* asked).lastIndexOf("POST /v1/sessions"),
        );
        assert.deepStrictEqual(
          (yield* kept).map(({ id, status, userMetadata }) => [
            id,
            status,
            userMetadata?.["persistsContext"],
          ]),
          [
            [first, "COMPLETED", id],
            [second, "COMPLETED", id],
          ],
        );
      }).pipe(
        Effect.provide(
          hostedFake({
            connectUrl,
            releases: [{ _tag: "Pending" }, { _tag: "Pending" }],
          }),
        ),
      );
    }),
  );

  it.effect("reads a released session's status again until Browserbase answers", () =>
    Effect.gen(function* () {
      const connectUrl = yield* nowhere;

      const reads = [
        { _tag: "Refused", status: 500 },
        { _tag: "Lost" },
        { _tag: "Refused", status: 503 },
        { _tag: "Refused", status: 404 },
      ] as const;

      yield* Effect.gen(function* () {
        const open = Browserbase.open({ session: persisting("context-reads") }).pipe(
          Effect.scoped,
          Effect.flip,
        );

        yield* finish(yield* Effect.forkChild(open));
        // The release was confirmed, so the next writer takes the context at once.
        yield* finish(yield* Effect.forkChild(open));
        const [first] = yield* ids;

        assert.deepStrictEqual(
          (yield* asked).filter((request) => request === `GET /v1/sessions/${first}`).length,
          reads.length + 1,
        );
        assert.deepStrictEqual(
          (yield* kept).map(({ status }) => status),
          ["COMPLETED", "COMPLETED"],
        );
      }).pipe(Effect.provide(hostedFake({ connectUrl, reads })));
    }),
  );

  it.effect("ends the session a lost persisting create made, and the next writer goes on", () =>
    Effect.gen(function* () {
      const connectUrl = yield* nowhere;

      yield* Effect.gen(function* () {
        const open = Browserbase.open({ session: persisting("context-lost") }).pipe(
          Effect.scoped,
          Effect.flip,
        );

        const error = yield* finish(yield* Effect.forkChild(open));

        // The create's own error stands: ending the unseen session is not a failure of its own.
        assert.deepStrictEqual([step(error), reason(error)], ["createSession", "Transport"]);
        assert.deepStrictEqual(
          (yield* kept).map(({ status }) => status),
          ["COMPLETED"],
        );

        // That session was confirmed ended, so the next writer looks for no other first.
        const searches = Effect.map(
          asked,
          (requests) =>
            requests.filter((request) => request.startsWith("GET /v1/sessions?")).length,
        );

        const before = yield* searches;

        assert.strictEqual(step(yield* finish(yield* Effect.forkChild(open))), "connect");
        assert.strictEqual(yield* searches, before);
      }).pipe(Effect.provide(hostedFake({ connectUrl, creates: [{ _tag: "Lost" }] })));
    }),
  );

  it.effect(
    "holds the context while a lost create's session runs on, until reconcile ends it",
    () =>
      Effect.gen(function* () {
        const connectUrl = yield* nowhere;

        yield* Effect.gen(function* () {
          const { id } = yield* Effect.flatMap(BrowserbaseClient, (client) =>
            client.createContext(),
          );

          const open = Browserbase.open({ session: persisting(id) }).pipe(
            Effect.scoped,
            Effect.flip,
          );

          const error = yield* finish(yield* Effect.forkChild(open));

          assert.deepStrictEqual(
            [error._tag, error._tag === "ContextHeld" && error.context],
            ["ContextHeld", id],
          );
          assert.deepStrictEqual(
            (yield* kept).map(({ status }) => status),
            ["RUNNING"],
          );
          assert.strictEqual(
            (yield* finish(yield* Effect.forkChild(Browserbase.reconcile(id))))._tag,
            "Settled",
          );

          // Reconciled, the context is let go: the next writer looks for no other session first.
          const listed = (yield* asked).filter((request) =>
            request.startsWith("GET /v1/sessions?"),
          );

          assert.strictEqual(step(yield* finish(yield* Effect.forkChild(open))), "connect");
          assert.deepStrictEqual(
            (yield* asked).filter((request) => request.startsWith("GET /v1/sessions?")),
            listed,
          );
          assert.deepStrictEqual(
            (yield* kept).map(({ status }) => status),
            ["COMPLETED", "COMPLETED"],
          );
        }).pipe(
          Effect.provide(
            hostedFake({
              connectUrl,
              creates: [{ _tag: "Lost" }],
              releases: [{ _tag: "Pending" }],
            }),
          ),
        );
      }),
  );

  it.live("has reconcile wait while a writer in this process holds the context", () =>
    Effect.gen(function* () {
      const connectUrl = yield* chromiumEndpoint;

      yield* Effect.gen(function* () {
        const { id } = yield* Effect.flatMap(BrowserbaseClient, (client) => client.createContext());
        const writing = yield* Scope.make();
        const settle = { contextSettle: "10 millis" } as const;

        yield* Browserbase.open({ session: persisting(id), ...settle }).pipe(
          Scope.provide(writing),
        );
        const reconciling = yield* Effect.forkChild(Browserbase.reconcile(id, settle));

        // The writer's session runs on, unended, until the writer lets the context go.
        yield* Effect.sleep("300 millis");
        assert.deepStrictEqual(
          (yield* kept).map(({ status }) => status),
          ["RUNNING"],
        );
        assert.isUndefined(reconciling.pollUnsafe());
        yield* Scope.close(writing, Exit.void);
        assert.strictEqual((yield* Fiber.join(reconciling))._tag, "Settled");
      }).pipe(Effect.provide(hostedFake({ connectUrl })));
    }),
  );
});

const still = (title: string) =>
  `data:text/html,${encodeURIComponent(`<title>${title}</title><h1>${title}</h1>`)}`;

const createContext = Effect.flatMap(BrowserbaseClient, (client) => client.createContext());

/**
 * The in-memory API, and a lease that writes down what each writer was told and said: the lease
 * within this process, or, with `unsettled`, one that reads each context unsettled the first time,
 * as a lease shared with another process does once that process ended without saying.
 */
const leased = (steps: Array<string>, script: TestBrowserbase.Script, unsettled = false) =>
  Layer.merge(
    TestBrowserbase.layer(script),
    Layer.effect(
      ContextLease.ContextLease,
      Effect.map(ContextLease.ContextLease, (inner) => {
        const seen = new Set<string>();

        return ContextLease.ContextLease.of({
          hold: (context) =>
            Effect.map(inner.hold(context), (hold) => {
              const told = hold.unsettled || (unsettled && !seen.has(context));

              seen.add(context);
              steps.push(`held ${told ? "unsettled" : "settled"}`);

              return {
                unsettled: told,
                leave: (now: boolean) =>
                  Effect.sync(() => steps.push(`left ${now ? "unsettled" : "settled"}`)).pipe(
                    Effect.andThen(hold.leave(now)),
                  ),
              };
            }),
        });
      }),
    ).pipe(Layer.provide(ContextLease.layer)),
  );

describe("Browserbase's stored contexts", () => {
  it.live("holds a context through the lease from before a create until its save settles", () =>
    Effect.gen(function* () {
      const connectUrl = yield* chromiumEndpoint;
      const steps: Array<string> = [];

      yield* Effect.gen(function* () {
        const { id } = yield* createContext;

        const write = Browserbase.open({
          session: persisting(id),
          contextSettle: "20 millis",
        }).pipe(Effect.scoped);

        // Two writers at once, as from two processes that share the lease.
        yield* Effect.all([write, write], { concurrency: 2, discard: true });
        const [first, second] = yield* ids;
        const requests = yield* asked;

        // The second was created only once the first had been confirmed ended.
        assert.isBelow(
          requests.lastIndexOf(`GET /v1/sessions/${first}`),
          requests.lastIndexOf("POST /v1/sessions"),
        );
        assert.isDefined(second);
        assert.deepStrictEqual(steps, [
          "held settled",
          "left settled",
          "held settled",
          "left settled",
        ]);
      }).pipe(Effect.provide(leased(steps, { connectUrl })));
    }),
  );

  it.live("has a writer end first the sessions a lease says another process may have left", () =>
    Effect.gen(function* () {
      const connectUrl = yield* chromiumEndpoint;
      const steps: Array<string> = [];

      yield* Effect.gen(function* () {
        const { id } = yield* createContext;

        // A session another process left saving to the context, labelled as `open` labels it.
        const left = yield* Effect.flatMap(BrowserbaseClient, (client) =>
          client.createSession({ ...persisting(id), userMetadata: { persistsContext: id } }),
        );

        yield* Browserbase.open({ session: persisting(id), contextSettle: "10 millis" }).pipe(
          Effect.scoped,
        );
        const requests = yield* asked;

        assert.isBelow(
          requests.indexOf(`GET /v1/sessions/${left.id}`),
          requests.lastIndexOf("POST /v1/sessions"),
        );
        assert.deepStrictEqual(
          (yield* kept).map(({ status }) => status),
          ["COMPLETED", "COMPLETED"],
        );
        assert.deepStrictEqual(steps, ["held unsettled", "left settled"]);
      }).pipe(Effect.provide(leased(steps, { connectUrl }, true)));
    }),
  );

  it.live("reads a context back from a session that saves nothing, never beside a writer", () =>
    Effect.gen(function* () {
      const connectUrl = yield* chromiumEndpoint;

      yield* Effect.gen(function* () {
        const { id } = yield* createContext;
        const writing = yield* Scope.make();
        const settle = { contextSettle: "10 millis" } as const;

        const signedIn = (browser: Browser["Service"]) =>
          browser.firstPage.pipe(
            Effect.flatMap((page) => page.goto(still("Signed in"))),
            Effect.as(browser.id),
          );

        yield* Browserbase.open({ session: persisting(id), ...settle }).pipe(
          Scope.provide(writing),
        );
        const reading = yield* Effect.forkChild(Browserbase.verifyContext(id, signedIn, settle));

        // It waits for the writer's whole session, and makes none of its own meanwhile.
        yield* Effect.sleep("300 millis");
        assert.isUndefined(reading.pollUnsafe());
        assert.strictEqual((yield* kept).length, 1);
        yield* Scope.close(writing, Exit.void);
        const reader = yield* Fiber.join(reading);

        assert.deepStrictEqual(
          (yield* kept).map(({ id, status, context }) => [id, status, context?.persist]),
          [
            [(yield* ids)[0], "COMPLETED", true],
            [reader, "COMPLETED", false],
          ],
        );

        // A check that fails still releases its session and lets the context go.
        assert.strictEqual(
          yield* Effect.flip(
            Browserbase.verifyContext(id, () => Effect.fail("signed out"), settle),
          ),
          "signed out",
        );
        assert.deepStrictEqual(
          (yield* kept).map(({ status }) => status),
          ["COMPLETED", "COMPLETED", "COMPLETED"],
        );

        const searches = (yield* asked).filter((request) =>
          request.startsWith("GET /v1/sessions?"),
        );

        yield* Browserbase.open({ session: persisting(id), ...settle }).pipe(Effect.scoped);
        assert.deepStrictEqual(
          (yield* asked).filter((request) => request.startsWith("GET /v1/sessions?")),
          searches,
        );
      }).pipe(Effect.provide(hostedFake({ connectUrl })));
    }),
  );

  it.live("ends a session a writer elsewhere may have left before it reads a context back", () =>
    Effect.gen(function* () {
      const connectUrl = yield* chromiumEndpoint;
      const steps: Array<string> = [];

      yield* Effect.gen(function* () {
        const { id } = yield* createContext;

        const left = yield* Effect.flatMap(BrowserbaseClient, (client) =>
          client.createSession({ ...persisting(id), userMetadata: { persistsContext: id } }),
        );

        yield* Browserbase.verifyContext(id, (browser) => Effect.succeed(browser.id), {
          contextSettle: "10 millis",
        });
        const requests = yield* asked;

        assert.isBelow(
          requests.indexOf(`GET /v1/sessions/${left.id}`),
          requests.lastIndexOf("POST /v1/sessions"),
        );
        assert.deepStrictEqual(steps, ["held unsettled", "left settled"]);
      }).pipe(Effect.provide(leased(steps, { connectUrl }, true)));
    }),
  );
});

describe("Browserbase.attach", () => {
  it.live("resumes a running session from a new connection, finding its pages by their ids", () =>
    Effect.gen(function* () {
      const connectUrl = yield* chromiumEndpoint;

      yield* Effect.gen(function* () {
        const { id } = yield* Effect.flatMap(BrowserbaseClient, (client) =>
          client.createSession({ keepAlive: true }),
        );

        // One connection opens a page and goes, as a process that ends does.
        const page = yield* Browserbase.attach(id).pipe(
          Effect.flatMap(({ browser }) => browser.newPage(still("Resumed"))),
          Effect.map(({ id }) => id),
          Effect.scoped,
        );

        assert.deepStrictEqual(
          (yield* kept).map(({ status }) => status),
          ["RUNNING"],
        );

        // Another finds it under the same id, and its release ends the session.
        const hosted = yield* Browserbase.attach(id);
        const found = yield* hosted.browser.page(page);

        assert.deepStrictEqual(
          Option.map(found, (resumed) => resumed.playwright.url()),
          Option.some(still("Resumed")),
        );
        assert.strictEqual((yield* hosted.release)._tag, "Settled");
        assert.deepStrictEqual(
          (yield* kept).map(({ status }) => status),
          ["COMPLETED"],
        );
      }).pipe(Effect.scoped, Effect.provide(hostedFake({ connectUrl })));
    }),
  );

  it.effect("refuses a session that has ended, without connecting to it", () =>
    Effect.gen(function* () {
      const connectUrl = yield* nowhere;

      yield* Effect.gen(function* () {
        const client = yield* BrowserbaseClient;
        const { id } = yield* client.createSession();

        yield* client.releaseSession(id);
        const error = yield* Effect.flip(Browserbase.attach(id).pipe(Effect.scoped));

        assert.deepStrictEqual(
          [
            error._tag,
            error._tag === "BrowserError" && error.reason._tag === "Closed" && error.reason.cause,
          ],
          ["BrowserError", "session"],
        );
      }).pipe(Effect.provide(hostedFake({ connectUrl })));
    }),
  );
});

/** A generation's change as one line, such as `2 Reopening` or `1 Closed Settled`. */
const line = ({ number, state }: Supervisor.Generation) =>
  state._tag === "Closed"
    ? `${number} Closed ${state.released?._tag ?? "none"}`
    : `${number} ${state._tag}`;

describe("Browserbase.supervise", () => {
  it.effect("goes down at once, without trying again, when Browserbase refuses the key", () =>
    Effect.gen(function* () {
      const sessions = yield* Browserbase.supervise();

      // Trying again would have asked twice within these seconds.
      yield* pass(5);
      assert.deepStrictEqual(yield* asked, ["POST /v1/sessions"]);
      const unavailable = yield* Effect.flip(sessions.browser);
      const cause = unavailable.cause;

      assert.deepStrictEqual(
        [unavailable.reason, Schema.is(BrowserbaseError)(cause) && cause.reason._tag],
        ["down", "Unauthorized"],
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(hostedFake({ creates: [{ _tag: "Reject", status: 401 }] })),
    ),
  );

  it.effect("tries a held context again on its schedule, asking its session to end each time", () =>
    Effect.gen(function* () {
      const sessions = yield* Browserbase.supervise({
        session: persisting("context-held"),
        reopen: Schedule.spaced("1 second"),
      });

      const down = yield* Effect.forkChild(
        sessions.states.pipe(
          Stream.filter(({ state }) => state._tag === "Down"),
          Stream.runHead,
        ),
      );

      // The first try's release of the lost create's session runs a minute; the second begins.
      yield* pass(65);
      assert.deepStrictEqual(
        (yield* kept).map(({ status, releases }) => [status, releases]),
        [["RUNNING", 2]],
      );
      // A context held is not definite: each try ends its sessions again, so it is not `Down`.
      assert.isUndefined(down.pollUnsafe());
      // Retiring waits for the release under way to finish.
      yield* finish(yield* Effect.forkChild(sessions.retire));
    }).pipe(
      Effect.scoped,
      Effect.provide(
        hostedFake({
          creates: [{ _tag: "Lost" }],
          releases: [{ _tag: "Pending" }, { _tag: "Pending" }],
        }),
      ),
    ),
  );

  it.live("reopens a lost session, and releases each one it opened", () =>
    Effect.gen(function* () {
      const connectUrl = yield* chromiumEndpoint;

      yield* Effect.gen(function* () {
        const sessions = yield* Browserbase.supervise({ reopen: Schedule.spaced("10 millis") });

        const states = yield* Effect.forkChild(
          Stream.runCollect(Stream.map(sessions.states, line)),
        );

        const first = yield* sessions.browser;

        // Our side's connection drops, as it would if the network did.
        yield* Effect.promise(async () => first.context.browser()?.close());
        yield* sessions.states.pipe(
          Stream.filter((generation) => line(generation) === "2 Open"),
          Stream.runHead,
        );
        assert.strictEqual((yield* sessions.browser).id, (yield* ids)[1]);
        yield* sessions.retire;

        const lines = yield* Fiber.join(states);

        assert.deepStrictEqual(
          lines.filter((one) => one.startsWith("1 ")),
          ["1 Opening", "1 Open", "1 Lost", "1 Closed Settled"],
        );
        assert.deepStrictEqual(
          lines.filter((one) => one.startsWith("2 ")),
          ["2 Reopening", "2 Open", "2 Closed Settled"],
        );
        assert.deepStrictEqual(
          (yield* kept).map(({ status }) => status),
          ["COMPLETED", "COMPLETED"],
        );
      }).pipe(Effect.scoped, Effect.provide(hostedFake({ connectUrl })));
    }),
  );

  it.live("rotates sessions that persist to a context by ending the current one first", () =>
    Effect.gen(function* () {
      const connectUrl = yield* chromiumEndpoint;

      yield* Effect.gen(function* () {
        const sessions = yield* Browserbase.supervise({
          session: persisting("context-rotate"),
          contextSettle: "50 millis",
        });

        const first = yield* sessions.browser;
        const second = yield* sessions.rotate;

        assert.deepStrictEqual([first.id, second.id], [...(yield* ids)]);
        yield* sessions.retire;
        // The first session's end was confirmed before the next was created.
        assert.isBelow(
          (yield* asked).indexOf(`GET /v1/sessions/${first.id}`),
          (yield* asked).lastIndexOf("POST /v1/sessions"),
        );
      }).pipe(Effect.scoped, Effect.provide(hostedFake({ connectUrl })));
    }),
  );

  it.live(
    "keeps its session past its scope, for the next under its name to adopt, pages and all",
    () =>
      Effect.gen(function* () {
        const connectUrl = yield* chromiumEndpoint;

        /** Each session as the fake has it: its status, releases asked and what it is kept as. */
        const rows = Effect.map(kept, (sessions) =>
          sessions.map(({ status, releases, keepAlive, userMetadata }) => [
            status,
            releases,
            keepAlive,
            userMetadata?.["keptAs"],
          ]),
        );

        /** Run `use` on a supervisor keeping under "air", and give its states as lines too. */
        const keeping = <A, E>(
          use: (sessions: Supervisor.Supervisor) => Effect.Effect<A, E, BrowserbaseClient>,
        ) =>
          Effect.gen(function* () {
            const sessions = yield* Browserbase.supervise({ keep: "air" });

            const states = yield* Effect.forkChild(
              Stream.runCollect(Stream.map(sessions.states, line)),
            );

            return [yield* use(sessions), states] as const;
          }).pipe(
            Effect.scoped,
            Effect.flatMap(([value, states]) =>
              Effect.map(Fiber.join(states), (lines) => [value, lines] as const),
            ),
          );

        yield* Effect.gen(function* () {
          const client = yield* BrowserbaseClient;

          // With nothing kept under its name, it makes a session, kept alive and labelled.
          yield* keeping((sessions) => Effect.andThen(sessions.browser, sessions.retire));
          assert.deepStrictEqual(yield* rows, [["COMPLETED", 1, true, "air"]]);

          // Two that earlier processes kept: the newer is adopted, and the older ended.
          const keptAsAir = { keepAlive: true, userMetadata: { keptAs: "air" } };
          const older = yield* client.createSession(keptAsAir);

          yield* Effect.sleep("5 millis");
          const newer = yield* client.createSession(keptAsAir);

          const [page, lines] = yield* keeping((sessions) =>
            Effect.gen(function* () {
              const browser = yield* sessions.browser;

              assert.strictEqual(browser.id, newer.id);

              return (yield* browser.newPage(still("Kept"))).id;
            }),
          );

          assert.deepStrictEqual(lines, ["1 Opening", "1 Open", "1 Kept"]);
          assert.deepStrictEqual((yield* rows).slice(1), [
            ["COMPLETED", 1, true, "air"],
            ["RUNNING", 0, true, "air"],
          ]);
          assert.strictEqual((yield* ids)[1], older.id);

          // The next adopts it again, its page still there, and retiring releases it.
          yield* keeping((sessions) =>
            Effect.gen(function* () {
              const browser = yield* sessions.browser;

              assert.strictEqual(browser.id, newer.id);
              assert.isTrue(Option.isSome(yield* browser.page(page)));
              yield* sessions.retire;
            }),
          );
          assert.deepStrictEqual((yield* rows).slice(2), [["COMPLETED", 1, true, "air"]]);
        }).pipe(Effect.provide(hostedFake({ connectUrl })));
      }),
  );

  it.live("keeps a writer's session running, which only a writer that adopts it does not end", () =>
    Effect.gen(function* () {
      const connectUrl = yield* chromiumEndpoint;

      yield* Effect.gen(function* () {
        const { id } = yield* createContext;

        const options: Browserbase.SuperviseOptions = {
          keep: "air",
          session: persisting(id),
          contextSettle: "10 millis",
        };

        const statuses = Effect.map(kept, (sessions) => sessions.map(({ status }) => status));

        // Kept, it may still save to the context, so the context is left unsettled.
        const first = yield* Effect.flatMap(Browserbase.supervise(options), (sessions) =>
          Effect.map(sessions.browser, ({ id }) => id),
        ).pipe(Effect.scoped);

        // A supervisor under its name adopts it, and ends nothing.
        const adopted = yield* Effect.flatMap(Browserbase.supervise(options), (sessions) =>
          Effect.map(sessions.browser, ({ id }) => id),
        ).pipe(Effect.scoped);

        assert.strictEqual(adopted, first);
        assert.deepStrictEqual(yield* statuses, ["RUNNING"]);

        // Any other writer ends it before it writes.
        yield* Browserbase.open({ session: persisting(id), contextSettle: "10 millis" }).pipe(
          Effect.scoped,
        );
        assert.deepStrictEqual(yield* statuses, ["COMPLETED", "COMPLETED"]);
        const requests = yield* asked;

        assert.isBelow(
          requests.indexOf(`POST /v1/sessions/${first}`),
          requests.lastIndexOf("POST /v1/sessions"),
        );

        // Retiring releases what it keeps and leaves the context settled: the next writer looks
        // for none of the context's sessions.
        yield* Effect.flatMap(Browserbase.supervise(options), (sessions) =>
          Effect.andThen(sessions.browser, sessions.retire),
        ).pipe(Effect.scoped);
        const searched = (yield* asked).filter((request) => request.includes("persistsContext"));

        yield* Browserbase.open({ session: persisting(id), contextSettle: "10 millis" }).pipe(
          Effect.scoped,
        );
        assert.deepStrictEqual(
          (yield* asked).filter((request) => request.includes("persistsContext")),
          searched,
        );
      }).pipe(Effect.provide(hostedFake({ connectUrl })));
    }),
  );

  it.live(
    "ends a writer kept beside the one it adopts, as it would any writer of the context",
    () =>
      Effect.gen(function* () {
        const connectUrl = yield* chromiumEndpoint;

        yield* Effect.gen(function* () {
          const client = yield* BrowserbaseClient;
          const { id } = yield* createContext;

          // Two writers kept under the name, as a process that ended mid-rotation leaves them.
          const writer = {
            ...persisting(id),
            keepAlive: true,
            userMetadata: { keptAs: "air", persistsContext: id },
          };

          const older = yield* client.createSession(writer);

          yield* Effect.sleep("5 millis");
          const newer = yield* client.createSession(writer);

          const adopted = yield* Effect.flatMap(
            Browserbase.supervise({
              keep: "air",
              session: persisting(id),
              contextSettle: "10 millis",
            }),
            (sessions) => Effect.map(sessions.browser, (browser) => browser.id),
          ).pipe(Effect.scoped);

          const requests = yield* asked;

          assert.strictEqual(adopted, newer.id);
          assert.deepStrictEqual(
            (yield* kept).map(({ status }) => status),
            ["COMPLETED", "RUNNING"],
          );
          // The older was confirmed ended before the newer was taken on.
          assert.isBelow(
            requests.lastIndexOf(`GET /v1/sessions/${older.id}`),
            requests.indexOf(`GET /v1/sessions/${newer.id}`),
          );
        }).pipe(Effect.provide(hostedFake({ connectUrl })));
      }),
  );

  it.effect("goes down at once on a name it cannot keep sessions under", () =>
    Effect.gen(function* () {
      const sessions = yield* Browserbase.supervise({ keep: "on air" });
      const unavailable = yield* Effect.flip(sessions.browser);
      const cause = unavailable.cause;

      assert.deepStrictEqual(
        [unavailable.reason, Schema.is(BrowserbaseError)(cause) && cause.reason._tag],
        ["down", "InvalidRequest"],
      );
      assert.deepStrictEqual(yield* asked, []);
    }).pipe(Effect.scoped, Effect.provide(hostedFake())),
  );
});
