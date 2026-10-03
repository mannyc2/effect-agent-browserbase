import { expect, it } from "@effect/vitest";
import { Clock, Deferred, Effect, Fiber, Redacted } from "effect";
import { TestClock } from "effect/testing";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";

import { makeObservation } from "../src/internal/browser/Observation.ts";
import { observationWebSocket } from "../src/internal/browser/ObservationEndpoint.ts";

const from = (endpoint: string, fetch: typeof globalThis.fetch) =>
  HttpClient.HttpClient.pipe(
    Effect.flatMap((client) => observationWebSocket(client, endpoint)),
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
  );

it.effect("host HTTP discovery preserves routing and sends no inherited credentials", () =>
  Effect.gen(function* () {
    const requests: Array<Request> = [];
    const options: Array<RequestInit | undefined> = [];

    const fetch: typeof globalThis.fetch = (input, init) => {
      requests.push(new Request(input, init));
      options.push(init);

      return Promise.resolve(
        Response.json({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/session" }),
      );
    };

    const endpoint = yield* from("http://127.0.0.1:9222/prefix?token=host", fetch).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, {
        credentials: "include",
        headers: { authorization: "provider-secret", "x-bb-api-key": "provider-secret" },
      }),
    );

    expect(endpoint).toBe("ws://127.0.0.1:9222/devtools/browser/session");
    expect(requests.map((request) => request.url)).toEqual([
      "http://127.0.0.1:9222/prefix/json/version/?token=host",
    ]);
    expect([...requests[0]!.headers]).toEqual([]);
    expect(options[0]?.credentials).toBe("omit");
    expect(options[0]?.redirect).toBe("error");
    expect(yield* from("wss://connect.browserbase.com/?session=1&key=private", fetch)).toBe(
      "wss://connect.browserbase.com/?session=1&key=private",
    );
    expect(requests).toHaveLength(1);
  }),
);

it.effect(
  "discovery rejects malformed, oversized, and failed replies without exposing addresses",
  () =>
    Effect.gen(function* () {
      const scenarios = [
        {
          response: () => Response.json({ webSocketDebuggerUrl: "http://private.invalid/secret" }),
          reason: "UnsafeUrl",
        },
        { response: () => new Response("private-secret malformed JSON"), reason: "Malformed" },
        { response: () => Response.json({ missing: "private-secret" }), reason: "Malformed" },
        { response: () => new Response("private-secret", { status: 503 }), reason: "Provider" },
        { response: () => new Response("x".repeat(65537)), reason: "Limit" },
      ];

      for (const scenario of scenarios) {
        const error = yield* from("https://private.invalid/?key=private-secret", () =>
          Promise.resolve(scenario.response()),
        ).pipe(Effect.flip);

        expect(error.reason._tag).toBe(scenario.reason);
        expect(JSON.stringify(error)).not.toContain("private-secret");
        expect(JSON.stringify(error)).not.toContain("private.invalid");
      }

      const error = yield* from("http://private.invalid", () =>
        Promise.reject(new Error("private-secret")),
      ).pipe(Effect.flip);

      expect(error.reason._tag).toBe("Transport");
      expect(JSON.stringify(error)).not.toContain("private-secret");
    }),
);

const delayedDiscovery = Effect.fnUntraced(function* (remainingMillis: number) {
  const started = yield* Deferred.make<void>();
  let cancel = () => {};

  const pending = new Promise<Response>((_resolve, reject) => {
    cancel = () => reject(new Error("private discovery request cancelled"));
  });

  let aborted = false;
  let opened = 0;

  const fetch: typeof globalThis.fetch = (_input, options) => {
    options?.signal?.addEventListener("abort", () => {
      aborted = true;
      cancel();
    });
    Deferred.doneUnsafe(started, Effect.void);

    return pending;
  };

  const deadline = Number(yield* Clock.monotonicTimeNanos) / 1_000_000 + remainingMillis;

  const observation = yield* makeObservation({
    connection: () => Effect.succeed(Redacted.make("wss://connect.browserbase.com/?key=private")),
    resolve: () => Effect.succeed("http://127.0.0.1:9222"),
    constructor: () => {
      opened++;
      throw new Error("Unexpected socket construction");
    },
    deadline,
  }).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));

  const starting = yield* observation
    .source({ pageId: "page", targetId: "target" })
    .start({
      quality: 70,
      receive: () => {},
      invalidate: () => {},
      fail: () => {},
    })
    .pipe(Effect.forkScoped);

  yield* Deferred.await(started);

  return { observation, starting, aborted: () => aborted, opened: () => opened };
});

it.effect("closing during HTTP discovery aborts its request before a socket can open", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* delayedDiscovery(10000);

      yield* f.observation.close;
      expect((yield* Fiber.join(f.starting).pipe(Effect.flip)).reason._tag).toBe("Closed");
      expect(f.aborted()).toBe(true);
      expect(f.opened()).toBe(0);
    }),
  ),
);

it.effect("HTTP discovery consumes the remaining lifetime and times out without dialing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* delayedDiscovery(1000);

      yield* TestClock.adjust(1000);
      expect((yield* Fiber.join(f.starting).pipe(Effect.flip)).reason._tag).toBe("Timeout");
      expect(f.aborted()).toBe(true);
      expect(f.opened()).toBe(0);
    }),
  ),
);
