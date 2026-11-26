# Get started

effect-browser runs on Effect 4 and Playwright's Chromium. An agent drives pages with `effect-browser/ai`'s tools, here through `@effect-browser/yielded` on Yielded Agent.

## Install

`@effect-browser/yielded` peers on the published npm release of `@yielded/agent` `0.1.0-beta.191` exactly. Effect and the OpenRouter provider are pinned to `4.1.2`. If you installed an earlier release with an archive override for Yielded, remove that override and refresh your lockfile before installing.

:::Example
```sh
mkdir top-story && cd top-story && npm init -y > /dev/null && npm pkg set type=module
npm install @yielded/agent@0.1.0-beta.191 effect-browser@beta @effect-browser/chromium@beta @effect-browser/yielded@beta effect@4.1.2 @effect/ai-openrouter@4.1.2 playwright-core@1.63.0
npx playwright-core install chromium
```

Captured on 26 November 2026 in a fresh npm project on Linux with Node `24.14.1` and npm `11.11.0`.
`effect-browser`, `@effect-browser/chromium` and `@effect-browser/yielded` resolved to `0.3.0-beta.25`.
Chromium was already installed on this host, so its install command printed nothing:

```text output
added 8 packages, and audited 9 packages in 1s

1 package is looking for funding
  run `npm fund` for details

found 0 vulnerabilities
```
:::

## An agent in a local Chromium

A Yielded agent runs the loop; `YieldedTools` gives it the browser tools over an effect-browser page. Any `effect/ai` `LanguageModel` drives it. This one goes through OpenRouter. Save it as `agent.ts` in the same directory:

:::Example
```ts
import { Chromium } from "@effect-browser/chromium";
import { YieldedTools } from "@effect-browser/yielded";
import { OpenRouterClient, OpenRouterLanguageModel } from "@effect/ai-openrouter";
import { Agent, AgentRuntime, InMemory } from "@yielded/agent";
import { Config, Effect, Layer, Schema } from "effect";
import { Browser } from "effect-browser";
import { Model } from "effect/ai";
import { FetchHttpClient } from "effect/http";

const tools = YieldedTools.make();

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
  // Ask OpenRouter for a structured answer that follows the output schema.
  OpenRouterLanguageModel.layer({
    model: "openai/gpt-6-luna",
    config: { strictJsonSchema: true },
  }),
  Layer.succeed(Model.ProviderName, "openrouter"),
  Layer.succeed(Model.ModelName, "openai/gpt-6-luna"),
).pipe(
  Layer.provide(OpenRouterClient.layerConfig({ apiKey: Config.Redacted("OPENROUTER_API_KEY") })),
  Layer.provide(FetchHttpClient.layer),
);

program.pipe(Effect.provide([Chromium.layer(), OpenRouter]), Effect.runPromise);
```

Run with `OPENROUTER_API_KEY=… node agent.ts`. The following result is from 26 November 2026, with the packages installed above. The run took two model calls:

```text output
[12:13:22.845] INFO (#2): {
  title: 'Euro-Office comes to your desktop with the Nextcloud Office Desktop app',
  points: 320
} RunTotals {
  modelCalls: 2,
  inputTokens: 11566,
  outputTokens: 110,
  webSearchCalls: 0,
  costMicrousd: 0,
  usageStatus: 'complete',
  pricingStatus: 'unknown',
  unobservedModelCalls: 0
}
```
:::

## What the agent sees

Each turn the model gets a screenshot of the current tab and works from an **observation**: a compact outline of the viewport whose controls carry refs such as `e12`. `act` clicks, fills and selects up to eight refs in one call and answers with the next observation, which begins with what followed: a dialog, a navigation, a new tab, or up to three changes the input caused, such as `"Full" became "Kept"`. For what an outline cannot show, such as a canvas or a chart, the pointer tools take viewport coordinates.

Every action result says whether input reached the browser: `acknowledged`, `not-dispatched` when it was refused first, or `possibly-dispatched` when it failed after. Nothing is ever retried behind the agent's back.

## Next

- Swap `Chromium.layer()` for a [Browserbase](/docs/browserbase) session; nothing else changes.
- Give the run an audience with [moments and narration](/docs/moments-and-narration) and [watched browsing](/docs/watched-browsing).
