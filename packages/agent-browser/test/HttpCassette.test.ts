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

it.effect("counts a settled recording at its charge, so the cap bounds spend, not requests", () =>
  Effect.gen(function* () {
    let calls = 0;

    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        calls++;

        return HttpClientResponse.fromWeb(request, new Response('{"cost":0.25}'));
      }),
    );

    const charge = (response: HttpCassette.Exchange["response"]) =>
      response.body.includes("cost") ? 0.25 : undefined;

    const cassette = yield* HttpCassette.make({
      mode: "record",
      http,
      cap: 2,
      reserve: () => Effect.succeed(1),
      settle: charge,
      append: () => Effect.void,
    });

    // Each request needs 1 of the cap of 2 free and settles at 0.25: five fit, the sixth does not.
    for (let request = 0; request < 5; request++) yield* cassette.http.get("https://model.test");
    yield* cassette.http.get("https://model.test").pipe(Effect.flip);
    assert.strictEqual(calls, 5);
  }).pipe(
    Effect.provide(
      ConfigProvider.layer(ConfigProvider.fromUnknown({ EFFECT_BROWSER_BENCH_LIVE: "1" })),
    ),
  ),
);

// 1d6d7c7: reconstructing Fetch null-body responses with an empty string caused a defect.
it.effect("records and replays responses whose status forbids a body", () =>
  Effect.gen(function* () {
    const written: Array<HttpCassette.Exchange> = [];
    let status = 204;

    const recording = yield* HttpCassette.make({
      mode: "record",
      http: HttpClient.make((request) =>
        Effect.sync(() => HttpClientResponse.fromWeb(request, new Response(null, { status }))),
      ),
      cap: 3,
      reserve: () => Effect.succeed(1),
      append: (exchange) => Effect.sync(() => void written.push(exchange)),
    });

    for (status of [204, 205, 304]) {
      const response = yield* recording.http.get("https://model.test");

      assert.strictEqual(response.status, status);
      assert.strictEqual(yield* response.text, "");
    }
    const replay = yield* HttpCassette.make({ mode: "replay", exchanges: written });

    for (const expected of [204, 205, 304]) {
      const response = yield* replay.http.get("https://model.test");

      assert.strictEqual(response.status, expected);
      assert.strictEqual(yield* response.text, "");
    }
    yield* replay.assertExhausted;
  }).pipe(
    Effect.provide(
      ConfigProvider.layer(ConfigProvider.fromUnknown({ EFFECT_BROWSER_BENCH_LIVE: "1" })),
    ),
  ),
);
