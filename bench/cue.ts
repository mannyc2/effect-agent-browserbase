/** Opt-in executable H1; duration, page count and capture settings are deliberately fixed. */
import { Effect } from "effect";
import { Command, Flag } from "effect/cli";

import * as Cue from "./CueProbe.ts";
import * as Hosted from "./HostedProbe.ts";

export const command = Command.make(
  "cue",
  {
    allowance: Flag.String("allowance").pipe(
      Flag.withDescription("Private included-allowance JSON; see docs/HOSTED_CHECKS.md"),
    ),
  },
  ({ allowance }) =>
    Effect.gen(function* () {
      const evidence = yield* Hosted.prepare("h1", allowance);
      let report: () => unknown = () => ({ started: false });

      yield* Hosted.run(
        evidence,
        420,
        (hosted) =>
          Effect.gen(function* () {
            const probe = yield* Cue.make(hosted.browser);

            report = probe.report;
            yield* probe.run;
          }),
        () => report(),
      ).pipe(Effect.provide(Hosted.provider));
    }),
).pipe(
  Command.withDescription(
    "H1: 20 cued reveals in five measured minutes, each warmed for 30 seconds; one bounded hosted session.",
  ),
);
