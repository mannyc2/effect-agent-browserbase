// The bench's command line: `run` runs tasks, `report` summarizes results files and `judges` grades
// input judges. Model calls and hosted browsers cost money, so each command asks for its opt-in.
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Cause, Console, Effect } from "effect";
import { CliError, Command } from "effect/cli";

import * as Judges from "./judges.ts";
import * as Report from "./Report.ts";
import * as Run from "./run.ts";

Command.make("bench").pipe(
  Command.withDescription(
    "Graded browser tasks for effect-browser: scripted solutions for free, models behind opt-ins.",
  ),
  Command.withSubcommands([Run.command, Report.command, Judges.command]),
  Command.run({ version: "0.3" }),
  // The command line explains its own usage errors. Anything else prints only what the bench
  // itself wrote, since a provider's error can embed URLs or account ids.
  Effect.tapCause((cause) =>
    Cause.hasInterruptsOnly(cause) || CliError.isCliError(Cause.squash(cause))
      ? Effect.void
      : Console.error(Run.errorText(cause)),
  ),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
