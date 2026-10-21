// The H2 budget and evidence boundary are verified without a hosted session or model call.
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Clock, ConfigProvider, DateTime, Deferred, Effect, Fiber } from "effect";
import { BrowserbaseClient } from "effect-browserbase/BrowserbaseClient";
import { BrowserbaseError, Transport } from "effect-browserbase/BrowserbaseError";
import * as ContextLease from "effect-browserbase/ContextLease";
import { TestBrowserbase } from "effect-browserbase/testing";
import { Command } from "effect/cli";
import { TestClock } from "effect/testing";

import * as Handover from "../handover.ts";
import * as Probe from "../HandoverProbe.ts";

describe("H2 hosted admission", () => {
  it.effect(
    "refuses the command before reading files or provider config without exact opt-in",
    () =>
      Effect.gen(function* () {
        const error = yield* Command.runWith(Handover.command, { version: "test" })([
          "--allowance",
          "/missing-private-file",
        ]).pipe(
          Effect.provide([
            NodeServices.layer,
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({ EFFECT_BROWSER_BENCH_HOSTED: "yes" }),
            ),
          ]),
          Effect.flip,
        );

        assert.strictEqual(error._tag, "BenchError");
        assert.include(error.message, "EFFECT_BROWSER_BENCH_HOSTED=1");
      }),
  );

  it.effect("requires recent explicit allowance with ten included minutes", () =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;

      const valid = {
        verifiedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
        verificationFile: "/private/dashboard-evidence",
        includedMinutes: 10,
        overageDisabled: true,
        exclusiveUse: true,
        usageBeforeMinutes: 20,
      };

      assert.strictEqual((yield* Probe.validateAllowance(valid)).includedMinutes, 10);
      for (const changed of [
        { includedMinutes: 9 },
        { overageDisabled: false },
        { exclusiveUse: false },
        { verifiedAt: "unknown" },
        { verifiedAt: DateTime.formatIso(DateTime.makeUnsafe(now - 3_600_001)) },
      ]) {
        assert.strictEqual(
          (yield* Effect.flip(Probe.validateAllowance({ ...valid, ...changed })))._tag,
          "BenchError",
        );
      }
    }),
  );

  it.effect("admits only two creates and never serializes provider ids or credential URLs", () =>
    Effect.gen(function* () {
      const source = yield* BrowserbaseClient;
      const limited = Probe.admission(source, () => 10);
      const first = yield* limited.client.createSession({ timeout: 120 });
      const second = yield* limited.client.createSession({ timeout: 120 });

      yield* limited.client.releaseSession(first.id);
      yield* limited.client.getSession(first.id);
      assert.strictEqual(
        (yield* Effect.flip(limited.client.createSession())).reason._tag,
        "InvalidRequest",
      );
      const evidence = limited.evidence();
      const serialized = JSON.stringify(evidence);

      assert.strictEqual(evidence.attempts, 2);
      assert.isFalse(evidence.uncertain);
      assert.deepStrictEqual(
        evidence.sessions.map((session) => session.alias),
        [1, 2],
      );
      assert.notInclude(serialized, first.id);
      assert.notInclude(serialized, second.id);
      assert.notInclude(serialized, "secret.invalid");
      assert.isTrue(
        evidence.calls.some((call) => call.operation === "sessionEnded" && call.session === 1),
      );
    }).pipe(
      Effect.provide(
        TestBrowserbase.layer({ connectUrl: "wss://secret.invalid/private-credential" }),
      ),
    ),
  );

  it.effect(
    "counts before dispatch and leaves admission closed when an unanswered create is canceled",
    () =>
      Effect.gen(function* () {
        const source = yield* BrowserbaseClient;
        const entered = yield* Deferred.make<void>();
        let dispatched = 0;

        const limited = Probe.admission(
          {
            ...source,
            createSession: () =>
              Effect.sync(() => {
                dispatched += 1;
              }).pipe(
                Effect.andThen(Deferred.succeed(entered, undefined)),
                Effect.andThen(Effect.never),
              ),
          },
          () => 20,
        );

        const first = yield* limited.client.createSession().pipe(Effect.forkChild);

        yield* Deferred.await(entered);
        assert.strictEqual(
          (yield* Effect.flip(limited.client.createSession())).reason._tag,
          "InvalidRequest",
        );
        yield* Fiber.interrupt(first);
        assert.strictEqual(
          (yield* Effect.flip(limited.client.createSession())).reason._tag,
          "InvalidRequest",
        );
        assert.strictEqual(dispatched, 1);
        assert.strictEqual(limited.evidence().attempts, 1);
        assert.isTrue(limited.evidence().uncertain);
      }).pipe(Effect.provide(TestBrowserbase.layer())),
  );

  it.effect("does not retry a lost create acknowledgement or retain its private error text", () =>
    Effect.gen(function* () {
      const source = yield* BrowserbaseClient;

      const limited = Probe.admission(
        {
          ...source,
          createSession: () =>
            Effect.fail(
              new BrowserbaseError({
                operation: "createSession",
                reason: new Transport({ detail: "private-session-id wss://secret.invalid" }),
              }),
            ),
        },
        () => 30,
      );

      yield* Effect.flip(limited.client.createSession());
      assert.strictEqual(
        (yield* Effect.flip(limited.client.createSession())).reason._tag,
        "InvalidRequest",
      );
      assert.strictEqual(limited.evidence().attempts, 1);
      assert.isTrue(limited.evidence().uncertain);
      assert.notInclude(JSON.stringify(limited.evidence()), "private-session-id");
      assert.notInclude(JSON.stringify(limited.evidence()), "secret.invalid");
    }).pipe(Effect.provide(TestBrowserbase.layer())),
  );
});

it.effect("fails promptly when its child cannot acquire the first generation", () =>
  Effect.gen(function* () {
    const probe = yield* Probe.make("rejected-first-generation").pipe(
      Effect.provide(TestBrowserbase.layer({ creates: [{ _tag: "Reject", status: 403 }] })),
    );

    const running = yield* probe.run.pipe(
      Effect.provide(ContextLease.layer),
      Effect.exit,
      Effect.forkChild,
    );

    yield* TestClock.adjust("1 second");
    yield* Effect.yieldNow;
    const result = running.pollUnsafe();

    assert.isDefined(result, "provider refusal must not leave the entry rendezvous suspended");
    if (result?._tag === "Success") assert.strictEqual(result.value._tag, "Failure");
  }).pipe(Effect.scoped),
);
