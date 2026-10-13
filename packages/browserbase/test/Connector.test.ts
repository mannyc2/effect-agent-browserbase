// The provider keeps owning its sessions when the consumer supplies the native connection.
import { createServer } from "node:net";

import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Layer } from "effect";
import { Browser } from "effect-browser/Browser";
import type { Connector } from "effect-browser/Cdp";
import { type Browser as PlaywrightBrowser, chromium } from "playwright-core";

import * as Browserbase from "../src/Browserbase.ts";
import * as ContextLease from "../src/ContextLease.ts";
import * as TestBrowserbase from "../src/testing/TestBrowserbase.ts";

const endpoint = Effect.gen(function* () {
  const port = yield* Effect.callback<number>((resume) => {
    const server = createServer();

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      server.close(() =>
        resume(Effect.succeed(typeof address === "object" && address !== null ? address.port : 0)),
      );
    });
  });

  yield* Effect.acquireRelease(
    Effect.promise(() => chromium.launch({ args: [`--remote-debugging-port=${port}`] })),
    (browser) => Effect.promise(() => browser.close()),
  );

  return `http://127.0.0.1:${port}`;
});

const fakeLayer = Layer.merge(
  TestBrowserbase.layer({ connectUrl: "wss://provider.invalid/?signingKey=private" }),
  ContextLease.layer,
);

it.live("passes the connector through open, layer, attach and supervised generations", () =>
  Effect.gen(function* () {
    const local = yield* endpoint;
    const calls: Array<readonly [string, number]> = [];

    const connect: Connector = (url, options) => {
      calls.push([url, options.timeout]);

      return chromium.connectOverCDP(local);
    };

    const options = { connect, connectTimeoutMillis: 5000, captureConnection: false };

    const read = (browser: Browser["Service"]) =>
      Effect.gen(function* () {
        const page = yield* browser.firstPage;

        yield* page.goto("data:text/html,<button>Custom</button>");
        assert.include((yield* page.snapshot()).text, 'button "Custom"');
      });

    yield* Effect.gen(function* () {
      const { browser, session } = yield* Browserbase.open(options);

      yield* read(browser);
      yield* Effect.gen(function* () {
        const attached = yield* Browserbase.attach(session.id, options);

        yield* read(attached.browser);
      }).pipe(Effect.scoped);
    }).pipe(Effect.scoped);

    yield* Effect.flatMap(Browser, read).pipe(Effect.provide(Browserbase.layer(options)));
    yield* Effect.gen(function* () {
      const supervised = yield* Browserbase.supervise(options);

      yield* supervised.use(({ browser }) => read(browser));
    }).pipe(Effect.scoped);

    assert.deepStrictEqual(
      calls,
      Array.from({ length: 4 }, () => ["wss://provider.invalid/?signingKey=private", 5000]),
    );
    const fake = yield* TestBrowserbase.TestBrowserbase;

    assert.deepStrictEqual(
      (yield* fake.sessions).map(({ status, releases }) => [status, releases]),
      Array.from({ length: 3 }, () => ["COMPLETED", 1]),
    );
  }).pipe(Effect.provide(fakeLayer), Effect.scoped),
);

it.effect("releases a failed custom connection and preserves its sanitized failure", () =>
  Effect.gen(function* () {
    const error = yield* Browserbase.open({
      connect: async (url) => {
        throw new Error(`Native transport refused ${url}`);
      },
    }).pipe(Effect.flip);

    const fake = yield* TestBrowserbase.TestBrowserbase;

    if (error._tag !== "BrowserError") return yield* Effect.die(error);
    assert.deepStrictEqual(
      [error._tag, error.operation, error.reason._tag],
      ["BrowserError", "connect", "Failed"],
    );
    assert.notInclude(JSON.stringify(error), "private");
    assert.deepStrictEqual(
      (yield* fake.sessions).map(({ status, releases }) => [status, releases]),
      [["COMPLETED", 1]],
    );
  }).pipe(Effect.provide(fakeLayer), Effect.scoped),
);

it.effect("releases its session when opening is interrupted inside the custom connector", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    let signal: AbortSignal | undefined;

    const opening = yield* Effect.forkChild(
      Browserbase.open({
        connect: (_url, options) =>
          new Promise<PlaywrightBrowser>(() => {
            signal = options.signal;
            Deferred.doneUnsafe(entered, Exit.void);
          }),
      }).pipe(Effect.scoped),
    );

    yield* Deferred.await(entered);
    yield* Fiber.interrupt(opening);
    assert.isTrue(signal?.aborted);
    const fake = yield* TestBrowserbase.TestBrowserbase;

    assert.deepStrictEqual(
      (yield* fake.sessions).map(({ status, releases }) => [status, releases]),
      [["COMPLETED", 1]],
    );
  }).pipe(Effect.provide(fakeLayer), Effect.scoped),
);
