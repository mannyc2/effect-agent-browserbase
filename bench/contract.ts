// The `contract` command: the checks effect-browserbase holds its in-memory Browserbase to, run
// against Browserbase itself, so a fake that has drifted from the service shows. It opens two
// sessions of a few seconds each, so it needs EFFECT_BROWSER_BENCH_HOSTED=1.
import { Console, Effect, Layer } from "effect";
import * as BrowserbaseClient from "effect-browserbase/BrowserbaseClient";
import { BrowserbaseContract } from "effect-browserbase/testing";
import { Command } from "effect/cli";
import { FetchHttpClient } from "effect/http";

import { optedIn, refuse } from "./Budget.ts";
import * as Trace from "./Trace.ts";

/** How one check went: it held, Browserbase behaved otherwise, or Browserbase could not be asked. */
export type Verdict =
  | { readonly _tag: "Held"; readonly check: string }
  | { readonly _tag: "Broken"; readonly check: string; readonly detail: string }
  | { readonly _tag: "Unrun"; readonly check: string; readonly detail: string };

/**
 * Each check that needs no test clock, one at a time. A failed call says only its operation and
 * reason, since Browserbase's own text can carry session ids.
 */
export const verify = (checks: ReadonlyArray<BrowserbaseContract.Check>) =>
  Effect.forEach(
    checks.filter((check) => !check.clock),
    (check): Effect.Effect<Verdict, never, BrowserbaseClient.BrowserbaseClient> =>
      check.run.pipe(
        Effect.match({
          onSuccess: () => ({ _tag: "Held", check: check.name }),
          onFailure: (error) =>
            error._tag === "Broken"
              ? { _tag: "Broken", check: check.name, detail: error.detail }
              : {
                  _tag: "Unrun",
                  check: check.name,
                  detail: `${error.operation}: ${error.reason._tag}`,
                },
        }),
      ),
  );

const line = (verdict: Verdict) =>
  verdict._tag === "Held"
    ? `held    ${verdict.check}`
    : `${verdict._tag === "Broken" ? "BROKEN" : "unrun "}  ${verdict.check}: ${verdict.detail}`;

export const command = Command.make("contract", {}, () =>
  Effect.gen(function* () {
    if (!(yield* optedIn("EFFECT_BROWSER_BENCH_HOSTED")))
      return yield* refuse("Browserbase sessions cost money: set EFFECT_BROWSER_BENCH_HOSTED=1");

    const verdicts = yield* verify(BrowserbaseContract.checks).pipe(
      Effect.provide(BrowserbaseClient.layerConfig().pipe(Layer.provide(FetchHttpClient.layer))),
    );

    for (const verdict of verdicts) yield* Console.log(line(verdict));
    const failed = verdicts.filter((verdict) => verdict._tag !== "Held");

    if (failed.length > 0)
      return yield* refuse(
        `${failed.length} of ${verdicts.length} checks did not hold: the fake and Browserbase differ, or Browserbase could not be asked`,
      );
  }).pipe(Effect.provide(Trace.layer)),
).pipe(
  Command.withDescription(
    "Run the checks effect-browserbase's fake is held to against Browserbase itself; needs EFFECT_BROWSER_BENCH_HOSTED=1 and BROWSERBASE_API_KEY.",
  ),
);
