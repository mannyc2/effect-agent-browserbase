// The demo's command line: `take` records a narrated take of a demo, Polymarket or the casino, and
// packs it for the site; `pack` packs a recording again, such as a bench trial's, with or without
// the voice. Model calls cost money, so a take needs the bench's opt-in and an OpenRouter key.
//
//   bun run demo take [--demo casino] [--model <id>] [--max-usd 0.5] [--id casino]
//   bun run demo pack <recording directory> <replay id> [--voice]
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { errorText } from "bench/run.ts";
import { Cause, Console, Effect, Option, Schema } from "effect";
import { Argument, CliError, Command, Flag } from "effect/cli";
import { FetchHttpClient } from "effect/http";

import { demoNames, stepsFor } from "./defaults.ts";
import { pack } from "./pack.ts";
import { defaults, take } from "./take.ts";
import * as Voice from "./voice.ts";

const replayId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/));

const takeCommand = Command.make(
  "take",
  {
    demo: Flag.Literals("demo", demoNames).pipe(
      Flag.withDefault(defaults.demo),
      Flag.withDescription(
        `The demo to record: ${demoNames.join(" or ")}. Defaults to ${defaults.demo}.`,
      ),
    ),
    id: Flag.String("id").pipe(
      Flag.withSchema(replayId),
      Flag.optional,
      Flag.withDescription(
        "The replay to pack it as, under public/replays/. Defaults to the demo's name.",
      ),
    ),
    model: Flag.String("model").pipe(
      Flag.withDefault(defaults.model),
      Flag.withDescription(`OpenRouter model for the agent. Defaults to ${defaults.model}.`),
    ),
    reasoning: Flag.Literals("reasoning", ["none", "low", "medium", "high"]).pipe(
      Flag.withDefault(defaults.reasoning),
      Flag.withDescription(`The agent's reasoning effort. Defaults to ${defaults.reasoning}.`),
    ),
    maxUsd: Flag.Finite("max-usd").pipe(
      Flag.withSchema(Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(5))),
      Flag.withDefault(defaults.maxUsd),
      Flag.withDescription(
        `USD for the agent and its voice together. Defaults to ${defaults.maxUsd}.`,
      ),
    ),
    maxSteps: Flag.Int("max-steps").pipe(
      Flag.optional,
      Flag.withDescription(
        `The agent's turns. Defaults to ${Object.entries(stepsFor)
          .map(([demo, steps]) => `${steps} for ${demo}`)
          .join(" and ")}.`,
      ),
    ),
    headed: Flag.Boolean("headed").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Show the local chromium's window."),
    ),
  },
  (options) =>
    take({
      ...options,
      id: Option.getOrElse(options.id, () => options.demo),
      maxSteps: Option.getOrElse(options.maxSteps, () => stepsFor[options.demo]),
    }),
).pipe(Command.withDescription("Record a narrated take of a demo and pack it."));

const packCommand = Command.make(
  "pack",
  {
    source: Argument.String("recording"),
    id: Argument.String("replay").pipe(Argument.withSchema(replayId)),
    voice: Flag.Boolean("voice").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Speak the agent's words, a paid call per line."),
    ),
    maxUsd: Flag.Finite("max-usd").pipe(
      Flag.withDefault(0.25),
      Flag.withDescription("USD for the voice. Defaults to 0.25."),
    ),
  },
  Effect.fnUntraced(function* ({ source, id, voice, maxUsd }) {
    const speaking = voice
      ? Option.some(
          yield* Voice.make({ ...Voice.defaults, maxUsd }).pipe(
            Effect.provide(FetchHttpClient.layer),
          ),
        )
      : Option.none();

    yield* pack(source, id, Option.getOrUndefined(speaking));
  }),
).pipe(Command.withDescription("Pack a recording for the site, optionally with the voice."));

Command.make("demo").pipe(
  Command.withDescription(
    "The site's narrated demos: an agent exploring Polymarket, or playing a slot.",
  ),
  Command.withSubcommands([takeCommand, packCommand]),
  Command.run({ version: "0.3" }),
  Effect.tapCause((cause) =>
    Cause.hasInterruptsOnly(cause) || CliError.isCliError(Cause.squash(cause))
      ? Effect.void
      : Console.error(errorText(cause)),
  ),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
