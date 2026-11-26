# @effect-browser/yielded

[`effect-browser/ai`](../browser#an-agents-tools)'s browser tools for a
[Yielded Agent](https://github.com/yielded-dev/agent) run. Yielded runs the agent: its loop,
policy, budgets, approval, context and run events. This package gives that run the tools, and
shows its model the page, or its moments, as the run's context.

```sh
npm install @effect-browser/yielded@beta effect-browser@beta @yielded/agent@0.1.0-beta.191 effect@4.1.2 playwright-core@1.63.0
```

The package peers on the published npm release of `@yielded/agent` `0.1.0-beta.191` exactly and
on Effect `~4.1.2`. Remove any `@yielded/agent` archive override from an earlier release before
installing, then refresh your lockfile so it records the registry artifact. The previous archive
was an upstream release candidate with the same version, not the npm artifact.

| Module         | What it holds                                                                   |
| -------------- | ------------------------------------------------------------------------------- |
| `YieldedTools` | The browser tools, a layer that also prepares a run's context, and a run's seed |
| `Moments`      | Where moments sit in a run's thread, as data to save and resume                 |

## An agent on a page

```ts
import { YieldedTools } from "@effect-browser/yielded";
import { Agent, AgentRuntime, InMemory } from "@yielded/agent";
import { Effect, Layer, Schema } from "effect";
import { Browser } from "effect-browser";

const tools = YieldedTools.make();

const buyer = Agent.make("buyer", {
  input: Schema.String,
  output: Schema.Struct({ orderId: Schema.String }),
  instructions: "Do the task with the browser tools, then answer.",
  toolkit: tools.toolkit,
  // One call at a time: a turn's calls act on one page, in the order the model made them.
  policy: { maxTurns: 20, maxToolCalls: 60, maxDuration: "5 minutes", toolConcurrency: 1 },
});

const buy = (task: string) =>
  Effect.gen(function* () {
    const page = yield* (yield* Browser.Browser).firstPage;

    return yield* AgentRuntime.run(buyer, task).pipe(
      Effect.provide(Layer.merge(tools.layer({ page }, { task }), InMemory.layer)),
    );
  });
```

Provide a `Browser`, such as `@effect-browser/chromium`'s `Chromium.layer()` or a Browserbase session, and a model with its
`Model.ProviderName` and `Model.ModelName`, as the repository's
[README](https://github.com/mannyc2/effect-agent-browserbase#readme) does.

`YieldedTools.make()` gives the same toolkits as `BrowserTools.make()`, and its `layer` takes the
same targets and options. The core's [README](../browser#an-agents-tools) says what each tool does,
how the tools follow tabs and how `PromptCache` keeps OpenRouter's prompt cache.

- With `vision` `true`, the default, `"ask"` or `"page"`, the pictures `BrowserTools.Pictures` gives
  before each turn are the run's transient context, which the run never keeps. `vision: false`
  leaves the run's context preparation as it is.
- A failed tool answers the model with `effect-browser/ai`'s `ToolError`, as in any loop. Yielded
  reads its `_tag` and `message` as it reads any tool failure.

## Moments and long runs

`tools.layer(target, { vision: "moments" })` puts a stable account of the page after each turn's
tool results: what happened and what changed since the preceding moment. The latest three moments'
pictures follow the thread as reference messages, labeled by turn, with each frame's time and
each crop's viewport origin. Retiring those pictures releases their bytes without rewriting
earlier accounts. Without a screencast, each moment has one screenshot; with one, up to three
frames. `onMoment` receives each captured moment once, for a consumer that records it.
If the current page is lost or its moment has no usable picture, preparation fails with
`AgentInputError` before another model call. A partial change record remains explicit in the moment.

Yielded's native pruning and summarization can compact the accounts with the surrounding tool
exchanges. The recent pictures remain available across compaction and never enter the summarizer.
The accounts belong to the prepared model context for this run; they are not durable history.
Keep a recording with `onMoment` if they must outlive the run.

For a bounded model context, the consumer supplies the selected model's `ResolvedModelCall`,
including `estimateMessageTokens`. Yielded's default estimate reserves each picture's tokens from
its dimensions, 1.5 per 32-pixel patch and at least 1,024, without counting its encoding as text:
a generic reservation, not any provider's price. Image costs differ by model, resolution and
detail; where they matter, add the selected provider's image-token reservation to the text
estimate from `@yielded/agent/compaction`. Neither the tools nor the bench infer a universal
image-token budget.

Compose the model selection with the installed preparation instead of replacing its accounts.
Inside the effect provided by `tools.layer`, with `resolvedModel` supplied by the consumer:

```ts
import { RunContextPreparation } from "@yielded/agent/run-options";
import { Effect, Option } from "effect";

const run = Effect.gen(function* () {
  const preparation = Option.getOrUndefined(yield* Effect.serviceOption(RunContextPreparation));

  return yield* AgentRuntime.run(buyer, task, {
    context: {
      prepare: (request) =>
        Effect.map(
          preparation?.hook?.prepare(request) ?? Effect.succeed({ prompt: request.source }),
          (prepared) => ({ ...prepared, modelCall: resolvedModel }),
        ),
    },
  });
});
```

The run's own `context` replaces the account hook; its `transientContext` replaces the pictures.
Leave `transientContext` unset to keep the tools' recent images. Set the agent's compaction policy
and the resolved model's context capacity and output reserve to match the selected provider.

## Continuing a finished run

`YieldedTools.Seed` is a finished run's thread with the tools' state: the tabs they followed, the
moments placed in the thread and the window the next one starts from, the crops and the
observations. It holds no run in flight; that stays Yielded's. `YieldedTools.load` decodes one from
JSON; the layer's `initialTabs`, `initialZooms` and `initialMoments` continue from its `tabs`,
`zooms` and `moments`.
