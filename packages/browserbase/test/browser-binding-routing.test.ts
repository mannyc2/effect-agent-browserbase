import assert from "node:assert/strict";

import { NodeCrypto } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, Layer, Redacted, Schema } from "effect";
import { BrowserPolicy } from "effect-browser/browser-data";
import * as BrowserRuntime from "effect-browser/browser-runtime";
import { BrowserError, Reasons } from "effect-browser/errors";
import { FetchHttpClient } from "effect/unstable/http";

import { BrowserbaseBrowser } from "../src/Browser.ts";
import * as BrowserBinding from "../src/BrowserBinding.ts";
import { BrowserbaseClient } from "../src/Client.ts";
import { recipe } from "../src/Launch.ts";
import { BrowserbaseSessions } from "../src/Sessions.ts";

/**
 * Connects the public runtime over `binding` to a lifetime whose provider issued `connection`,
 * so only the binding's own checks decide what becomes of the address.
 */
const connect = (binding: BrowserBinding.BrowserBinding, connection: unknown) =>
  Effect.scoped(
    Effect.gen(function* () {
      const runtime = yield* BrowserRuntime.make({ implementation: "binding-under-test", binding });

      const acquired = yield* runtime.acquire(BrowserPolicy.unrestricted(), (cleanup) =>
        Effect.gen(function* () {
          const release = yield* Effect.cached(
            cleanup.fence.pipe(
              Effect.andThen(cleanup.capture),
              Effect.andThen(cleanup.initialization),
              Effect.andThen(cleanup.disconnect),
              Effect.orDie,
              Effect.asVoid,
            ),
          );

          yield* Effect.addFinalizer(() => release);

          return {
            reference: "binding-under-test",
            // A source is typed to issue strings; the binding still refuses anything else.
            connection: () => Effect.succeed(Redacted.make(connection as string)),
            release,
            cleanupResult: Effect.succeedNone,
            closeChecked: release,
          };
        }),
      );

      return yield* acquired.connect;
    }),
  ).pipe(Effect.flip);

it.effect("the default binding refuses any address the provider could not have issued", () =>
  Effect.gen(function* () {
    const binding = BrowserBinding.playwright();

    for (const [connection, reason] of [
      [42, "Malformed"],
      ["not a url", "Malformed"],
      ["ws://connect.browserbase.com/?session=1", "UnsafeUrl"],
      ["wss://connect.browserbase.com.example.com/", "UnsafeUrl"],
      ["wss://user:secret@connect.browserbase.com/", "UnsafeUrl"],
      ["wss://connect.browserbase.com:4443/", "UnsafeUrl"],
    ] as const) {
      const error = yield* connect(binding, connection);

      assert.ok(Schema.is(BrowserError)(error));
      assert.equal(error.reason._tag, reason, String(connection));
    }
  }),
);

it.effect("host routing runs only after the provider address passes the default checks", () =>
  Effect.gen(function* () {
    const resolved: Array<string> = [];

    const binding = BrowserBinding.playwright({
      resolveEndpoint: ({ url }) =>
        Effect.sync(() => resolved.push(Redacted.value(url))).pipe(
          Effect.andThen(
            Effect.fail(
              BrowserError.make({
                operation: "connect",
                reason: Reasons.Provider.make({}),
                outcome: "undispatched",
              }),
            ),
          ),
        ),
    });

    const refused = yield* connect(binding, "wss://evil.example.com/?session=1");

    assert.ok(Schema.is(BrowserError)(refused));
    assert.equal(refused.reason._tag, "UnsafeUrl");
    assert.deepEqual(resolved, []);

    // An accepted address reaches the resolver, and the resolver's own refusal is kept.
    const routed = yield* connect(binding, "wss://connect.browserbase.com/?session=1");

    assert.ok(Schema.is(BrowserError)(routed));
    assert.equal(routed.reason._tag, "Provider");
    assert.deepEqual(resolved, ["wss://connect.browserbase.com/?session=1"]);
  }),
);

it.effect("a binding the package did not issue is refused before any provider request", () =>
  Effect.gen(function* () {
    let requests = 0;
    const forged = { _tag: "BrowserBinding" } as const;

    // Issuance, not shape, gives a binding an engine: the runtime has none for this one.
    const unissued = yield* BrowserRuntime.make({
      implementation: "binding-under-test",
      binding: forged,
    }).pipe(Effect.flip);

    assert.equal(unissued.reason._tag, "UnregisteredSession");

    const error = yield* Effect.scoped(
      Effect.gen(function* () {
        return yield* (yield* BrowserbaseBrowser).open(
          BrowserPolicy.make({
            network: { _tag: "Unrestricted" },
            maxActions: 4,
            maxElapsedMillis: 10_000,
            maxReturnedBytes: 1024,
          }),
        );
      }),
    ).pipe(
      Effect.provide(
        BrowserbaseBrowser.layer({ launch: recipe() }).pipe(
          Layer.provide(NodeCrypto.layer),
          Layer.provide(
            BrowserbaseSessions.layer.pipe(
              Layer.provideMerge(
                BrowserbaseClient.layer({
                  projectId: "project-1",
                  apiKey: Redacted.make("test-account-key"),
                }),
              ),
            ),
          ),
          Layer.provide(BrowserBinding.layer(forged)),
        ),
      ),
      Effect.provideService(FetchHttpClient.Fetch, async () => {
        requests++;

        return Response.json({}, { status: 500 });
      }),
      Effect.flip,
    );

    assert.ok(Schema.is(BrowserError)(error));
    assert.equal(error.reason._tag, "UnregisteredSession");
    assert.equal(error.outcome, "undispatched");
    assert.equal(requests, 0);
  }),
);

it.effect("the default engine needs no provision and every issued binding is frozen", () =>
  Effect.gen(function* () {
    const binding = yield* BrowserBinding.BrowserbaseBrowserBinding;

    assert.equal(binding._tag, "BrowserBinding");
    // An issued binding has an engine, so the runtime accepts it.
    yield* BrowserRuntime.make({ implementation: "binding-under-test", binding });
    assert.ok(Object.isFrozen(binding));
    assert.ok(Object.isFrozen(BrowserBinding.playwright()));
  }),
);
