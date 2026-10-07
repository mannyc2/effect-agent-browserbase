// The `contract` command: the checks effect-browserbase holds its in-memory Browserbase to, run
// against Browserbase itself, so a fake that has drifted from the service shows. It opens two
// sessions of a few seconds each, so it needs EFFECT_BROWSER_BENCH_HOSTED=1.
import { Console, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
import * as BrowserbaseClient from "effect-browserbase/BrowserbaseClient";
import { BrowserbaseContract } from "effect-browserbase/testing";
import { Command, Flag } from "effect/cli";
import { FetchHttpClient } from "effect/http";

import { BenchError, optedIn, refuse } from "./Budget.ts";
import * as OpenApi from "./OpenApi.ts";
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

/**
 * Compare the operations Browserbase publishes now with the copy effect-browserbase's shape test
 * reads. A difference leaves the published ones in `.work/contract/` to review and copy over.
 */
const compareShapes = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.join(import.meta.dirname, "..");
  const copied = path.join(root, "packages", "browserbase", "test", "browserbase-openapi.json");
  const live = yield* OpenApi.published.pipe(Effect.provide(FetchHttpClient.layer));

  // A copy that is missing or does not decode differs in every operation.
  const copy = yield* fs
    .readFileString(copied)
    .pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(OpenApi.Copy))), Effect.option);

  const changed = OpenApi.operations.filter(
    (id) =>
      OpenApi.canonical(live.operations[id]) !==
      OpenApi.canonical(Option.getOrUndefined(copy)?.operations[id]),
  );

  for (const id of OpenApi.operations)
    yield* Console.log(
      `${live.operations[id] === undefined ? "MISSING" : changed.includes(id) ? "CHANGED" : "same   "}  ${id}`,
    );
  if (changed.length === 0) return;

  const fresh = path.join(root, ".work", "contract", "browserbase-openapi.json");

  yield* fs.makeDirectory(path.dirname(fresh), { recursive: true });
  yield* fs.writeFileString(fresh, `${JSON.stringify(live, null, 2)}\n`);

  return yield* refuse(
    `${changed.length} of ${OpenApi.operations.length} operations differ from ${copied}; Browserbase's are in ${fresh}`,
  );
}).pipe(
  Effect.catchTag("PlatformError", (error) =>
    Effect.fail(new BenchError({ message: `could not compare shapes: ${error.message}` })),
  ),
);

export const command = Command.make(
  "contract",
  {
    spec: Flag.Boolean("spec").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "Instead, compare Browserbase's published OpenAPI document with the copy effect-browserbase's shape test reads: free, with no session.",
      ),
    ),
  },
  ({ spec }) =>
    Effect.gen(function* () {
      if (spec) return yield* compareShapes;
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
