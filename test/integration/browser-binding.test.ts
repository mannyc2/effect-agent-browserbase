import assert from "node:assert/strict";

import { it } from "@effect/vitest";
import { Effect, Layer, Redacted, Schema } from "effect";
import { BrowserError } from "effect-browser/errors";
import { FetchHttpClient } from "effect/unstable/http";

import { BrowserPolicy, Viewport } from "../../packages/browser/src/BrowserData.ts";
import {
  bindingImplementation,
  type ConnectRequest,
} from "../../packages/browser/src/internal/browser/Binding.ts";
import { BrowserbaseBrowser } from "../../packages/browserbase/src/Browser.ts";
import * as BrowserBinding from "../../packages/browserbase/src/BrowserBinding.ts";
import { BrowserbaseClient } from "../../packages/browserbase/src/Client.ts";
import { recipe } from "../../packages/browserbase/src/Launch.ts";
import { BrowserbaseSessions } from "../../packages/browserbase/src/Sessions.ts";

const request = (connection: unknown): ConnectRequest => ({
  connection,
  options: {
    viewport: Viewport.make({ width: 640, height: 480 }),
    popupPolicy: "retain",
    dialogPolicy: "dismiss",
    maxPages: 4,
  },
  events: { invalidate: () => {}, disconnected: () => {}, pause: () => {}, fault: () => {} },
  onAbandoned: () => {},
  onSettled: () => {},
});

const connect = (binding: BrowserBinding.BrowserBinding, connection: unknown) => {
  const engine = bindingImplementation(binding);

  assert.ok(engine !== undefined, "a package-issued binding has an engine");

  return engine.connect(request(connection)).pipe(Effect.flip);
};

it.effect("the default binding refuses any address the provider could not have issued", () =>
  Effect.gen(function* () {
    const binding = BrowserBinding.playwright();

    for (const [connection, reason] of [
      [42, "malformed"],
      ["not a url", "malformed"],
      ["ws://connect.browserbase.com/?session=1", "unsafe-url"],
      ["wss://connect.browserbase.com.example.com/", "unsafe-url"],
      ["wss://user:secret@connect.browserbase.com/", "unsafe-url"],
      ["wss://connect.browserbase.com:4443/", "unsafe-url"],
    ] as const) {
      const error = yield* connect(binding, connection);

      assert.ok(Schema.is(BrowserError)(error));
      assert.equal(error.reason, reason, String(connection));
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
            Effect.fail(BrowserError.make({ operation: "connect", reason: "provider" })),
          ),
        ),
    });

    const refused = yield* connect(binding, "wss://evil.example.com/?session=1");

    assert.ok(Schema.is(BrowserError)(refused));
    assert.equal(refused.reason, "unsafe-url");
    assert.deepEqual(resolved, []);

    // An accepted address reaches the resolver, and the resolver's own refusal is kept.
    const routed = yield* connect(binding, "wss://connect.browserbase.com/?session=1");

    assert.ok(Schema.is(BrowserError)(routed));
    assert.equal(routed.reason, "provider");
    assert.deepEqual(resolved, ["wss://connect.browserbase.com/?session=1"]);
  }),
);

it.effect("a binding the package did not issue is refused before any provider request", () =>
  Effect.gen(function* () {
    let requests = 0;
    const forged = { _tag: "BrowserBinding" } as const;

    assert.equal(bindingImplementation(forged), undefined);

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
    assert.equal(error.reason, "unregistered-session");
    assert.equal(error.outcome, "undispatched");
    assert.equal(requests, 0);
  }),
);

it.effect("the default engine needs no provision and every issued binding is frozen", () =>
  Effect.gen(function* () {
    const binding = yield* BrowserBinding.BrowserbaseBrowserBinding;

    assert.equal(binding._tag, "BrowserBinding");
    assert.ok(bindingImplementation(binding) !== undefined);
    assert.ok(Object.isFrozen(binding));
    assert.ok(Object.isFrozen(BrowserBinding.playwright()));
  }),
);
