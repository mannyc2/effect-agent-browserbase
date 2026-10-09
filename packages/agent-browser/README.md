# effect-agent-browser

[`effect-browser`](../browser) pages as [Yielded Agent](https://github.com/yielded-dev/agent)'s
browser ports, with the tools an agent drives them by. Yielded runs the agent: its loop, policy,
budgets, approval, context and run events. This package gives that agent a browser.

```sh
npm install effect-agent-browser@beta effect-browser@beta @yielded/agent@beta effect playwright-core
```

| Module         | What it holds                                                                  |
| -------------- | ------------------------------------------------------------------------------ |
| `BrowserTools` | An agent's browser tools, and the layer that serves them on a page or its tabs |
| `PageControl`  | Yielded's `BrowserActions` and `BrowserControl` ports over a page or a browser |

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

## The tools

`BrowserTools.make()` gives Yielded's own tools over `PageControl`'s ports:

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
  leaves the pictures out, and `zoom` then refuses.
- An observation after an action begins with what followed it: a dialog and how the browser
  answered it, where the page went, a tab it opened and up to three changes its input caused,
  such as `"Full" became "Kept"`. A pointer tool's result says the same in `followed`.
- Every action result says whether input reached the browser: `acknowledged`; `not-dispatched`,
  when it was refused first, by a stale ref or the input policy; or `unknown`, when it failed after.
  An observation after an action that fails is still returned, and nothing is ever retried.
- The input policy's judge reads `task`, the run's task, as what authorizes a risky input.
- The browser answers dialogs itself, as `effect-browser` does, so `respond_dialog` is left out and
  the port refuses it. Yielded's `screenshot` tool is left out too; the port answers with a PNG for
  a host that asks.
- Frames from the same origin are read inline, and none is listed, so the ports refuse a `frame`.

## A page or a browser's tabs

`layer({ page })` pins the tools to one page: they list no tabs, and a tab the page opens stays where
it is. `layer({ browser, follow })` acts on the tab the model last saw and lists the others; a tab an
action opens is shown at the next look as `follow` says: `"select"`, the default, makes it current
without bringing it to front, so the page on air and an operator's view stay where they are;
`"front"` also brings it to front; `"never"` keeps the current tab.

## The ports alone

`PageControl.layer(target, options)` provides `BrowserActions` and `BrowserControl` alone, for
Yielded's own `BrowserUse.make()` tools or Code Mode.
