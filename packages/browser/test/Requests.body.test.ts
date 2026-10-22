// Policies receive exact UTF-8 request bytes; incomplete or binary protocol evidence fails closed.
import { createServer } from "node:http";

import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Base64 } from "effect/encoding";
import { chromium } from "playwright-core";

import * as Browser from "../src/Browser.ts";
import * as TestCdp from "./support/TestCdp.ts";

const Paused = Schema.Struct({
  requestId: Schema.String,
  frameId: Schema.optional(Schema.String),
  request: Schema.Struct({ url: Schema.String, method: Schema.String }),
});

for (const variant of [
  "missing-text",
  "missing-entries",
  "missing-bytes",
  "binary",
  "mismatch",
  "text",
  "native-text",
  "native-multipart",
] as const)
  it.live(`requires complete lossless request body evidence: ${variant}`, () =>
    Effect.gen(function* () {
      const hits: string[] = [];

      const server = yield* Effect.acquireRelease(
        Effect.callback<ReturnType<typeof createServer>>((resume) => {
          const server = createServer((request, response) => {
            if (request.method === "POST") hits.push(request.url ?? "");
            response.setHeader("access-control-allow-origin", "*");
            response.end("received");
          });

          server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
        }),
        (server) =>
          Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                server.close(() => resolve());
              }),
          ),
      );

      const address = server.address();

      assert.isTrue(typeof address === "object" && address !== null);
      const origin = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;

      const native = yield* Effect.acquireRelease(
        Effect.promise(() => chromium.launch()),
        (browser) => Effect.promise(() => browser.close()),
      );

      const context = yield* Effect.promise(() => native.newContext());
      const faults = yield* TestCdp.make();
      const seen: Array<string | null> = [];

      if (!variant.startsWith("native-"))
        faults.rule(
          { channel: "browser", method: "Fetch.requestPaused" },
          {
            _tag: "Transform",
            reply: (event) => {
              const paused = Schema.decodeUnknownSync(Paused)(event);

              return {
                ...paused,
                request: {
                  ...paused.request,
                  hasPostData: true,
                  postData: variant === "missing-text" ? undefined : "body ✓",
                  postDataEntries:
                    variant === "missing-entries"
                      ? undefined
                      : variant === "missing-bytes"
                        ? [{}]
                        : [
                            {
                              bytes:
                                variant === "binary"
                                  ? Base64.encode(new Uint8Array([255]))
                                  : Base64.encode(variant === "mismatch" ? "different" : "body ✓"),
                            },
                          ],
                },
              };
            },
          },
          { phase: "event", times: 1 },
        );

      const browser = yield* faults.provide(
        Browser.make(
          context,
          { provider: "body-evidence-fixture" },
          {
            requests: {
              patterns: [`${origin}/post`],
              decide: ({ body }) =>
                Effect.sync(() => {
                  seen.push(body);

                  return { _tag: "Allowed" as const };
                }),
            },
          },
        ),
      );

      const page = yield* browser.newPage(origin);
      const fixture = yield* faults.native(page.id);

      const result = yield* Effect.promise(() =>
        fixture.evaluate(
          async ({ url, multipart }) => {
            const form = new FormData();

            form.set("field", "body ✓");
            form.set("file", new File(["file ✓"], "note.txt", { type: "text/plain" }));

            return fetch(url, { method: "POST", body: multipart ? form : "body ✓" }).then(
              () => "went",
              () => "blocked",
            );
          },
          { url: `${origin}/post`, multipart: variant === "native-multipart" },
        ),
      );

      if (variant === "text" || variant.startsWith("native-")) {
        assert.strictEqual(result, "went");
        if (variant === "native-multipart") {
          assert.strictEqual(seen.length, 1);
          assert.include(seen[0], "body ✓");
          assert.include(seen[0], "file ✓");
        } else assert.deepStrictEqual(seen, ["body ✓"]);
        assert.deepStrictEqual(hits, ["/post"]);
      } else {
        assert.strictEqual(result, "blocked");
        assert.deepStrictEqual(seen, []);
        assert.deepStrictEqual(hits, []);
        yield* browser.newPage("about:blank");
        assert.isTrue(
          (yield* browser.recentEvents).some(
            (event) =>
              event._tag === "RequestRefused" &&
              event.reason === "request body was not fully observable as UTF-8 text",
          ),
        );
      }
    }).pipe(Effect.scoped),
  );
