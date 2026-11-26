# Agent tools

`effect-browser/ai` gives an agent a browser: the tools it calls, what it sees of the page before each turn, and the controller the tools act through. They run in any `effect/ai` loop. `@effect-browser/yielded` gives the same tools to a [Yielded Agent](https://github.com/yielded-dev/agent) run, where Yielded runs the agent: its loop, policy, budgets, approval, context and run events.

## The tools

| Tool         | What it does                                                              |
| ------------ | ------------------------------------------------------------------------- |
| `observe`    | Reads the viewport as an outline whose controls carry refs such as `e12`  |
| `act`        | Clicks, fills or selects up to eight refs in order, then observes         |
| `inspect`    | Reads inside a CSS selector, or narrows a select's options                |
| `navigate`   | Opens an http or https address, then observes                             |
| `scroll`     | Scrolls the page, or what a ref names, then observes                      |
| `wait`       | Waits for what a selector matches to show, hide, enable or hold some text |
| `press`      | Presses a key on the element a ref names                                  |
| `select_tab` | Makes another tab current                                                 |

and pointer tools for what has no ref, such as a canvas game or a chart: `click_at`, `hover`, `drag`, `type_text`, `press_keys`, `zoom`, `wait_still` and `back`. `BrowserTools.Control` and `BrowserTools.Pointer` are the two groups, for an agent that wants fewer.

## In any loop or a Yielded run

`BrowserTools.make()` gives the toolkit, and its `layer({ page }, { task })` serves every tool on a page, with the task the input policy's judge reads. The layer also provides `BrowserTools.Pictures`, whose `next` is what the model sees of the page before its coming turn: a loop adds it to that request alone, never to the thread. The [core's README](https://github.com/mannyc2/effect-agent-browserbase/tree/main/packages/browser#an-agents-tools) has such a loop over `LanguageModel.generateText`.

In a Yielded run, `YieldedTools.make()` from `@effect-browser/yielded` gives the same toolkit, and its layer makes the pictures the run's transient context, or with `vision: "moments"` puts a moment of the tab in the agent's thread after each turn. Its [README](https://github.com/mannyc2/effect-agent-browserbase/tree/main/packages/yielded#readme) has the agent.

## How they behave

- Before each turn the model sees a screenshot of the current tab, and any crops `zoom` took, for that request alone: only the current picture is ever in a request, so the prompt cache keeps the history.
- A ref from an old observation fails as stale rather than naming another element.
- Every result says whether input reached the browser, and nothing is ever retried. A failed tool answers the model with a `ToolError` rather than ending the loop.
- `Browser.Options.guard` checks input and navigation against facts the page's structure establishes: form submissions, other-origin destinations, downloads, uploads and secret fields. `Policy.make` builds a guard for unattended runs, whose judge reads what an input means against the agent's task.
- `layer({ page })` pins the tools to one page; `layer({ browser, follow })` follows the tab the model last saw, and decides how a new tab is shown so the page on air stays put.

## Tools on a watched page

Hand the tools a presenter's view of the page and the agent's input is performed: glides, presses and typing at a person's pace, recorded for the player. That's how the demo's agent works.
