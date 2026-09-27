import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, References } from "effect";
import { Command } from "effect/unstable/cli";

import { cli } from "./Cli.ts";

// The runtime's per-call logs name provider identifiers; the console keeps warnings and above.
cli().pipe(
  Command.run({ version: "4.0.0" }),
  Effect.provideService(References.MinimumLogLevel, "Warn"),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
