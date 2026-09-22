import assert from "node:assert/strict";

import { it } from "@effect/vitest";
import { Effect, ErrorReporter, Layer } from "effect";

import { fixture } from "./fixtures/ScriptedProvider.ts";
import { elapse } from "./fixtures/Time.ts";

interface Seen {
  readonly message: string;
  readonly severity: string;
  readonly attributes: Readonly<Record<string, unknown>>;
}

/** Captures what an application's own reporter would receive, with no callback registered. */
const capture = () => {
  const seen: Array<Seen> = [];

  const layer = ErrorReporter.layer([
    ErrorReporter.make(({ error, severity, attributes }) => {
      seen.push({ message: error.message, severity, attributes });
    }),
  ]);

  return { seen, layer };
};

it.effect("an unconfirmed release reaches the application's reporter without a callback", () => {
  const reporter = capture();

  return Effect.gen(function* () {
    const f = yield* fixture({ releaseFails: true });
    const session = yield* (yield* f.acquisition).connect;
    const report = yield* elapse(session.close, 12_000);

    assert.notEqual(report.remote, "confirmed");
    assert.equal(reporter.seen.length, 1);
    const [seen] = reporter.seen;

    assert.ok(seen);
    assert.equal(seen.severity, "Warn");
    assert.equal(seen.message, "Browserbase session cleanup ended without confirmation");
    assert.equal(seen.attributes.sessionId, "session-1");
    assert.equal(seen.attributes.ownership, "owned");
    assert.equal(seen.attributes.remote, report.remote);
    assert.equal(seen.attributes.local, "closed");
    // Identity and outcome labels only: nothing that could carry a credential or a body.
    for (const value of Object.values(seen.attributes))
      assert.doesNotMatch(String(value), /PRIVATE|wss:|https:/);
  }).pipe(Effect.scoped, Effect.provide(Layer.fresh(reporter.layer)));
});

it.effect("an allocation of unknown outcome reaches the application's reporter", () => {
  const reporter = capture();

  return Effect.gen(function* () {
    const f = yield* fixture({ createFails: true });

    yield* f.acquisition.pipe(Effect.result);
    assert.equal(f.uncertain.length, 1);
    assert.equal(reporter.seen.length, 1);
    const [seen] = reporter.seen;

    assert.ok(seen);
    assert.equal(seen.severity, "Warn");
    assert.equal(seen.message, "Browserbase allocation outcome is unknown");
    assert.equal(seen.attributes.attemptId, f.uncertain[0]);
  }).pipe(Effect.scoped, Effect.provide(Layer.fresh(reporter.layer)));
});

it.effect("a confirmed release reports nothing", () => {
  const reporter = capture();

  return Effect.gen(function* () {
    const f = yield* fixture();
    const session = yield* (yield* f.acquisition).connect;
    const report = yield* session.close;

    assert.equal(report.remote, "confirmed");
    assert.deepEqual(reporter.seen, []);
  }).pipe(Effect.scoped, Effect.provide(Layer.fresh(reporter.layer)));
});
