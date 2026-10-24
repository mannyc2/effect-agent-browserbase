// Runtime-supplied connectors still return a real Playwright CDP browser, owned by the scope.
import { assert, it } from "@effect/vitest";
import { Arbitrary, Deferred, Effect, Exit, Fiber, Redacted, Schema } from "effect";
import { type Browser, chromium } from "playwright-core";

import { behindProxy } from "../../../tools/testing/cdp-proxy.ts";
import { BrowserError } from "../src/BrowserError.ts";
import * as Cdp from "../src/providers/Cdp.ts";
import * as WorkerCdp from "../src/workerd/Cdp.ts";
import { nativeConnect } from "./nativeConnector.ts";

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

const connectorFailure = Effect.fnUntraced(function* (
  headers: Readonly<Record<string, string>> | undefined,
  cause: Error | string,
) {
  const error = yield* Cdp.open({
    endpoint: "wss://runtime.invalid/cdp",
    headers,
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- External connectors may reject strings; exercise that redaction boundary alongside Error values.
    connect: () => Promise.reject(cause),
  }).pipe(Effect.scoped, Effect.flip);

  const json = Schema.fromJsonString(Schema.toCodecJson(BrowserError));
  const serialized = yield* Schema.encodeEffect(json)(error);

  return {
    error,
    shown: [error.message, String(error), error.stack ?? "", JSON.stringify(error), serialized],
  };
});

it.effect("conceals whole failures that echo header credentials before URL transformations", () =>
  Effect.gen(function* () {
    const authorization = "Bearer authorization-private-0123456789";
    const custom = "runtime-header-private-0123456789";
    const upper = "UPPER-HEADER-PRIVATE-0123456789";
    const url = "wss://header-secret.example/private-route?access_token=opaque-secret";

    const cases: ReadonlyArray<{
      readonly headers: Readonly<Record<string, string>>;
      readonly detail: string;
      readonly secrets: ReadonlyArray<string>;
    }> = [
      {
        headers: { Authorization: authorization, "x-runtime-key": custom, "x-empty": "" },
        detail: `Native handshake refused: Authorization=${authorization}; x-runtime-key=${custom}`,
        secrets: [authorization, custom],
      },
      {
        headers: { "x-runtime-key": custom },
        detail: `Native handshake refused at wss://${custom}.runtime.invalid/cdp`,
        secrets: [custom],
      },
      {
        headers: { "x-runtime-key": upper },
        detail: `Native handshake refused at wss://${upper}.runtime.invalid/cdp`,
        secrets: [upper, upper.toLowerCase()],
      },
      {
        headers: { "x-first": "abc", "x-second": "bcd" },
        detail: "Native handshake refused overlapping credentials abcd",
        secrets: ["abc", "bcd"],
      },
      {
        headers: { "x-first": "nested-secret", "x-second": "nested-secret-suffix" },
        detail: "Native handshake refused nested credential nested-secret-suffix",
        secrets: ["nested-secret", "nested-secret-suffix"],
      },
      {
        headers: { "x-runtime-key": url },
        detail: `Native handshake refused URL-shaped header ${url}`,
        secrets: [url, "header-secret.example", "private-route", "opaque-secret"],
      },
    ];

    let concealed: string | undefined;

    for (const { headers, detail, secrets } of cases) {
      const { error, shown } = yield* connectorFailure(headers, new Error(detail));

      assert.deepStrictEqual(
        [error._tag, error.operation, error.reason._tag, error.dispatched],
        ["BrowserError", "connect", "Failed", false],
      );
      if (error.reason._tag !== "Failed") return yield* Effect.die(error);
      // Each credential-bearing diagnostic is discarded as a whole, without pinning its wording.
      concealed ??= error.reason.detail;
      assert.strictEqual(error.reason.detail, concealed);
      for (const value of shown) for (const secret of secrets) assert.notInclude(value, secret);
    }
  }),
);

it.effect.prop(
  "conceals arbitrary echoed header values in errors and serialized failures",
  {
    value: Arbitrary.schema(Schema.NonEmptyString),
    kind: Arbitrary.schema(Schema.Literals(["error", "string"])),
  },
  ({ value, kind }) =>
    Effect.gen(function* () {
      const authorization = `authorization-header-private-${value}`;
      const custom = `custom-header-private-${value}`;
      const detail = `Native refused ${authorization} and ${custom}`;

      const { error, shown } = yield* connectorFailure(
        { Authorization: authorization, "x-runtime-key": custom, "x-empty": "" },
        kind === "error" ? new Error(detail) : detail,
      );

      assert.deepStrictEqual([error._tag, error.dispatched], ["BrowserError", false]);
      for (const text of shown) {
        assert.notInclude(text, "authorization-header-private-");
        assert.notInclude(text, "custom-header-private-");
      }
    }),
);

it.effect("preserves safe diagnostics and typed reasons when headers need no Failed detail", () =>
  Effect.gen(function* () {
    const diagnostic = "Native handshake refused without disclosing credentials";

    const safeHeaders: ReadonlyArray<Readonly<Record<string, string>> | undefined> = [
      undefined,
      { "x-empty": "" },
      { Authorization: "unreported-private" },
    ];

    for (const headers of safeHeaders) {
      const { error, shown } = yield* connectorFailure(headers, new Error(diagnostic));

      assert.strictEqual(error.reason._tag, "Failed");
      assert.include(error.message, diagnostic);
      assert.include(shown[4] ?? "", diagnostic);
    }
    const credential = "typed-reason-private-0123456789";
    const timedOut = new Error(`Native exceeded its deadline with ${credential}`);

    timedOut.name = "TimeoutError";
    for (const [cause, expected] of [
      [timedOut, "Timeout"],
      [new Error(`Browser has disconnected with ${credential}`), "Closed"],
    ] as const) {
      const { error, shown } = yield* connectorFailure({ Authorization: credential }, cause);

      assert.deepStrictEqual([error.reason._tag, error.dispatched], [expected, false]);
      for (const value of shown) assert.notInclude(value, credential);
    }
  }),
);

it.effect("redacts originally supplied headers when their caller mutates the record", () =>
  Effect.gen(function* () {
    const credential = "original-header-private-0123456789";
    const headers = { Authorization: credential };

    const error = yield* Cdp.open({
      endpoint: "wss://runtime.invalid/cdp",
      headers,
      connect: async () => {
        headers.Authorization = "changed-after-handoff";
        throw new Error(`Native refused originally supplied ${credential}`);
      },
    }).pipe(Effect.scoped, Effect.flip);

    const serialized = yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.toCodecJson(BrowserError)),
    )(error);

    assert.strictEqual(error.reason._tag, "Failed");
    assert.notInclude(error.message, credential);
    assert.notInclude(serialized, credential);
  }),
);
