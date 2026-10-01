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
        const initial = session.initialPage();

        yield* session.initialPage().controls.observe();
        yield* session.detach;
        const inventory = yield* session.reconnect(true);
        const [info] = inventory.pages;

        assert.ok(info !== undefined);
        const fresh = yield* session.page(info);

        assert.equal((yield* fresh.controls.observe()).text, "initial");
        assert.equal(connections.length, 2);
        // The original issuance is a lifetime fact. Reading it after reconnection must not
        // replace the fresh inventory with authority made from the old connection's target.
        assert.equal(session.initialPage().record, initial.record);
        assert.equal(
          session.initialPage().record.identity.generation,
          initial.record.identity.generation,
        );
        assert.equal((yield* initial.status).phase, "stale");
        const stale = yield* initial.controls.observe().pipe(Effect.result);

        assert.equal(stale._tag, "Failure");
        if (stale._tag === "Failure") {
          assert.equal(stale.failure.reason._tag, "Stale");
          assert.equal(stale.failure.outcome, "undispatched");
        }
        assert.notEqual(fresh.record, initial.record);
        assert.ok(fresh.record.identity.generation > initial.record.identity.generation);
        assert.equal((yield* fresh.status).phase, "open");
        connections[0]!.disconnected();
        assert.equal(yield* fresh.controls.operations.readText(), "initial");
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

        yield* session.initialPage().controls.observe();
        yield* session.detach;
        const inventory = yield* session.reconnect(true);
        const info = inventory.pages[0];

        assert.ok(info !== undefined);
        const issued = yield* session.page(info);
        const fresh = yield* issued.controls.observe();

        connections[0]!.invalidate("target-changed");
        assert.equal((yield* issued.controls.observe()).revision, fresh.revision);
        connections[1]!.invalidate("observation");
        assert.equal((yield* issued.controls.observe()).revision, fresh.revision + 1);
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

        yield* session.initialPage().controls.observe();
        yield* session.detach;
        const inventory = yield* session.reconnect(true);
        const info = inventory.pages[0];

        assert.ok(info !== undefined);
        const issued = yield* session.page(info);

        yield* issued.controls.observe();
        connections[0]!.pause();
        connections[0]!.fault({ source: "native", reason: "connection", disposition: "unknown" });
        assert.equal(yield* issued.controls.operations.readText(), "initial");
        connections[1]!.disconnected();
        const stopped = yield* issued.controls.operations.readText().pipe(Effect.result);

        assert.equal(stopped._tag, "Failure");
        if (stopped._tag === "Failure") assert.equal(stopped.failure.reason._tag, "Closed");
      }),
    ),
  },
];

for (const test of recoveryCases) it.effect(test.name, () => test.run);
