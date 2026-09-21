import assert from "node:assert/strict";

import { Effect, Redacted } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import { BrowserbaseClient } from "../../src/Client.ts";
import type { AllocationError, BrowserError, ClientError, ContextError } from "../../src/Errors.ts";
import type { DriverEvents } from "../../src/internal/browser/Driver.ts";
import { fixture } from "./ScriptedProvider.ts";

interface Case {
  readonly name: string;
  readonly run: Effect.Effect<void, AllocationError | BrowserError | ClientError | ContextError>;
}

/** Regressions found by inspecting the preserved checkpoint, not inherited historical results. */
export const recoveryCases: ReadonlyArray<Case> = [
  {
    // The old private seam let one options object reach both an account layer and a
    // browser layer, where excess keys were rejected only by the former. Account
    // authority and browser configuration are now separate types with no shared keys.
    name: "account options reject browser configuration instead of silently accepting it",
    run: Effect.gen(function* () {
      let requests = 0;

      const fetch: typeof globalThis.fetch = async () => {
        requests++;

        return Response.json({ ok: true });
      };

      const rejected = yield* Effect.gen(function* () {
        const client = yield* BrowserbaseClient;

        yield* client.json("GET", "/v1/sessions/session-1");
      }).pipe(
        Effect.provide(
          BrowserbaseClient.layer({
            projectId: "project-1",
            apiKey: Redacted.make("private-test-key"),
            // @ts-expect-error browser configuration is not account authority
            viewport: { width: 640, height: 480 },
          }),
        ),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
        Effect.result,
      );

      assert.equal(rejected._tag, "Failure");
      if (rejected._tag === "Failure") assert.equal(rejected.failure.reason, "configuration");
      assert.equal(requests, 0);

      yield* Effect.gen(function* () {
        const client = yield* BrowserbaseClient;

        yield* client.json("GET", "/v1/sessions/session-1");
      }).pipe(
        Effect.provide(
          BrowserbaseClient.layer({
            projectId: "project-1",
            apiKey: Redacted.make("private-test-key"),
          }),
        ),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      );
      assert.equal(requests, 1);
    }),
  },
  {
    name: "an operator-pause event during connection setup never exposes an open handle",
    run: Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture({
          onConnect: async (driver, events) => {
            events.pause();

            return driver;
          },
        });

        const acquisition = yield* f.acquisition;
        const result = yield* acquisition.connect.pipe(Effect.result);

        assert.equal(result._tag, "Failure");
        assert.equal(f.state.releases, 1);
        assert.equal(f.state.localCloses, 1);
      }),
    ),
  },
  {
    name: "a retired connection cannot disconnect its replacement",
    run: Effect.scoped(
      Effect.gen(function* () {
        const connections: DriverEvents[] = [];

        const f = yield* fixture({
          keepAlive: true,
          onObserve: async (events) => {
            connections.push(events);
          },
        });

        const session = yield* (yield* f.acquisition).connect;

        yield* session.observe();
        yield* session.detach;
        yield* session.reconnect(true);
        assert.equal(connections.length, 2);
        connections[0]!.disconnected();
        assert.equal(yield* session.bind().readText(), "initial");
        assert.equal(f.state.connects, 2);
        assert.equal((yield* session.close).remote, "confirmed");
      }),
    ),
  },
  {
    name: "a retired target callback cannot invalidate a fresh observation",
    run: Effect.scoped(
      Effect.gen(function* () {
        const connections: DriverEvents[] = [];

        const f = yield* fixture({
          keepAlive: true,
          onObserve: async (events) => {
            connections.push(events);
          },
        });

        const session = yield* (yield* f.acquisition).connect;

        yield* session.observe();
        yield* session.detach;
        const fresh = yield* session.reconnect(true);

        connections[0]!.invalidate("target-changed");
        assert.equal((yield* session.observe()).revision, fresh.revision);
        connections[1]!.invalidate("observation");
        assert.equal((yield* session.observe()).revision, fresh.revision + 1);
      }),
    ),
  },
  {
    name: "a retired connection cannot pause or fault current automation",
    run: Effect.scoped(
      Effect.gen(function* () {
        const connections: DriverEvents[] = [];

        const f = yield* fixture({
          keepAlive: true,
          onObserve: async (events) => {
            connections.push(events);
          },
        });

        const session = yield* (yield* f.acquisition).connect;

        yield* session.observe();
        yield* session.detach;
        yield* session.reconnect(true);
        connections[0]!.pause();
        connections[0]!.fault();
        assert.equal(yield* session.bind().readText(), "initial");
        connections[1]!.disconnected();
        const stopped = yield* session.bind().readText().pipe(Effect.result);

        assert.equal(stopped._tag, "Failure");
        if (stopped._tag === "Failure") assert.equal(stopped.failure.reason, "closed");
      }),
    ),
  },
];
