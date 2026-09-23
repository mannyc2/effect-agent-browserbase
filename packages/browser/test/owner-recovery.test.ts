import assert from "node:assert/strict";

import { it } from "@effect/vitest";
import { Effect } from "effect";
import type { BrowserError, InitializationError } from "effect-browser/errors";

import type { DriverEvents } from "../src/internal/browser/Driver.ts";
import { fixture } from "./fixtures/ScriptedOwner.ts";

interface Case {
  readonly name: string;
  readonly run: Effect.Effect<void, BrowserError | InitializationError>;
}

/** Regressions found by inspecting the preserved checkpoint, not inherited historical results. */
const recoveryCases: ReadonlyArray<Case> = [
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
        assert.equal(yield* session.operations.readText(), "initial");
        assert.equal(f.state.connects, 2);
        const closed = yield* session.close;

        assert.equal(closed.connection, "closed");
        assert.deepEqual(closed.issues, []);
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
        connections[0]!.fault({ source: "native", reason: "connection", disposition: "unknown" });
        assert.equal(yield* session.operations.readText(), "initial");
        connections[1]!.disconnected();
        const stopped = yield* session.operations.readText().pipe(Effect.result);

        assert.equal(stopped._tag, "Failure");
        if (stopped._tag === "Failure") assert.equal(stopped.failure.reason._tag, "Closed");
      }),
    ),
  },
];

for (const test of recoveryCases) it.effect(test.name, () => test.run);
