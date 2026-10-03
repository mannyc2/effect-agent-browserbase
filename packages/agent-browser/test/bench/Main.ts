import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, References } from "effect";
import { Command } from "effect/unstable/cli";

import { cli } from "./Cli.ts";

// Logs go to stderr, apart from the JSON the commands print, and only warnings and above: the
// runtime's per-call logs name provider identifiers. Stderr is the operator's, never a record.
cli().pipe(
  Command.run({ version: "4.0.0" }),
  Effect.provideService(References.MinimumLogLevel, "Warn"),
  Effect.provideService(References.LogToStderr, true),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
