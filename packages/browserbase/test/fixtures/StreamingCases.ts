import assert from "node:assert/strict";
import { Deferred, Effect, Fiber, Redacted, Stream } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import { BrowserbaseClient } from "../../src/Client.ts";

const account = { projectId: "stream-project", apiKey: Redacted.make("stream-key"), artifactOrigins: ["https://media.example.test"] };

const transfer = (media: boolean) => ({
  name: `${media ? "media" : "API"} response stays scoped until delayed body consumption ends`,
  run: Effect.gen(function* () {
    let aborted = 0;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      assert.equal(request.headers.get("x-bb-api-key"), media ? null : "stream-key");
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          let done = false;
          const timer = setTimeout(() => {
            if (done) return;
            done = true;
            controller.enqueue(new Uint8Array([1, 2, 3]));
            controller.close();
          }, 5);
          request.signal.addEventListener("abort", () => {
            aborted++;
            clearTimeout(timer);
            if (!done) { done = true; controller.error(new Error("request ended before body")); }
          }, { once: true });
        },
      });
      return new Response(body, { headers: { "content-type": "application/octet-stream", "content-length": "3" } });
    };
    yield* Effect.gen(function* () {
      const client = yield* BrowserbaseClient;
      const source = media
        ? client.media(Redacted.make("https://media.example.test/recording"), 3, ["application/octet-stream"])
        : client.bytes("/v1/downloads/file", 3, ["application/octet-stream"], "test-stream");
      const chunks = yield* Stream.runCollect(source);
      assert.deepEqual(Array.from(chunks).flatMap((chunk) => [...chunk]), [1, 2, 3]);
      assert.equal(aborted, 1);
    }).pipe(Effect.provide(BrowserbaseClient.layer(account)), Effect.provideService(FetchHttpClient.Fetch, fetch));
  }),
});

export const streamingCases = [transfer(false), transfer(true), {
  name: "interrupting a stream consumer aborts the still-pending response exactly once",
  run: Effect.scoped(Effect.gen(function* () {
    let aborted = 0;
    const entered = yield* Deferred.make<void>();
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          request.signal.addEventListener("abort", () => {
            aborted++;
            controller.error(new Error("aborted"));
          }, { once: true });
          controller.enqueue(new Uint8Array([1]));
        },
      }), { headers: { "content-type": "application/octet-stream" } });
    };
    yield* Effect.gen(function* () {
      const client = yield* BrowserbaseClient;
      const fiber = yield* client.bytes("/v1/downloads/file", 10, ["application/octet-stream"], "interrupt-test").pipe(
        Stream.runForEach(() => Deferred.succeed(entered, undefined)), Effect.forkChild,
      );
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(fiber);
      assert.equal(aborted, 1);
    }).pipe(Effect.provide(BrowserbaseClient.layer(account)), Effect.provideService(FetchHttpClient.Fetch, fetch));
  })),
}];
