# Agent tools

`effect-agent-browser` gives a [Yielded Agent](https://github.com/yielded-dev/agent) a browser. Yielded runs the agent: its loop, policy, budgets, approval, context and run events. This package implements Yielded's browser ports over effect-browser pages and adds the tools an agent drives them by.

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

## How they behave

- Before each turn the model sees a screenshot of the current tab, and any crops `zoom` took, as context the run never keeps: only the current picture is ever in a request, so the prompt cache keeps the history.
- A ref from an old observation fails as stale rather than naming another element.
- Every result says whether input reached the browser, and nothing is ever retried.
- `Browser.Options.guard` checks input and navigation against facts the page's structure establishes: form submissions, other-origin destinations, downloads, uploads and secret fields. `Policy.make` builds a guard for unattended runs, whose judge reads what an input means against the run's task.
- `layer({ page })` pins the tools to one page; `layer({ browser, follow })` follows the tab the model last saw, and decides how a new tab is shown so the page on air stays put.

## Tools on a watched page

Hand the tools a presenter's view of the page and the agent's input is performed: glides, presses and typing at a person's pace, recorded for the player. That's how the demo's agent works.
