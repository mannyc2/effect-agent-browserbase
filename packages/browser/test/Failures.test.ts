// Failures that come from Playwright itself, as callers and models receive them.
import { createServer as createHttpServer } from "node:http";
import { createServer, type Server } from "node:net";

import { assert, it } from "@effect/vitest";
import { Arbitrary, Effect, Redacted } from "effect";

import { BrowserError, consequence } from "../src/BrowserError.ts";
import { DisconnectCause } from "../src/BrowserEvent.ts";
import * as Cdp from "../src/Cdp.ts";
import * as Chromium from "../src/Chromium.ts";

const timeoutOf = (error: BrowserError) =>
  error.reason._tag === "Timeout" ? error.reason.millis : error.reason._tag;

const portOf = (server: Server) => {
  const address = server.address();

  return typeof address === "object" && address !== null ? address.port : 0;
};

const listening = <S extends Server>(server: S) =>
  Effect.acquireRelease(
    Effect.callback<S>((resume) => {
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (open) => Effect.sync(() => open.close()),
  ).pipe(Effect.map(portOf));

/** A loopback port that accepts connections and never answers them. */
const silentPort = listening(createServer(() => undefined));

/** A DevTools host that refuses every request and WebSocket upgrade, as with a bad credential. */
const refusingPort = Effect.suspend(() => {
  const server = createHttpServer((_request, response) => {
    response.writeHead(401);
    response.end();
  });

  server.on("upgrade", (_request, socket) => {
    socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
  });

  return listening(server);
});

const secret = "sk-0123456789abcdef";

it.live("a connect timeout reports the bound the caller gave", () =>
  Effect.gen(function* () {
    const port = yield* silentPort;

    const error = yield* Effect.flip(
      Cdp.open({ endpoint: `http://127.0.0.1:${port}`, connectTimeoutMillis: 700 }),
    );

    assert.deepStrictEqual(
      [error.operation, timeoutOf(error), error.dispatched],
      ["connect", 700, false],
    );
    assert.strictEqual(error.message, "connect failed: timed out after 700 ms");
  }).pipe(Effect.scoped),
);

it.live("a screenshot timeout reports the action timeout", () =>
  Effect.gen(function* () {
    const browser = yield* Chromium.open({ actionTimeout: "1 second" });
    const page = yield* browser.newPage("data:text/html,<h1>Busy</h1>");

    // A renderer stuck in script cannot produce the frame a screenshot waits for.
    yield* Effect.promise(() =>
      page.playwright.evaluate(() => {
        setTimeout(() => {
          const end = Date.now() + 5000;

          while (Date.now() < end);
        }, 0);
      }),
    );

    const error = yield* Effect.flip(page.screenshot({ maxAge: 0 }));

    assert.deepStrictEqual([error.operation, timeoutOf(error)], ["screenshot", 1000]);
  }).pipe(Effect.scoped),
);

it.live("a failed connect never repeats the endpoint's credential", () =>
  Effect.gen(function* () {
    const port = yield* refusingPort;
    const host = `127.0.0.1:${port}`;

    // Playwright echoes query, userinfo and path for some of these forms, and the raw text for a
    // malformed endpoint. Each failure must still say where it failed.
    for (const [endpoint, where] of [
      [`http://${host}/?signingKey=${secret}`, `http://${host}`],
      [`http://user:${secret}@${host}/`, `http://${host}`],
      [`ws://${host}/?signingKey=${secret}`, `ws://${host}`],
      [`ws://user:${secret}@${host}/`, `ws://${host}`],
      [`ws://${host}/devtools/browser/${secret}`, `ws://${host}`],
      [`wss//${host}/?signingKey=${secret}`, "Invalid URL"],
    ] as const) {
      const error = yield* Effect.flip(
        Cdp.open({ endpoint: Redacted.make(endpoint), connectTimeoutMillis: 5000 }),
      );

      for (const shown of [
        error.message,
        JSON.stringify(error),
        String(error),
        error.stack ?? "",
        error.reason._tag === "Failed" ? error.reason.detail : "",
      ])
        assert.notInclude(shown, secret, endpoint);
      assert.deepStrictEqual([error.operation, error.reason._tag], ["connect", "Failed"]);
      assert.include(error.message, where);
    }
  }).pipe(Effect.scoped),
);

const pointless = [
  "StaleRef",
  "NotFound",
  "NotActionable",
  "InvalidRequest",
  "Limit",
  "PolicyDenied",
  "PolicyTimeout",
];

// What a failure leaves follows from its reason, and whether it was dispatched, alone: whatever
// else differs, such as the operation or the reason's details, two failures alike there have the
// same consequence.
it.prop(
  "a failure's consequence follows from its reason and whether it was dispatched alone",
  { errors: Arbitrary.array(Arbitrary.schema(BrowserError), { minLength: 2, maxLength: 40 }) },
  ({ errors }) => {
    const seen = new Map<string, ReturnType<typeof consequence>>();

    for (const error of errors) {
      const { reason, dispatched } = error;
      const { lost, repeat } = consequence(error);
      const closedBy = reason._tag === "Closed" ? reason.cause : undefined;
      const key = JSON.stringify([reason._tag, closedBy, dispatched]);

      assert.deepStrictEqual(seen.get(key) ?? { lost, repeat }, { lost, repeat }, key);
      seen.set(key, { lost, repeat });

      // Only a closed page loses anything, and only its browser's loss loses the session.
      assert.strictEqual(lost !== "nothing", reason._tag === "Closed", key);
      assert.strictEqual(
        lost === "session",
        closedBy !== undefined && DisconnectCause.literals.some((cause) => cause === closedBy),
        key,
      );
      // A request that cannot succeed as it is, or a cursor that expired, says so either way.
      assert.strictEqual(repeat === "resume", reason._tag === "EventHistoryExpired", key);
      assert.strictEqual(repeat === "pointless", pointless.includes(reason._tag), key);
      // Otherwise repeating is safe unless the call reached the browser, then it waits for a look.
      if (repeat === "safe" || repeat === "check")
        assert.strictEqual(repeat, dispatched ? "check" : "safe", key);
    }
  },
);
