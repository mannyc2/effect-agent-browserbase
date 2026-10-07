// The client's requests against an API on loopback; then the provider against the in-memory
// API, with a local Chromium as each session's DevTools address. Nothing reaches Browserbase.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Redacted, Schedule, Stream } from "effect";
import { Browser } from "effect-browser/Browser";
import type * as Supervisor from "effect-browser/Supervisor";
import { FetchHttpClient, HttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import { chromium } from "playwright-core";

import * as Browserbase from "../src/Browserbase.ts";
import { BrowserbaseClient, layer as clientLayer } from "../src/BrowserbaseClient.ts";
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

const kept = Effect.flatMap(TestBrowserbase.TestBrowserbase, (fake) => fake.sessions);
const asked = Effect.flatMap(TestBrowserbase.TestBrowserbase, (fake) => fake.requests);

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
      let requests = 0;

      const silent = HttpClient.make(() =>
        Effect.sync(() => {
          requests += 1;
        }).pipe(Effect.andThen(Effect.never)),
      );

      const client = clientLayer({
        apiKey: Redacted.make("test-key"),
        baseUrl: "http://127.0.0.1:9",
      }).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, silent)));

      const open = Browserbase.open().pipe(Effect.scoped, Effect.provide(client));

      // Alone, the create fails at its deadline with the reason that says it may exist.
      const alone = yield* Effect.forkChild(Effect.flip(open));

      yield* TestClock.adjust("60 seconds");
      const error = yield* Fiber.join(alone);

      assert.deepStrictEqual(
        [error.operation, error.reason._tag, error.message],
        ["createSession", "Transport", "Browserbase createSession failed: no answer within 1m"],
      );

      // A caller that stops waiting, such as a trial timeout, finishes once the create settles.
      const stopped = yield* Effect.forkChild(open);
      const stopping = yield* Effect.forkChild(Fiber.interrupt(stopped));

      yield* TestClock.adjust("60 seconds");
      yield* Fiber.join(stopping);
      assert.strictEqual(requests, 2);
    }),
  );

  it.effect("releases a created session whose answer does not decode", () =>
    Effect.gen(function* () {
      const error = yield* Browserbase.open().pipe(Effect.scoped, Effect.flip);

      assert.deepStrictEqual([error.operation, error.reason._tag], ["createSession", "Decode"]);
      assert.include(error.message, "session session-1 was released");
      assert.deepStrictEqual(
        (yield* kept).map(({ status, releases }) => [status, releases]),
        [["COMPLETED", 1]],
      );
    }).pipe(Effect.provide(TestBrowserbase.layer({ creates: [{ _tag: "Malformed" }] }))),
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
      }).pipe(
        Effect.provide(
          TestBrowserbase.layer({ connectUrl: `${origin}/?signingKey=${signingKey}` }),
        ),
      );

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
          const page = yield* browser.page;

          yield* page.goto("data:text/html,<title>Hosted</title><button>Go</button>");
          assert.deepStrictEqual([browser.id, browser.provider], ["session-1", "browserbase"]);
          assert.include((yield* page.snapshot()).text, 'button "Go"');
        }).pipe(Effect.provide(Browserbase.layer({ session: { timeout: 300 } })));

        assert.deepStrictEqual(yield* asked, [
          "POST /v1/sessions",
          "POST /v1/sessions/session-1",
          "GET /v1/sessions/session-1",
        ]);
        assert.deepStrictEqual(
          (yield* kept).map(({ status }) => status),
          ["COMPLETED"],
        );
      }).pipe(Effect.provide(TestBrowserbase.layer({ connectUrl })));
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
      }).pipe(Effect.provide(TestBrowserbase.layer({ connectUrl })));
    }),
  );

  it.effect("keeps a context held while a release is unconfirmed, until reconcile ends it", () =>
    Effect.gen(function* () {
      const connectUrl = yield* nowhere;

      yield* Effect.gen(function* () {
        const { id } = yield* Effect.flatMap(BrowserbaseClient, (client) => client.createContext());
        const open = Browserbase.open({ session: persisting(id) }).pipe(Effect.scoped, Effect.flip);
        const first = yield* finish(yield* Effect.forkChild(open));

        assert.strictEqual(first.operation, "connect");

        // The session may still save to the context, so another writer waits.
        const second = yield* Effect.forkChild(open);

        yield* pass(120);
        assert.isUndefined(second.pollUnsafe());
        assert.deepStrictEqual(
          (yield* kept).map(({ status }) => status),
          ["RUNNING"],
        );

        const reconciled = yield* finish(yield* Effect.forkChild(Browserbase.reconcile(id)));

        assert.strictEqual(reconciled._tag, "Settled");
        assert.strictEqual((yield* finish(second)).operation, "connect");
        assert.deepStrictEqual(
          (yield* kept).map(({ id, status, userMetadata }) => [
            id,
            status,
            userMetadata?.["persistsContext"],
          ]),
          [
            ["session-1", "COMPLETED", id],
            ["session-2", "COMPLETED", id],
          ],
        );
      }).pipe(
        Effect.provide(TestBrowserbase.layer({ connectUrl, releases: [{ _tag: "Pending" }] })),
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
        assert.deepStrictEqual(
          (yield* asked).filter((request) => request === "GET /v1/sessions/session-1").length,
          reads.length + 1,
        );
        assert.deepStrictEqual(
          (yield* kept).map(({ status }) => status),
          ["COMPLETED", "COMPLETED"],
        );
      }).pipe(Effect.provide(TestBrowserbase.layer({ connectUrl, reads })));
    }),
  );

  it.effect("finds and ends a persisting session whose create answer was lost", () =>
    Effect.gen(function* () {
      const { id } = yield* Effect.flatMap(BrowserbaseClient, (client) => client.createContext());

      const error = yield* Browserbase.open({ session: persisting(id) }).pipe(
        Effect.scoped,
        Effect.flip,
      );

      assert.deepStrictEqual([error.operation, error.reason._tag], ["createSession", "Transport"]);
      assert.deepStrictEqual(
        (yield* kept).map(({ status }) => status),
        ["RUNNING"],
      );
      assert.strictEqual(
        (yield* finish(yield* Effect.forkChild(Browserbase.reconcile(id))))._tag,
        "Settled",
      );
      assert.deepStrictEqual(
        (yield* kept).map(({ status }) => status),
        ["COMPLETED"],
      );
    }).pipe(Effect.provide(TestBrowserbase.layer({ creates: [{ _tag: "Lost" }] }))),
  );
});

/** A generation's change as one line, such as `2 Reopening` or `1 Closed Settled`. */
const line = ({ number, state }: Supervisor.Generation) =>
  state._tag === "Closed"
    ? `${number} Closed ${state.released?._tag ?? "none"}`
    : `${number} ${state._tag}`;

describe("Browserbase.supervise", () => {
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
        assert.strictEqual((yield* sessions.browser).id, "session-2");
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
      }).pipe(Effect.scoped, Effect.provide(TestBrowserbase.layer({ connectUrl })));
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

        const states = yield* Effect.forkChild(
          Stream.runCollect(Stream.map(sessions.states, line)),
        );

        const first = yield* sessions.browser;
        const second = yield* sessions.rotate;

        assert.deepStrictEqual([first.id, second.id], ["session-1", "session-2"]);
        yield* sessions.retire;

        const lines = yield* Fiber.join(states);

        assert.isBelow(
          lines.indexOf("1 Closed Settled"),
          lines.indexOf("2 Open"),
          lines.join(", "),
        );
        assert.isBelow(
          (yield* asked).indexOf("GET /v1/sessions/session-1"),
          (yield* asked).lastIndexOf("POST /v1/sessions"),
        );
      }).pipe(Effect.scoped, Effect.provide(TestBrowserbase.layer({ connectUrl })));
    }),
  );
});
