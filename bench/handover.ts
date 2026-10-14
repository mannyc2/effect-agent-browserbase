/** The opt-in H2 command. Only closed, aliased evidence reaches its private output directory. */
import { Console, Crypto, Effect, FileSystem, Layer, Path, Schema } from "effect";
import * as BrowserbaseClient from "effect-browserbase/BrowserbaseClient";
import * as ContextLease from "effect-browserbase/ContextLease";
import { Command, Flag } from "effect/cli";
import { FetchHttpClient } from "effect/http";

import { BenchError, optedIn, refuse } from "./Budget.ts";
import * as Handover from "./HandoverProbe.ts";
import { revision } from "./Trial.ts";

const readError = () =>
  new BenchError({ message: "H2 could not read its allowance or write private evidence" });

export const command = Command.make(
  "handover",
  {
    allowance: Flag.String("allowance").pipe(
      Flag.withDescription(
        "Private JSON file verifying this project's included allowance and disabled overage; see docs/HOSTED_CHECKS.md.",
      ),
    ),
  },
  ({ allowance: allowanceFile }) =>
    Effect.gen(function* () {
      if (!(yield* optedIn("EFFECT_BROWSER_BENCH_HOSTED")))
        return yield* refuse(
          "Browserbase sessions cost money: set EFFECT_BROWSER_BENCH_HOSTED=1 after verifying included allowance",
        );
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const allowance = yield* fs
        .readFileString(allowanceFile)
        .pipe(
          Effect.mapError(readError),
          Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))),
          Effect.mapError(readError),
          Effect.flatMap(Handover.validateAllowance),
        );

      const source = yield* revision;

      if (source.commit === null || source.dirty !== false)
        return yield* refuse(
          "H2 requires a clean tested commit; commit the reviewed probe before running it",
        );
      const crypto = yield* Crypto.Crypto;

      const verification = yield* fs
        .readFile(allowance.verificationFile)
        .pipe(Effect.mapError(readError));

      if (verification.length === 0)
        return yield* refuse("H2 requires the retained private dashboard verification evidence");
      const verificationHash = yield* crypto.digest("SHA-256", verification);
      const runId = yield* crypto.randomUUIDv4();
      const directory = path.join(import.meta.dirname, "..", ".work", "h2", runId);
      const versions: Record<string, string> = {};

      for (const name of ["browser", "browserbase", "agent-browser", "human-strokes"]) {
        const manifest = yield* fs
          .readFileString(path.join(import.meta.dirname, "..", "packages", name, "package.json"))
          .pipe(
            Effect.mapError(readError),
            Effect.flatMap(
              Schema.decodeEffect(
                Schema.fromJsonString(
                  Schema.Struct({ name: Schema.String, version: Schema.String }),
                ),
              ),
            ),
          );

        versions[manifest.name] = manifest.version;
      }
      yield* fs
        .makeDirectory(directory, { recursive: true, mode: 0o700 })
        .pipe(Effect.mapError(readError));

      const write = (name: string, value: unknown) =>
        fs
          .writeFileString(path.join(directory, name), `${JSON.stringify(value, null, 2)}\n`, {
            flag: "wx",
            mode: 0o600,
          })
          .pipe(Effect.mapError(readError));

      const { verificationFile: _, ...verifiedAllowance } = allowance;

      const setup = {
        runId,
        source,
        versions,
        allowance: {
          ...verifiedAllowance,
          verificationSha256: Buffer.from(verificationHash).toString("hex"),
        },
        usageDeltaMinutes: null,
      };

      yield* write("started.json", setup);
      yield* Effect.gen(function* () {
        const probe = yield* Handover.make(runId);

        yield* probe.run.pipe(
          Effect.ensuring(
            Effect.suspend(() => write("result.json", { ...setup, ...probe.report() })).pipe(
              Effect.orDie,
            ),
          ),
        );
        const result = probe.report();

        yield* Console.log(`H2 ${result.status}; private evidence: ${directory}`);
        if (result.status !== "held")
          return yield* refuse(
            "H2 did not establish all ordering, persistence and release checks; do not repeat an uncertain run blindly",
          );
      }).pipe(
        Effect.provide([
          BrowserbaseClient.layerConfig().pipe(Layer.provide(FetchHttpClient.layer)),
          ContextLease.layer,
        ]),
      );
    }),
).pipe(
  Command.withDescription(
    "H2 persisted rotation with a live hold; at most two 120-second sessions, no model calls.",
  ),
);
