// PLAN T6: replay must exercise the HTTP codec and reject changed tools or an unreserved request.
import { assert, it } from "@effect/vitest";
import { ConfigProvider, Effect } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { HttpCassette } from "../src/testing.ts";

it.effect(
  "records HTTP answers and replays normalized messages with schema-sensitive identity",
  () =>
    Effect.gen(function* () {
      let calls = 0;

      const upstream = HttpClient.make((request) =>
        Effect.sync(() => {
          calls++;

          return HttpClientResponse.fromWeb(
            request,
            new Response('{"ok":true}', { headers: { "content-type": "application/json" } }),
          );
        }),
      );

      const written: Array<HttpCassette.Exchange> = [];

      const request = (parameters: unknown) =>
        HttpClientRequest.post("https://model.test/chat?token=secret", {
          headers: { authorization: "Bearer private" },
        }).pipe(
          HttpClientRequest.bodyText(
            JSON.stringify({
              model: "scripted",
              messages: [{ role: "user", content: "go" }],
              tools: [{ name: "click", parameters }],
            }),
            "application/json",
          ),
        );

      const recording = yield* HttpCassette.make({
        mode: "record",
        http: upstream,
        cap: 2,
        reserve: () => Effect.succeed(1),
        append: (exchange) => Effect.sync(() => void written.push(exchange)),
      });

      assert.deepStrictEqual(
        yield* (yield* recording.http.execute(request({ ref: "string", count: "number" }))).json,
        { ok: true },
      );
      const replay = yield* HttpCassette.make({ mode: "replay", exchanges: written });

      assert.deepStrictEqual(
        yield* (yield* replay.http.execute(request({ count: "number", ref: "string" }))).json,
        {
          ok: true,
        },
      );
      yield* replay.assertExhausted;
      const changed = yield* HttpCassette.make({ mode: "replay", exchanges: written });
      const mismatch = yield* changed.http.execute(request({ x: "number" })).pipe(Effect.flip);

      assert.include(mismatch.message, "re-record");
      assert.strictEqual(calls, 1);
      assert.notInclude(JSON.stringify(written), "private");
      assert.notInclude(JSON.stringify(written), "secret");
    }).pipe(
      Effect.provide(
        ConfigProvider.layer(ConfigProvider.fromUnknown({ EFFECT_BROWSER_BENCH_LIVE: "1" })),
      ),
    ),
);

it.effect("requires exact opt-in and reserves the full cap before dispatch", () =>
  Effect.gen(function* () {
    let calls = 0;

    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        calls++;

        return HttpClientResponse.fromWeb(request, new Response("ok"));
      }),
    );

    const options = { mode: "live" as const, http, cap: 1, reserve: () => Effect.succeed(1) };
    const denied = yield* HttpCassette.make(options).pipe(Effect.flip);

    assert.include(denied.detail, "exactly 1");
    yield* Effect.gen(function* () {
      const live = yield* HttpCassette.make(options);

      yield* live.http.get("https://model.test");
      yield* live.http.get("https://model.test").pipe(Effect.flip);
      assert.strictEqual(calls, 1, "the second request cannot cross the reservation boundary");
    }).pipe(
      Effect.provide(
        ConfigProvider.layer(ConfigProvider.fromUnknown({ EFFECT_BROWSER_BENCH_LIVE: "1" })),
      ),
    );
  }).pipe(
    Effect.provide(
      ConfigProvider.layer(ConfigProvider.fromUnknown({ EFFECT_BROWSER_BENCH_LIVE: "yes" })),
    ),
  ),
);
