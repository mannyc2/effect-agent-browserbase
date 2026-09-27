import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { Command } from "effect/unstable/cli";

import { cli } from "./Cli.ts";

cli().pipe(
  Command.run({ version: "4.0.0" }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
