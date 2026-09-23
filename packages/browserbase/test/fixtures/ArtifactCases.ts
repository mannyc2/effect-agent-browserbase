import assert from "node:assert/strict";

import { Effect, Layer, Redacted, Schema, Stream } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import { BrowserbaseClient } from "../../src/Client.ts";
import { BrowserbaseDownloads } from "../../src/Downloads.ts";
import { ClientError, type ArtifactError, type FileError } from "../../src/Errors.ts";
import { BrowserbaseRecordings } from "../../src/Recordings.ts";
import { SessionReference } from "../../src/References.ts";
import { BrowserbaseReplays } from "../../src/Replays.ts";
import { BrowserbaseSessions } from "../../src/Sessions.ts";
import { RecordingPageReference } from "../../src/Transfers.ts";
import { elapse, timed } from "./Time.ts";

const ref = SessionReference.make({
  provider: "browserbase",
  projectId: "project-1",
  sessionId: "session-1",
});

const page = RecordingPageReference.make({ session: ref, pageId: "0" });

const options = {
  projectId: "project-1",
  apiKey: Redacted.make("PRIVATE-API-KEY"),
  artifactOrigins: ["https://media.example.test"],
};

/** The canonical resource services read the exact session through one shared account. */
const account = BrowserbaseSessions.layer.pipe(
  Layer.provideMerge(BrowserbaseClient.layer(options)),
);

const metadata = (status = "COMPLETED") =>
  Response.json({
    id: ref.sessionId,
    projectId: ref.projectId,
    status,
    createdAt: "2026-09-20T19:00:00.000Z",
    updatedAt: "2026-09-20T19:01:00.000Z",
    expiresAt: "2026-09-20T20:00:00.000Z",
    startedAt: "2026-09-20T19:00:01.000Z",
    keepAlive: false,
    proxyBytes: 0,
    region: "us-east-1",
  });

const pending = { downloads: [{ pageId: "0", status: "PENDING" }] };

const completed = {
  downloads: [
    {
      pageId: "0",
      status: "COMPLETED",
      downloadUrl: "https://media.example.test/video?token=PRIVATE-SIGNED",
    },
  ],
};

interface Declared {
  readonly reason: string;
}

const expectReason = <A, E extends Declared, R>(
  effect: Effect.Effect<A, E, R>,
  reason: E["reason"],
) =>
  effect.pipe(
    Effect.result,
    Effect.map((result) => {
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.equal(result.failure.reason, reason);
    }),
  );

const withRecordings = <A>(
  fetch: typeof globalThis.fetch,
  body: (api: BrowserbaseRecordings["Service"]) => Effect.Effect<A, ArtifactError>,
) =>
  Effect.gen(function* () {
    return yield* body(yield* BrowserbaseRecordings);
  }).pipe(
    Effect.provide(BrowserbaseRecordings.layer.pipe(Layer.provide(account))),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
  );

const withReplays = <A>(
  fetch: typeof globalThis.fetch,
  body: (api: BrowserbaseReplays["Service"]) => Effect.Effect<A, ArtifactError>,
) =>
  Effect.gen(function* () {
    return yield* body(yield* BrowserbaseReplays);
  }).pipe(
    Effect.provide(BrowserbaseReplays.layer.pipe(Layer.provide(account))),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
  );

const withClient = <A, E>(
  fetch: typeof globalThis.fetch,
  body: (client: BrowserbaseClient["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    return yield* body(yield* BrowserbaseClient);
  }).pipe(
    Effect.provide(BrowserbaseClient.layer(options)),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
  );

const withDownloads = <A>(
  fetch: typeof globalThis.fetch,
  body: (api: BrowserbaseDownloads["Service"]) => Effect.Effect<A, FileError>,
) =>
  Effect.gen(function* () {
    return yield* body(yield* BrowserbaseDownloads);
  }).pipe(
    Effect.provide(BrowserbaseDownloads.layer.pipe(Layer.provide(account))),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
  );

export const artifactCases = [
  {
    name: "recording request inspects status, posts once, and preserves per-page states",
    run: Effect.gen(function* () {
      let posts = 0;

      yield* withRecordings(
        async (input, init) => {
          const req = new Request(input, init);

          if (!req.url.includes("/recording/")) return metadata();
          if (req.method === "POST") {
            posts++;

            return Response.json(pending, { status: 202 });
          }

          return Response.json(
            posts === 0 ? { downloads: [{ pageId: "0", status: "NOT_REQUESTED" }] } : pending,
          );
        },
        (api) =>
          Effect.gen(function* () {
            assert.equal((yield* api.request(ref)).pages[0]?.status, "PENDING");
            assert.equal((yield* api.request(ref)).pages[0]?.status, "PENDING");
          }),
      );
      assert.equal(posts, 1);
    }),
  },
  {
    name: "lost assembly response remains uncertain and is not automatically posted again",
    run: Effect.gen(function* () {
      let posts = 0;

      yield* withRecordings(
        async (input, init) => {
          const req = new Request(input, init);

          if (!req.url.includes("/recording/")) return metadata();
          if (req.method === "POST") {
            posts++;
            throw new Error("PRIVATE-POST-REPLY");
          }

          return Response.json(
            posts ? pending : { downloads: [{ pageId: "0", status: "NOT_REQUESTED" }] },
          );
        },
        (api) =>
          Effect.gen(function* () {
            yield* expectReason(api.request(ref), "assembly-unknown");
            yield* api.request(ref);
          }),
      );
      assert.equal(posts, 1);
    }),
  },
  {
    name: "recording wait returns completed and failed pages independently",
    run: Effect.gen(function* () {
      let reads = 0;

      yield* withRecordings(
        async (input) => {
          if (!String(input).includes("/recording/")) return metadata();

          return Response.json(
            ++reads < 2
              ? pending
              : { downloads: [...completed.downloads, { pageId: "1", status: "FAILED" }] },
          );
        },
        (api) =>
          Effect.gen(function* () {
            const batch = yield* elapse(
              api.wait(ref, { timeoutMillis: 200, intervalMillis: 10 }),
              10,
            );

            assert.equal(batch.timedOut, false);
            assert.deepEqual(
              batch.pages.map((p) => p.status),
              ["COMPLETED", "FAILED"],
            );
          }),
      );
    }),
  },
  {
    name: "bounded recording polling returns latest partial status, not a fabricated permanent failure",
    run: withRecordings(
      async (input) =>
        String(input).includes("/recording/") ? Response.json(pending) : metadata(),
      (api) =>
        Effect.gen(function* () {
          const batch = yield* elapse(api.wait(ref, { timeoutMillis: 30, intervalMillis: 10 }), 30);

          assert.equal(batch.timedOut, true);
          assert.equal(batch.pages[0]?.status, "PENDING");
        }),
    ),
  },
  ...([409, 410, 422, 429] as const).map((status) => ({
    name: `recording API preserves ${status} as a bounded typed state`,
    run: withRecordings(
      async (input) =>
        String(input).includes("/recording/")
          ? Response.json({ detail: "PRIVATE-BODY" }, { status, headers: { "retry-after": "60" } })
          : metadata(),
      (api) =>
        expectReason(
          api.status(ref),
          status === 409
            ? "active"
            : status === 410
              ? "expired"
              : status === 422
                ? "disabled"
                : "rate-limited",
        ),
    ),
  })),
  {
    name: "BYOS completion without a URL does not become a corrupt download",
    run: withRecordings(
      async (input) =>
        String(input).includes("/recording/")
          ? Response.json({ downloads: [{ pageId: "0", status: "COMPLETED" }] })
          : metadata(),
      (api) =>
        Effect.gen(function* () {
          assert.equal((yield* api.status(ref)).pages[0]?.delivery, "external-storage");
          yield* expectReason(Stream.runDrain(api.download(page, { maxBytes: 1000 })), "byos");
        }),
    ),
  },
  {
    name: "artifact download refreshes access, strips API credentials, and streams owned bytes",
    run: Effect.gen(function* () {
      let mediaReads = 0,
        statusReads = 0;

      const first = new Uint8Array([1, 2, 3]);

      yield* withRecordings(
        async (input, init) => {
          const req = new Request(input, init);

          if (new URL(req.url).origin === "https://media.example.test") {
            mediaReads++;
            assert.ok(req.url.includes("fresh"));
            assert.equal(req.headers.has("x-bb-api-key"), false);
            assert.equal(req.redirect, "manual");
            // Assert the transport argument rather than Bun's reconstructed Request
            // accessor, which reports "include" even for credentials: "omit".
            assert.equal(init?.credentials, "omit");
            assert.equal(req.headers.has("authorization"), false);
            assert.equal(req.headers.has("cookie"), false);

            return new Response(first, { headers: { "content-type": "video/mp4" } });
          }
          if (req.url.includes("/recording/"))
            return Response.json({
              downloads: [
                {
                  pageId: "0",
                  status: "COMPLETED",
                  downloadUrl: `https://media.example.test/video?token=${++statusReads > 1 ? "fresh" : "old"}`,
                },
              ],
            });

          return metadata();
        },
        (api) =>
          Effect.gen(function* () {
            const status = yield* api.status(ref);

            assert.ok(!JSON.stringify(status).includes("downloadUrl"));
            const chunks = yield* Stream.runCollect(api.download(page, { maxBytes: 1000 }));

            assert.deepEqual([...chunks[0]!], [1, 2, 3]);
            chunks[0]![0] = 100;
            assert.equal(first[0], 1);
          }),
      );
      assert.equal(statusReads, 2);
      assert.equal(mediaReads, 1);
    }),
  },
  {
    name: "unapproved signed media origin is rejected before a media request",
    run: Effect.gen(function* () {
      let external = 0;

      yield* withRecordings(
        async (input) => {
          if (!String(input).startsWith("https://api.browserbase.com")) external++;

          return String(input).includes("/recording/")
            ? Response.json({
                downloads: [
                  {
                    pageId: "0",
                    status: "COMPLETED",
                    downloadUrl: "https://attacker.invalid/video",
                  },
                ],
              })
            : metadata();
        },
        (api) =>
          expectReason(Stream.runDrain(api.download(page, { maxBytes: 1000 })), "unsafe-url"),
      );
      assert.equal(external, 0);
    }),
  },
  {
    name: "credential-preserving API policy ignores ambient headers and redirect options",
    run: Effect.gen(function* () {
      let requests = 0;

      yield* withClient(
        async (input, init) => {
          const request = new Request(input, init);

          requests++;
          assert.equal(request.redirect, "manual");
          assert.equal(request.headers.has("authorization"), false);
          assert.equal(request.headers.has("x-ambient"), false);
          assert.equal(request.headers.has("traceparent"), false);
          assert.equal(request.headers.get("x-bb-api-key"), "PRIVATE-API-KEY");

          return Response.json({ ok: true });
        },
        (client) =>
          client.json("GET", "/v1/sessions/session-1").pipe(
            Effect.provideService(FetchHttpClient.RequestInit, {
              redirect: "follow",
              headers: { authorization: "PRIVATE-AMBIENT", "x-ambient": "wrong" },
            }),
          ),
      );
      assert.equal(requests, 1);
    }),
  },
  {
    name: "GET retry budget is separate from non-retried POST mutations",
    run: Effect.gen(function* () {
      let calls = 0;

      const fetch: typeof globalThis.fetch = async () => {
        calls++;

        return calls < 3 ? Response.json({}, { status: 500 }) : Response.json({ ok: true });
      };

      yield* withClient(fetch, (client) =>
        elapse(client.json("GET", "/v1/sessions/session-1"), 450),
      );
      assert.equal(calls, 3);
      calls = 0;
      yield* withClient(fetch, (client) =>
        expectReason(client.json("POST", "/v1/sessions", {}), "provider"),
      );
      assert.equal(calls, 1);
    }),
  },
  {
    name: "HTTP byte limits apply to actual streamed bytes without Content-Length",
    run: withClient(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(8));
              controller.enqueue(new Uint8Array(8));
              controller.close();
            },
          }),
          { headers: { "content-type": "video/mp4" } },
        ),
      (client) =>
        expectReason(
          Stream.runDrain(
            client.media(Redacted.make("https://media.example.test/video"), 10, ["video/mp4"]),
          ),
          "limit",
        ),
    ),
  },
  {
    name: "early stream completion releases the request scope",
    run: Effect.gen(function* () {
      let signal: AbortSignal | undefined;

      yield* withClient(
        async (_input, init) => {
          signal = init?.signal ?? undefined;

          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array([1]));
              },
            }),
            { headers: { "content-type": "video/mp4" } },
          );
        },
        (client) =>
          client
            .media(Redacted.make("https://media.example.test/video"), 10, ["video/mp4"])
            .pipe(Stream.take(1), Stream.runDrain),
      );
      assert.equal(signal?.aborted, true);
    }),
  },
  {
    name: "redirects do not forward provider credentials or signed-media access",
    run: Effect.gen(function* () {
      let calls = 0;

      const fetch: typeof globalThis.fetch = async () => {
        calls++;

        return new Response(null, {
          status: 302,
          headers: { location: "https://attacker.invalid/" },
        });
      };

      yield* withClient(fetch, (client) =>
        expectReason(client.json("GET", "/v1/sessions/session-1"), "provider"),
      );
      yield* withClient(fetch, (client) =>
        expectReason(
          Stream.runDrain(
            client.media(Redacted.make("https://media.example.test/video"), 10, ["video/mp4"]),
          ),
          "provider",
        ),
      );
      assert.equal(calls, 2);
    }),
  },
  {
    name: "malformed UTF-8 is a sanitized protocol failure",
    run: Effect.gen(function* () {
      const result = yield* withClient(
        async () =>
          new Response(new Uint8Array([0xc3, 0x28]), {
            headers: { "content-type": "application/json" },
          }),
        (client) => client.json("GET", "/v1/sessions/session-1").pipe(Effect.result),
      );

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure.reason, "malformed");

        // Schema failure here is a fixture defect, not part of the runtime error channel.
        const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(ClientError))(
          result.failure,
        ).pipe(Effect.orDie);

        assert.ok(!encoded.includes("PRIVATE"));
      }
    }),
  },
  {
    name: "replay access serves existing VOD material without recording or browser allocation",
    run: Effect.gen(function* () {
      const calls: string[] = [];

      yield* withReplays(
        async (input, init) => {
          const req = new Request(input, init);

          calls.push(req.method);
          if (req.url.endsWith("/replays"))
            return Response.json({
              pageCount: 1,
              pages: [{ pageId: "0", startTimeMs: 0, endTimeMs: 1000, url: "ignored" }],
            });
          if (req.url.endsWith("/replays/0"))
            return new Response(
              '#EXTM3U\n#EXT-X-MAP:URI="https://media.example.test/init?token=PRIVATE"\n#EXTINF:1,\nhttps://media.example.test/segment?token=PRIVATE\n#EXT-X-ENDLIST\n',
              { headers: { "content-type": "application/vnd.apple.mpegurl" } },
            );
          if (req.url.startsWith("https://media.example.test")) {
            assert.equal(req.headers.has("x-bb-api-key"), false);

            return new Response(new Uint8Array([1]), { headers: { "content-type": "video/mp4" } });
          }

          return metadata();
        },
        (api) =>
          Effect.gen(function* () {
            const access = yield* api.openPage(page);

            assert.equal(access.mediaCount, 2);
            yield* Stream.runDrain(access.media(1, { maxBytes: 100 }));
          }),
      );
      assert.ok(calls.every((method) => method === "GET"));
    }),
  },
  {
    name: "replay rejects encrypted or foreign-origin playlists rather than leaking credentials",
    run: withReplays(
      async (input) => {
        if (String(input).endsWith("/replays"))
          return Response.json({
            pageCount: 1,
            pages: [{ pageId: "0", startTimeMs: 0, endTimeMs: 1000, url: "ignored" }],
          });
        if (String(input).endsWith("/replays/0"))
          return new Response(
            '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://attacker.invalid/key"\n#EXT-X-ENDLIST\n',
            { headers: { "content-type": "application/vnd.apple.mpegurl" } },
          );

        return metadata();
      },
      (api) => expectReason(api.openPage(page), "malformed"),
    ),
  },
  {
    name: "ordinary download metadata and streaming are separate from recording artifacts",
    run: Effect.gen(function* () {
      const file = {
        id: "download-1",
        sessionId: "session-1",
        filename: "fixture.txt",
        mimeType: "text/plain",
        size: 3,
        checksum: "0".repeat(64),
        createdAt: "2026-09-17T00:00:00Z",
      };

      yield* withDownloads(
        async (input, init) => {
          const req = new Request(input, init);

          if (req.url.includes("/v1/downloads?"))
            return Response.json({ downloads: [file], total: 1 });
          if (req.url.includes("/v1/downloads/"))
            return req.headers.get("accept") === "application/json"
              ? Response.json(file)
              : new Response(new Uint8Array([1, 2, 3]), {
                  headers: { "content-type": "application/octet-stream" },
                });

          return metadata();
        },
        (api) =>
          Effect.gen(function* () {
            const fresh = yield* api.waitForNew(ref, []);

            assert.equal(fresh[0]?.id, "download-1");

            const chunks = yield* Stream.runCollect(
              api.stream(ref, "download-1", { maxBytes: 100, mimeTypes: ["text/plain"] }),
            );

            assert.equal(
              chunks.reduce((sum, bytes) => sum + bytes.length, 0),
              3,
            );
          }),
      );
    }),
  },
  {
    name: "unsafe website filenames fail before a content request",
    run: Effect.gen(function* () {
      let contentRequests = 0;

      yield* withDownloads(
        async (input, init) => {
          const req = new Request(input, init);

          if (req.url.includes("/v1/downloads/")) {
            if (req.headers.get("accept") !== "application/json") contentRequests++;

            return Response.json({
              id: "download-1",
              sessionId: "session-1",
              filename: "../escape.txt",
              mimeType: "text/plain",
              size: 1,
              checksum: "0".repeat(64),
              createdAt: "2026-09-17T00:00:00Z",
            });
          }

          return metadata();
        },
        (api) =>
          expectReason(
            Stream.runDrain(
              api.stream(ref, "download-1", { maxBytes: 100, mimeTypes: ["text/plain"] }),
            ),
            "malformed",
          ),
      );
      assert.equal(contentRequests, 0);
    }),
  },
  {
    name: "recording byte limits are owned before provider authorization yields",
    run: Effect.gen(function* () {
      const limits = { maxBytes: 1 };

      yield* withRecordings(
        async (input, init) => {
          const request = new Request(input, init);

          if (request.url.startsWith("https://media.example.test"))
            return new Response(new Uint8Array([1, 2, 3]), {
              headers: { "content-type": "video/mp4" },
            });
          if (request.url.includes("/recording/")) return Response.json(completed);
          limits.maxBytes = 100;

          return metadata();
        },
        (api) => expectReason(Stream.runDrain(api.download(page, limits)), "limit"),
      );
      assert.equal(limits.maxBytes, 100);
    }),
  },
  {
    name: "website download byte limits do not change when a caller mutates them during metadata",
    run: Effect.gen(function* () {
      const policy = { maxBytes: 1, mimeTypes: ["text/plain"] };
      let contentRequests = 0;

      yield* withDownloads(
        async (input, init) => {
          const request = new Request(input, init);

          if (request.url.includes("/v1/downloads/")) {
            if (request.headers.get("accept") === "application/json")
              return Response.json({
                id: "download-1",
                sessionId: "session-1",
                filename: "fixture.txt",
                mimeType: "text/plain",
                size: 3,
                checksum: "0".repeat(64),
                createdAt: "2026-09-17T00:00:00Z",
              });
            contentRequests++;

            return new Response(new Uint8Array([1, 2, 3]), {
              headers: { "content-type": "application/octet-stream" },
            });
          }
          policy.maxBytes = 100;

          return metadata();
        },
        (api) => expectReason(Stream.runDrain(api.stream(ref, "download-1", policy)), "limit"),
      );
      assert.equal(contentRequests, 0);
    }),
  },
  {
    name: "website MIME authority is a snapshot rather than a mutable caller array",
    run: Effect.gen(function* () {
      const policy = { maxBytes: 100, mimeTypes: ["text/plain"] };
      let contentRequests = 0;

      yield* withDownloads(
        async (input, init) => {
          const request = new Request(input, init);

          if (request.url.includes("/v1/downloads/")) {
            if (request.headers.get("accept") === "application/json")
              return Response.json({
                id: "download-1",
                sessionId: "session-1",
                filename: "fixture.bin",
                mimeType: "application/octet-stream",
                size: 3,
                checksum: "0".repeat(64),
                createdAt: "2026-09-17T00:00:00Z",
              });
            contentRequests++;

            return new Response(new Uint8Array([1, 2, 3]), {
              headers: { "content-type": "application/octet-stream" },
            });
          }
          policy.mimeTypes.push("application/octet-stream");

          return metadata();
        },
        (api) =>
          expectReason(Stream.runDrain(api.stream(ref, "download-1", policy)), "content-type"),
      );
      assert.equal(contentRequests, 0);
      assert.deepEqual(policy.mimeTypes, ["text/plain", "application/octet-stream"]);
    }),
  },
  {
    name: "recording and website transfer configuration fails before a provider request",
    run: Effect.gen(function* () {
      let calls = 0;

      const fetch: typeof globalThis.fetch = async () => {
        calls++;

        return metadata();
      };

      for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31]) {
        yield* withRecordings(fetch, (api) =>
          expectReason(Stream.runDrain(api.download(page, { maxBytes: invalid })), "configuration"),
        );
        yield* withDownloads(fetch, (api) =>
          expectReason(
            Stream.runDrain(
              api.stream(ref, "download-1", { maxBytes: invalid, mimeTypes: ["text/plain"] }),
            ),
            "configuration",
          ),
        );
      }
      for (const timeoutMillis of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 600001]) {
        yield* withRecordings(fetch, (api) =>
          expectReason(
            Stream.runDrain(api.download(page, { maxBytes: 1, timeoutMillis })),
            "configuration",
          ),
        );
        yield* withDownloads(fetch, (api) =>
          expectReason(
            Stream.runDrain(
              api.stream(ref, "download-1", {
                maxBytes: 1,
                timeoutMillis,
                mimeTypes: ["text/plain"],
              }),
            ),
            "configuration",
          ),
        );
      }
      assert.equal(calls, 0);
    }),
  },
  {
    name: "replay indexed transfers retain call-time bounds and reject invalid configuration before media access",
    run: Effect.gen(function* () {
      let mediaRequests = 0;

      yield* withReplays(
        async (input, init) => {
          const request = new Request(input, init);

          if (request.url.endsWith("/replays"))
            return Response.json({
              pageCount: 1,
              pages: [{ pageId: "0", startTimeMs: 0, endTimeMs: 1000, url: "ignored" }],
            });
          if (request.url.endsWith("/replays/0"))
            return new Response(
              "#EXTM3U\n#EXTINF:1,\nhttps://media.example.test/segment\n#EXT-X-ENDLIST\n",
              { headers: { "content-type": "application/vnd.apple.mpegurl" } },
            );
          if (request.url.startsWith("https://media.example.test")) {
            mediaRequests++;

            return new Response(new Uint8Array([1, 2, 3]), {
              headers: { "content-type": "video/mp4" },
            });
          }

          return metadata();
        },
        (api) =>
          Effect.gen(function* () {
            const access = yield* api.openPage(page);

            for (const maxBytes of [0, -1, Number.NaN, 2 ** 31])
              yield* expectReason(Stream.runDrain(access.media(0, { maxBytes })), "configuration");
            assert.equal(mediaRequests, 0);
            const limits = { maxBytes: 1 };
            const media = access.media(0, limits);

            limits.maxBytes = 100;
            yield* expectReason(Stream.runDrain(media), "limit");
          }),
      );
      assert.equal(mediaRequests, 1);
    }),
  },
].map((test) => ({ ...test, run: timed(test.run) }));
