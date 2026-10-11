// The demo's command line: `take` records a narrated take of the Polymarket demo and packs it for
// the site; `pack` packs a recording again, such as a bench trial's, with or without the voice.
// Model calls cost money, so a take needs the bench's opt-in and an OpenRouter key.
//
//   bun run demo take [--model <id>] [--max-usd 0.5] [--every 5] [--id polymarket]
//   bun run demo pack <recording directory> <replay id> [--voice]
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { errorText } from "bench/run.ts";
import { Cause, Console, Duration, Effect, Option, Schema } from "effect";
import { Argument, CliError, Command, Flag } from "effect/cli";
import { FetchHttpClient } from "effect/http";

import { pack } from "./pack.ts";
import { defaults, take } from "./take.ts";
import * as Voice from "./voice.ts";

const replayId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/));

const takeCommand = Command.make(
  "take",
  {
    id: Flag.String("id").pipe(
      Flag.withSchema(replayId),
      Flag.withDefault(defaults.id),
      Flag.withDescription(
        `The replay to pack it as, under public/replays/. Defaults to ${defaults.id}.`,
      ),
    ),
    model: Flag.String("model").pipe(
      Flag.withDefault(defaults.model),
      Flag.withDescription(
        `OpenRouter model for the agent and narrator. Defaults to ${defaults.model}.`,
      ),
    ),
    reasoning: Flag.Literals("reasoning", ["none", "low", "medium", "high"]).pipe(
      Flag.withDefault(defaults.reasoning),
      Flag.withDescription(`The agent's reasoning effort. Defaults to ${defaults.reasoning}.`),
    ),
    maxUsd: Flag.Finite("max-usd").pipe(
      Flag.withSchema(Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(5))),
      Flag.withDefault(defaults.maxUsd),
      Flag.withDescription(
        `USD for the agent, narrator and voice together. Defaults to ${defaults.maxUsd}.`,
      ),
    ),
    every: Flag.Finite("every").pipe(
      Flag.withSchema(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(3))),
      Flag.withDefault(Duration.toSeconds(defaults.every)),
      Flag.withDescription(
        `Seconds from the start of one of the host's lines to the next. Defaults to ${Duration.toSeconds(defaults.every)}.`,
      ),
    ),
    maxSteps: Flag.Int("max-steps").pipe(
      Flag.withDefault(defaults.maxSteps),
      Flag.withDescription(`The agent's turns. Defaults to ${defaults.maxSteps}.`),
    ),
    headed: Flag.Boolean("headed").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Show the local chromium's window."),
    ),
  },
  (options) => take({ ...options, every: Duration.seconds(options.every) }),
).pipe(Command.withDescription("Record a narrated take of the Polymarket demo and pack it."));

const packCommand = Command.make(
  "pack",
  {
    source: Argument.String("recording"),
    id: Argument.String("replay").pipe(Argument.withSchema(replayId)),
    voice: Flag.Boolean("voice").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Speak the narrator's captions, a paid call per line."),
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
  Command.withDescription("The site's narrated demo: an agent exploring Polymarket."),
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
