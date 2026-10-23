# effect-agent-browser

[`effect-browser`](../browser) pages as the browser tools of a
[Yielded Agent](https://github.com/yielded-dev/agent) agent. Yielded runs the agent: its loop,
policy, budgets, approval, context and run events. This package gives that agent a browser.

```sh
npm install effect-agent-browser@beta effect-browser@beta @yielded/agent@0.1.0-beta.189 effect@4.0.3 playwright-core@1.63.0
```

The package peers on the published npm release of `@yielded/agent` `0.1.0-beta.189` exactly and
on Effect `~4.0.3`. Remove any `@yielded/agent` archive override from an earlier release before
installing, then refresh your lockfile so it records the registry artifact. The previous archive
was an upstream release candidate with the same version, not the npm artifact.

| Module         | What it holds                                                                   |
| -------------- | ------------------------------------------------------------------------------- |
| `BrowserTools` | An agent's browser tools, and the layer that serves them on a page or its tabs  |
| `PageControl`  | The controller the tools act through, and its observations and results' schemas |
| `PromptCache`  | An HTTP client layer that keeps OpenRouter's prompt cache across pictured turns |

## An agent on a page

```ts
import { Agent, AgentRuntime, InMemory } from "@yielded/agent";
import { Effect, Layer, Schema } from "effect";
import { BrowserTools } from "effect-agent-browser";
import { Browser } from "effect-browser";

const tools = BrowserTools.make();

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

Provide a `Browser`, such as `Chromium.layer()` or a Browserbase session, and a model with its
`Model.ProviderName` and `Model.ModelName`, as the repository's
[README](https://github.com/mannyc2/effect-agent-browserbase#readme) does.

A turn's picture is dropped on the next call, so a provider that caches up to a breakpoint at the
end of the prompt, as OpenAI's models do on OpenRouter, caches nothing a later call can use.
`PromptCache.layer` marks the end of each chat completion's history instead: its last tool result
or, before there is one, its system message. Provide it to the OpenRouter client:

```ts
import { OpenRouterClient } from "@effect/ai-openrouter";
import { Config, Layer } from "effect";
import { PromptCache } from "effect-agent-browser";
import { FetchHttpClient } from "effect/http";

const openRouter = OpenRouterClient.layerConfig({
  apiKey: Config.Redacted("OPENROUTER_API_KEY"),
}).pipe(Layer.provide(PromptCache.layer), Layer.provide(FetchHttpClient.layer));
```

## The tools

`BrowserTools.make()` gives the ref and control tools, with the names, parameters and descriptions
Yielded Agent gave them until `0.1.0-beta.174` moved its browser tools to Code Mode over CDP:

| Tool         | What it does                                                                             |
| ------------ | ---------------------------------------------------------------------------------------- |
| `observe`    | Reads the viewport as an outline whose controls carry refs such as `e12`, and lists them |
| `act`        | Clicks, fills or selects up to eight refs in order, then observes                        |
| `inspect`    | Reads inside a CSS selector, or narrows a select's options                               |
| `navigate`   | Opens an http or https address, a `data:` URL or `about:blank`, then observes            |
| `scroll`     | Scrolls the page, or what a ref names, by pixels, then observes                          |
| `wait`       | Waits for what a selector matches to show, hide, enable or hold some text                |
| `press`      | Presses a key on the element a ref names, focusing it first                              |
| `select_tab` | Makes another tab current, where the tools follow a browser's tabs                       |

and this package's pointer tools, for what has no ref, such as a canvas game or a chart:

| Tool         | What it does                                                         |
| ------------ | -------------------------------------------------------------------- |
| `click_at`   | Clicks a point of the screenshot                                     |
| `hover`      | Moves the pointer over a ref or a point                              |
| `drag`       | Drags from a ref or point to another, as a slider or a chart's range |
| `type_text`  | Types into whatever has focus                                        |
| `press_keys` | Presses a key or chord, held or repeated, on whatever has focus      |
| `zoom`       | Crops a region of the viewport, shown before the next turn           |
| `wait_still` | Waits for the screen to stop moving, as reels coming to rest         |
| `back`       | Goes back in the tab                                                 |

`BrowserTools.Control` and `BrowserTools.Pointer` are the two groups, to build an agent with fewer;
the layer serves every tool either way. `make({ mode: "single" })` lets `act` take one action.

- Before each turn the model sees a screenshot of the current tab, and the crops `zoom` took since
  its last turn, as context the run never keeps, so only the current picture is ever in a request.
  Its pixel coordinates are viewport coordinates, which the pointer tools take. `vision: false`
  leaves the pictures out, and `zoom` then refuses. A queued crop is discarded if another tab
  becomes current before the next turn, so its coordinates never describe that other tab.
- `vision: "ask"` shows the screenshot only before a turn after the model called `look`, a tool in
  `BrowserTools.Look` to merge into the agent's toolkit; crops still follow `zoom`. `vision: "page"`
  also shows it after pointer input, and while the viewport shows a canvas, a video or another
  site's frame, where the outline cannot say what is there.
- `BrowserTools.Find` holds `find`, which lists the whole page's outline lines that hold a text,
  in view or not, with their refs. Merge it into the agent's toolkit; the layer serves it either way.
- `boxes: true` ends each control's line in the outline with its box, `WxH at (x,y)` in viewport
  CSS pixels, so the model can match a ref to what the screenshot shows there. `changes: true`
  gives, after an action, only the outline's lines gone and new since the tab's last whole look,
  when those are fewer; `observe` reads the whole outline again.
- `placement: "crop"` makes `click_at` and `drag` first show a crop of the viewport around each
  point and act only once called at points inside crops already shown, which costs a turn per
  placement. A ref needs no crop.
- An observation after an action begins with what followed it: a dialog and how the browser
  answered it, where the page went, a tab it opened and up to three changes its input caused,
  such as `"Full" became "Kept"`. A pointer tool's result says the same in `followed`.
- Every action result says whether input reached the browser: `acknowledged`; `not-dispatched`,
  when it was refused first, by a stale ref or the input policy; or `possibly-dispatched`, when it failed after.
  An observation after an action that fails is still returned, and nothing is ever retried.
- The input policy's judge reads `task`, the run's task, as what authorizes a risky input.
- The browser answers dialogs itself, as `effect-browser` does, so no tool answers one. The model
  sees a screenshot before each turn rather than calling for one.
- Frames from the same origin are read inline, and none is listed, so `inspect` and `wait` refuse
  a `frame`.

## Moments and long runs

`layer(target, { vision: "moments" })` puts a stable account of the page after each turn's tool
results: what happened and what changed since the preceding moment. The latest three moments'
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

## A page or a browser's tabs

`layer({ page })` pins the tools to one page: they list no tabs, and a tab the page opens stays where
it is. `layer({ browser, follow })` acts on the tab the model last saw and lists the others; a tab an
action opens is shown at the next look as `follow` says: `"select"`, the default, makes it current
without bringing it to front, so the page on air and an operator's view stay where they are;
`"front"` also brings it to front; `"never"` keeps the current tab.

## The controller alone

`PageControl.make(target, options)` gives the controller the tools act through, for a host that
drives a page without a model: `actions.observe` and `actions.act`, and `control.inspect`,
`navigate`, `scroll`, `wait`, `press` and `selectTab`. Their results are `PageControl.Observation`
and `PageControl.ActionResult`.
