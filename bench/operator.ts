/** Opt-in H3 with private viewer delivery; never print the capability URL or account details. */
import { Console, Effect, FileSystem, Redacted, Schema } from "effect";
import { BrowserbaseClient } from "effect-browserbase/BrowserbaseClient";
import { Command, Flag } from "effect/cli";

import { BenchError } from "./Budget.ts";
import * as Hosted from "./HostedProbe.ts";
import * as Operator from "./OperatorProbe.ts";

export const command = Command.make(
  "operator",
  {
    allowance: Flag.String("allowance").pipe(
      Flag.withDescription("Private included-allowance JSON; see docs/HOSTED_CHECKS.md"),
    ),
    settings: Flag.String("settings").pipe(
      Flag.withDescription("Private startUrl and signedIn query JSON"),
    ),
  },
  ({ allowance, settings: settingsFile }) =>
    Effect.gen(function* () {
      const evidence = yield* Hosted.prepare("h3", allowance);
      const fs = yield* FileSystem.FileSystem;

      const settings = yield* fs.readFileString(settingsFile).pipe(
        Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Operator.Settings))),
        Effect.mapError(
          () =>
            new BenchError({
              message:
                "H3 requires private settings with an HTTPS sign-in URL and specific signed-in query",
            }),
        ),
      );

      let report: () => unknown = () => ({ started: false });

      yield* Hosted.run(
        evidence,
        300,
        (hosted) =>
          Effect.gen(function* () {
            const client = yield* BrowserbaseClient;
            const viewer = yield* client.liveView(hosted.session.id, { expiresInSeconds: 300 });

            const ready = evidence
              .write("viewer.json", {
                viewer: Redacted.value(viewer.debuggerUrl),
                instruction:
                  "Open the viewer, click Open sign-in page, and sign in manually in the new tab. This capability URL is private.",
              })
              .pipe(
                Effect.andThen(
                  Console.log(`H3 private viewer instructions: ${evidence.directory}/viewer.json`),
                ),
              );

            const probe = yield* Operator.make(hosted.browser, settings, ready);

            report = probe.report;
            yield* probe.run;
          }),
        () => report(),
      ).pipe(Effect.provide(Hosted.provider));
    }),
).pipe(
  Command.withDescription(
    "H3: a three-minute manual sign-in with automated input suspended; one bounded hosted session.",
  ),
);
