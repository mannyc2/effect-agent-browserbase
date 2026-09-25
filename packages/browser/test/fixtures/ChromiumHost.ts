import assert from "node:assert/strict";

import { NodeCrypto } from "@effect/platform-node";
import { Effect, Layer, Schema } from "effect";
import { BrowserPolicy } from "effect-browser/browser-data";
import { Chromium } from "effect-browser/chromium";

const phase = Schema.decodeUnknownSync(Schema.Literals(["acquired", "connected"]))(process.argv[2]);

// Deliberately no runMain/signal handler: the crash cases must bypass Effect finalizers.
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const acquired = yield* Chromium.acquire(
        BrowserPolicy.unrestricted({ maxElapsedMillis: 60000 }),
      );

      if (phase === "connected") {
        const session = yield* acquired.connect;

        assert.equal((yield* session.readText({ selector: "body" })).text, "");
      }

      const command = yield* Effect.promise(
        () =>
          new Promise<string>((resolve) => {
            process.stdin.once("data", (chunk: Buffer) => resolve(chunk.toString().trim()));
            process.stdout.write("ready\n");
          }),
      );

      if (command === "exit") process.exit(23);
      assert.equal(command, "close");
    }),
  ).pipe(
    Effect.provide(
      Chromium.layer({
        launch: {
          ...(process.env.BROWSERBASE_CHROMIUM === undefined
            ? {}
            : { executablePath: process.env.BROWSERBASE_CHROMIUM }),
          chromiumSandbox: false,
          startupTimeoutMillis: 25000,
        },
      }).pipe(Layer.provide(NodeCrypto.layer)),
    ),
  ),
);
process.stdin.destroy();
