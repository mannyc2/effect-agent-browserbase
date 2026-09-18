import assert from "node:assert/strict";
import { Effect, Redacted } from "effect";
import { httpOptions, makeHttp } from "../../src/internal/Http.ts";
import { fixture } from "./ScriptedProvider.ts";
import type { DriverEvents } from "../../src/internal/Driver.ts";

/** Regressions found by inspecting the preserved checkpoint, not inherited historical results. */
export const recoveryCases = [
  {
    name: "interactive configuration is projected before strict HTTP validation",
    run: Effect.gen(function* () {
      const options = { projectId: "project-1", apiKey: Redacted.make("private-test-key"),
        viewport: { width: 640, height: 480 }, recordSession: true, keepAlive: true };
      let requests = 0;
      const http = yield* makeHttp(httpOptions(options), async () => {
        requests++;
        return Response.json({ ok: true });
      });
      assert.deepEqual(Object.keys(httpOptions(options)).sort(), ["apiKey", "projectId"]);
      yield* http.json("GET", "/v1/sessions/session-1");
      assert.equal(requests, 1);
    }),
  },
  {
    name: "an operator-pause event during connection setup never exposes an open handle",
    run: Effect.scoped(Effect.gen(function* () {
      const f = yield* fixture({ onConnect: async (driver, events) => { events.pause(); return driver; } });
      const acquisition = yield* f.acquisition;
      const result = yield* acquisition.connect.pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      assert.equal(f.state.releases, 1);
      assert.equal(f.state.localCloses, 1);
    })),
  },
  {
    name: "a retired connection cannot disconnect its replacement",
    run: Effect.scoped(Effect.gen(function* () {
      const connections: DriverEvents[] = [];
      const f = yield* fixture({ keepAlive: true, onObserve: async (events) => { connections.push(events); } });
      const session = yield* (yield* f.acquisition).connect;
      yield* session.observe();
      yield* session.detach;
      yield* session.reconnect(true);
      assert.equal(connections.length, 2);
      connections[0]!.disconnected();
      assert.equal(yield* session.bind().readText(), "initial");
      assert.equal(f.state.connects, 2);
      assert.equal((yield* session.close).remote, "confirmed");
    })),
  },
  {
    name: "a retired target callback cannot invalidate a fresh observation",
    run: Effect.scoped(Effect.gen(function* () {
      const connections: DriverEvents[] = [];
      const f = yield* fixture({ keepAlive: true, onObserve: async (events) => { connections.push(events); } });
      const session = yield* (yield* f.acquisition).connect;
      yield* session.observe();
      yield* session.detach;
      const fresh = yield* session.reconnect(true);
      connections[0]!.invalidate("target-changed");
      assert.equal((yield* session.observe()).revision, fresh.revision);
      connections[1]!.invalidate("observation");
      assert.equal((yield* session.observe()).revision, fresh.revision + 1);
    })),
  },
  {
    name: "a retired connection cannot pause or fault current automation",
    run: Effect.scoped(Effect.gen(function* () {
      const connections: DriverEvents[] = [];
      const f = yield* fixture({ keepAlive: true, onObserve: async (events) => { connections.push(events); } });
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
    })),
  },
];
