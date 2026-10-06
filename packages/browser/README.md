# effect-browser

Browser automation for [Effect](https://effect.website) agents, over Playwright: page control, a
compact page outline for models, screencast frames, `effect/ai` browser tools, an agent loop, and
moments, a picture-and-timeline account of what a page showed at one point in time.

```sh
npm install effect-browser effect playwright-core
npx playwright-core install chromium
```

| Module         | What it holds                                                                        |
| -------------- | ------------------------------------------------------------------------------------ |
| `Browser`      | The `Browser` service: tabs, recent events and the Playwright context                |
| `Chromium`     | A local Chromium as a `Browser` layer                                                |
| `Cdp`          | Any DevTools endpoint as a `Browser` layer                                           |
| `Page`         | One tab: navigation, snapshots, screenshots, input, waits and the screencast         |
| `Snapshot`     | The model-readable outline of a page, with refs for its controls                     |
| `Frame`        | A screencast frame                                                                   |
| `BrowserEvent` | Actions, navigations, tabs, dialogs and pointer motion, as they happen               |
| `BrowserError` | Typed failures, saying whether input reached the page before the failure             |
| `Tools`        | The `effect/ai` browser toolkit                                                      |
| `Agent`        | A model with the tools, in a loop, until it reports an answer of the shape you asked |
| `Moment`       | Capture what a page showed around a point in time, and describe it in one model call |

Every module is also an entry point, such as `effect-browser/Agent`. The
[repository README](https://github.com/mannyc2/effect-agent-browserbase#readme) has examples.
