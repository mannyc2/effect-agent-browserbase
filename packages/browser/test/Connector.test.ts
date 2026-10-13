// Runtime-supplied connectors still return a real Playwright CDP browser, owned by the scope.
import { assert, it } from "@effect/vitest";
import { Arbitrary, Deferred, Effect, Exit, Fiber, Redacted, Schema } from "effect";
import { type Browser, chromium } from "playwright-core";

import * as Cdp from "../src/Cdp.ts";
import * as WorkerCdp from "../src/workerd/Cdp.ts";
import { nativeConnect } from "./nativeConnector.ts";
import { behindProxy } from "./protocol.ts";

it.effect.prop(
  "refuses invalid connection bounds before invoking the connector",
  {
    timeout: Arbitrary.schema(Schema.Finite).pipe(Arbitrary.map((value) => -Math.abs(value))),
  },
  ({ timeout }) =>
    Effect.gen(function* () {
      let calls = 0;

      for (const invalid of [timeout, Number.NaN, Infinity, -Infinity]) {
        const error = yield* Cdp.open({
          endpoint: "wss://runtime.invalid",
          connectTimeoutMillis: invalid,
          connect: async () => {
            calls++;
            throw new Error("Connector should not be invoked");
          },
        }).pipe(Effect.scoped, Effect.flip);

        assert.strictEqual(error.reason._tag, "InvalidRequest");
      }
      assert.strictEqual(calls, 0);
    }),
);

it.effect("requires a connector in the Workers entry", () =>
  Effect.gen(function* () {
    const error = yield* WorkerCdp.open({ endpoint: "wss://runtime.invalid" }).pipe(
      Effect.scoped,
      Effect.flip,
    );

    assert.deepStrictEqual(
      [error.operation, error.reason._tag, error.dispatched],
      ["connect", "InvalidRequest", false],
    );
  }),
);

it.live("uses the supplied connector and disconnects without ending its remote browser", () =>
  Effect.gen(function* () {
    const proxy = yield* behindProxy();
    const connections: Array<Browser> = [];
    const calls: Array<readonly [string, number, unknown, boolean]> = [];

    yield* Effect.gen(function* () {
      const browser = yield* Cdp.open({
        endpoint: Redacted.make("wss://runtime.invalid/?signingKey=private"),
        headers: { "x-runtime": "one" },
        connectTimeoutMillis: 5000,
        connect: async (endpoint, options) => {
          calls.push([endpoint, options.timeout, options.headers, options.signal.aborted]);
          const connected = await chromium.connectOverCDP(proxy.endpoint);

          connections.push(connected);

          return connected;
        },
      });

      const page = yield* browser.firstPage;

      yield* page.goto("data:text/html,<button>Runtime</button>");
      assert.include((yield* page.snapshot()).text, 'button "Runtime"');
      assert.isAbove((yield* page.frame()).data.length, 100);
    }).pipe(Effect.scoped);

    assert.deepStrictEqual(calls, [
      ["wss://runtime.invalid/?signingKey=private", 5000, { "x-runtime": "one" }, false],
    ]);
    assert.strictEqual(connections.length, 1);
    assert.isFalse(connections[0]?.isConnected());
    // The native close only disconnects: another connection finds the existing page.
    const later = yield* Cdp.open({ endpoint: proxy.endpoint });

    assert.include((yield* (yield* later.firstPage).snapshot()).text, 'button "Runtime"');
  }).pipe(Effect.scoped),
);

it.live("disconnects the supplied browser when opening fails after connection", () =>
  Effect.gen(function* () {
    const proxy = yield* behindProxy();
    const connections: Array<Browser> = [];

    const error = yield* Cdp.open({
      endpoint: proxy.endpoint,
      maxPages: 0,
      connect: async (endpoint) => {
        const connected = await chromium.connectOverCDP(endpoint);

        connections.push(connected);

        return connected;
      },
    }).pipe(Effect.scoped, Effect.flip);

    assert.strictEqual(error.reason._tag, "InvalidRequest");
    assert.strictEqual(connections.length, 1);
    assert.isFalse(connections[0]?.isConnected());
  }).pipe(Effect.scoped),
);

it.live("bounds an unresponsive connector and disconnects its late browser", () =>
  Effect.gen(function* () {
    const proxy = yield* behindProxy();
    const connected = yield* Effect.promise(() => chromium.connectOverCDP(proxy.endpoint));

    yield* Effect.addFinalizer(() => Effect.promise(() => connected.close()));
    let complete: ((browser: Browser) => void) | undefined;
    let signal: AbortSignal | undefined;
    const started = performance.now();

    const error = yield* Cdp.open({
      endpoint: proxy.endpoint,
      connectTimeoutMillis: 50,
      connect: (_endpoint, options) => {
        signal = options.signal;

        return new Promise<Browser>((resolve) => {
          complete = resolve;
        });
      },
    }).pipe(Effect.scoped, Effect.flip);

    assert.deepStrictEqual([error.reason._tag, error.dispatched], ["Timeout", false]);
    assert.isBelow(performance.now() - started, 2000);
    assert.isTrue(signal?.aborted);

    const disconnected = new Promise<void>((resolve) => {
      connected.once("disconnected", () => resolve());
    });

    complete?.(connected);
    yield* Effect.promise(() => disconnected);
    assert.isFalse(connected.isConnected());
  }).pipe(Effect.scoped),
);

it.live("disconnects a connection acquired while its caller was interrupted", () =>
  Effect.gen(function* () {
    const proxy = yield* behindProxy();
    const connected = yield* Effect.promise(() => chromium.connectOverCDP(proxy.endpoint));
    const entered = yield* Deferred.make<void>();

    yield* Effect.addFinalizer(() => Effect.promise(() => connected.close()));
    let complete: ((browser: Browser) => void) | undefined;

    const opening = yield* Effect.forkChild(
      Cdp.open({
        endpoint: proxy.endpoint,
        connect: () =>
          new Promise<Browser>((resolve) => {
            complete = resolve;
            Deferred.doneUnsafe(entered, Exit.void);
          }),
      }).pipe(Effect.scoped),
    );

    yield* Deferred.await(entered);
    const interrupting = yield* Effect.forkChild(Fiber.interrupt(opening));

    yield* Effect.yieldNow;

    const disconnected = new Promise<void>((resolve) => {
      connected.once("disconnected", () => resolve());
    });

    complete?.(connected);
    yield* Fiber.join(interrupting);
    const exit = yield* Fiber.await(opening);

    yield* Effect.promise(() => disconnected);

    assert.isTrue(Exit.isFailure(exit));
    assert.isFalse(connected.isConnected());
  }).pipe(Effect.scoped),
);

it.live("connects through the global WebSocket using Playwright's public CDP transport", () =>
  Effect.gen(function* () {
    const proxy = yield* behindProxy();
    const browser = yield* Cdp.open({ endpoint: proxy.endpoint, connect: nativeConnect });
    const page = yield* browser.firstPage;

    yield* page.goto("data:text/html,<button>Native</button>");
    assert.include((yield* page.snapshot()).text, 'button "Native"');
    assert.isAbove((yield* page.frame()).data.length, 100);
  }).pipe(Effect.scoped),
);

it.live("keeps a custom connector's failures typed and its credential private", () =>
  Effect.gen(function* () {
    const secret = "custom-signing-key-0123456789";
    const endpoint = `wss://runtime.invalid/${secret}?signingKey=${secret}`;

    const error = yield* Cdp.open({
      endpoint: Redacted.make(endpoint),
      connect: async () => {
        throw new Error(`Runtime could not connect to ${endpoint}`);
      },
    }).pipe(Effect.scoped, Effect.flip);

    assert.deepStrictEqual(
      [error.operation, error.reason._tag, error.dispatched],
      ["connect", "Failed", false],
    );
    assert.notInclude(JSON.stringify(error), secret);
    assert.include(error.message, "wss://runtime.invalid");
  }),
);
