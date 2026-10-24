// This proves the executable probe composes with real Chromium and the client fake. It cannot
// prove Browserbase persistence: the fake reconnects to the same local browser context.
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import * as ContextLease from "effect-browserbase/ContextLease";
import { TestBrowserbase } from "effect-browserbase/testing";

import * as Probe from "../HandoverProbe.ts";
import * as Latency from "../Latency.ts";

describe("H2 local composition", () => {
  it.live("executes revoked-work rotation and read-back through two fake provider sessions", () =>
    Effect.gen(function* () {
      const endpoint = yield* Latency.chromiumEndpoint;

      const probe = yield* Probe.make("local-h2-read-back").pipe(
        Effect.provide(TestBrowserbase.layer({ connectUrl: endpoint.href })),
      );

      yield* probe.run.pipe(Effect.provide(ContextLease.layer));
      const report = probe.report();

      assert.strictEqual(report.status, "held", JSON.stringify(report));
      assert.strictEqual(report.attempts, 2);
      assert.isTrue(report.contextDeleted);
      assert.isTrue(Object.values(report.checks).every(Boolean));
      assert.deepStrictEqual(
        report.generations
          .filter((event) => event.state === "Closed")
          .map((event) => event.released),
        ["Settled", "Settled"],
      );
      assert.isNull(report.usageDeltaMinutes, "the fake is not billing evidence");
      assert.notInclude(JSON.stringify(report), endpoint.href);
    }).pipe(Effect.scoped),
  );
});
