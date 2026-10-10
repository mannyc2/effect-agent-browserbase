// H1/H3 cannot reach provider configuration without exact opt-in, and each admits one attempt.
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect } from "effect";
import { BrowserbaseClient } from "effect-browserbase/BrowserbaseClient";
import { TestBrowserbase } from "effect-browserbase/testing";
import { Command } from "effect/cli";

import * as Cue from "../cue.ts";
import * as Hosted from "../HostedProbe.ts";
import * as Operator from "../operator.ts";

describe("H1/H3 hosted admission", () => {
  it.effect("refuses both commands before reading files or provider configuration", () =>
    Effect.gen(function* () {
      for (const invoke of [
        Command.runWith(Cue.command, { version: "test" })(["--allowance", "/missing-private-file"]),
        Command.runWith(Operator.command, { version: "test" })([
          "--allowance",
          "/missing-private-file",
          "--settings",
          "/missing-private-settings",
        ]),
      ]) {
        const error = yield* invoke.pipe(
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
      }
    }),
  );

  it.effect("keeps admission closed after its one session has settled", () =>
    Effect.gen(function* () {
      const source = yield* BrowserbaseClient;
      const observed = Hosted.single(source, () => 10);
      const session = yield* observed.client.createSession({ timeout: 420 });

      yield* observed.client.releaseSession(session.id);
      yield* observed.client.getSession(session.id);
      assert.strictEqual(
        (yield* Effect.flip(observed.client.createSession({ timeout: 420 }))).reason._tag,
        "InvalidRequest",
      );
      assert.strictEqual(observed.evidence().attempts, 1);
      assert.isFalse(observed.evidence().uncertain);
      assert.notInclude(JSON.stringify(observed.evidence()), session.id);
    }).pipe(Effect.provide(TestBrowserbase.layer())),
  );
});
