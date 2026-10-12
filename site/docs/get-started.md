# Get started

effect-browser runs on Effect 4 and Playwright's Chromium. An agent drives pages through `effect-agent-browser`, on Yielded Agent.

## Install

`effect-agent-browser` peers on `@yielded/agent` `0.1.0-beta.168` exactly, which is not on npm yet, so the install takes the archive its release is checked with, as a dependency and as an override; its [README](https://github.com/mannyc2/effect-agent-browserbase/tree/main/packages/agent-browser#readme) says where the archive comes from. Effect is pinned to 4.0.0, the version the packages are tested with.

:::Example
```sh
mkdir top-story && cd top-story && npm init -y > /dev/null && npm pkg set type=module
# Yielded Agent 0.1.0-beta.168 is not on npm yet: install the archive this release is checked with.
YIELDED=https://raw.githubusercontent.com/mannyc2/effect-agent-browserbase/1c40d56a631ea0a041577d9736a7484e3d0f4b62/yielded-agent-0.1.0-beta.168.tgz
npm pkg set "overrides[@yielded/agent]=$YIELDED"
npm install "$YIELDED" effect-browser@beta effect-agent-browser@beta effect@4.0.0 @effect/ai-openrouter@4.0.0 playwright-core
npx playwright-core install chromium
```

Run on Linux with Node 24 and npm 11 on 11 October 2026:

```text output
added 6 packages, and audited 7 packages in 3s

found 0 vulnerabilities
Downloading Chrome for Testing 156.0.8078.4 (playwright chromium v1248) from https://cdn.playwright.dev/builds/cft/156.0.8078.4/linux64/chrome-linux64.zip
Chrome for Testing 156.0.8078.4 (playwright chromium v1248) downloaded to ~/.cache/ms-playwright/chromium-1248
Downloading FFmpeg (playwright ffmpeg v1013) from https://cdn.playwright.dev/dbazure/download/playwright/builds/ffmpeg/1013/ffmpeg-linux.zip
FFmpeg (playwright ffmpeg v1013) downloaded to ~/.cache/ms-playwright/ffmpeg-1013
Downloading Chrome Headless Shell 156.0.8078.4 (playwright chromium-headless-shell v1248) from https://cdn.playwright.dev/builds/cft/156.0.8078.4/linux64/chrome-headless-shell-linux64.zip
Chrome Headless Shell 156.0.8078.4 (playwright chromium-headless-shell v1248) downloaded to ~/.cache/ms-playwright/chromium_headless_shell-1248
```
:::

## An agent in a local Chromium

A Yielded agent runs the loop; `BrowserTools` gives it the browser tools over an effect-browser page. Any `effect/ai` `LanguageModel` drives it. This one goes through OpenRouter. Save it as `agent.ts` in the same directory:

:::Example
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
  // Without strictJsonSchema, @effect/ai-openrouter 4.0.0 sends `strict: null`, OpenRouter drops
  // the response format, and a structured answer comes back as prose.
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

Run with `OPENROUTER_API_KEY=… node agent.ts` on 11 October 2026. The model read the top story off the first screenshot, so the run took one model call:

```text output
[20:23:58.322] INFO (#1): {
  title: 'Total Annihilation, rebuilt for modern computers',
  points: 155
} RunTotals {
  modelCalls: 1,
  inputTokens: 2944,
  outputTokens: 58,
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

Every action result says whether input reached the browser: `acknowledged`, `not-dispatched` when it was refused first, or `unknown` when it failed after. Nothing is ever retried behind the agent's back.

## Next

- Swap `Chromium.layer()` for a [Browserbase](/docs/browserbase) session; nothing else changes.
- Give the run an audience with [moments and narration](/docs/moments-and-narration) and [watched browsing](/docs/watched-browsing).
