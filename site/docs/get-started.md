# Get started

effect-browser runs on Effect 4 and Playwright's Chromium. An agent drives pages through `effect-agent-browser`, on Yielded Agent.

## Install

```sh
npm install effect-browser@beta effect-agent-browser@beta effect playwright-core
npx playwright-core install chromium
```

`effect-agent-browser` peers on `@yielded/agent` `0.1.0-beta.168` exactly, which is not on npm yet. Its [README](https://github.com/mannyc2/effect-agent-browserbase/tree/main/packages/agent-browser#readme) gives the archive to install in its place, as a dependency and an override.

## An agent in a local Chromium

A Yielded agent runs the loop; `BrowserTools` gives it the browser tools over an effect-browser page. Any `effect/ai` `LanguageModel` drives it. This one goes through OpenRouter:

```ts
import { OpenRouterClient, OpenRouterLanguageModel } from "@effect/ai-openrouter";
import { Agent, AgentRuntime, InMemory } from "@yielded/agent";
import { Config, Effect, Layer, Schema } from "effect";
import { BrowserTools } from "effect-agent-browser";
import { Browser, Chromium } from "effect-browser";
import { Model } from "effect/ai";
import { FetchHttpClient } from "effect/http";

const tools = BrowserTools.make();

const reader = Agent.make("top-story", {
  input: Schema.String,
  output: Schema.Struct({ title: Schema.String, points: Schema.Finite }),
  instructions: "Do the task with the browser tools, then answer.",
  toolkit: tools.toolkit,
  // One call at a time: a turn's calls act on one page, in the order the model made them.
  policy: { maxTurns: 12, maxToolCalls: 40, maxDuration: "5 minutes", toolConcurrency: 1 },
});

const program = Effect.gen(function* () {
  const page = yield* (yield* Browser.Browser).firstPage;
  const task = "Report the title and points of the top story.";

  yield* page.goto("https://news.ycombinator.com");

  // The tools act on this page, and the input policy's judge reads the task.
  const result = yield* AgentRuntime.run(reader, task).pipe(
    Effect.provide(Layer.merge(tools.layer({ page }, { task }), InMemory.layer)),
  );

  yield* Effect.log(result.output, result.usage);
});

const OpenRouter = Layer.mergeAll(
  OpenRouterLanguageModel.layer({ model: "<model id>" }),
  Layer.succeed(Model.ProviderName, "openrouter"),
  Layer.succeed(Model.ModelName, "<model id>"),
).pipe(
  Layer.provide(OpenRouterClient.layerConfig({ apiKey: Config.Redacted("OPENROUTER_API_KEY") })),
  Layer.provide(FetchHttpClient.layer),
);

program.pipe(Effect.provide([Chromium.layer(), OpenRouter]), Effect.runPromise);
```

## What the agent sees

Each turn the model gets a screenshot of the current tab and works from an **observation**: a compact outline of the viewport whose controls carry refs such as `e12`. `act` clicks, fills and selects up to eight refs in one call and answers with the next observation, which begins with what followed: a dialog, a navigation, a new tab, or up to three changes the input caused, such as `"Full" became "Kept"`. For what an outline cannot show, such as a canvas or a chart, the pointer tools take viewport coordinates.

Every action result says whether input reached the browser: `acknowledged`, `not-dispatched` when it was refused first, or `unknown` when it failed after. Nothing is ever retried behind the agent's back.

## Next

- Swap `Chromium.layer()` for a [Browserbase](/docs/browserbase) session; nothing else changes.
- Give the run an audience with [moments and narration](/docs/moments-and-narration) and [watched browsing](/docs/watched-browsing).
