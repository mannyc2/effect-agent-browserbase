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

`Agent.run` batches each turn's tool calls in order, halting on the first failure or a completed
`done` / `give_up`. Skipped calls receive a not-executed result. A malformed `done` answer can
be corrected on the next turn.

The model gets one outline and screenshot at the start and after each turn. `observation` selects
`"outline"`, `"screenshot"`, or `"both"` (the default). `Page.observe` returns that observation as
a schema value. `Tools.make` returns receipts; a caller writing its own loop observes the current
`tools.page` after the batch and drains `tools.takeZooms` into that same observation message.

`browser_zoom` captures a region in viewport CSS pixels when the tool runs. Requested crops arrive
with the next observation even in outline mode, labeled with their source page and viewport origin.
At most eight crops may await an observation. `Page.zoom` exposes the same capture as a `Zoom`
schema value with `region` and `image`; crop pixel coordinates need the region's origin added before
using them as click coordinates.

`Page.click` returns a `ResolvedTarget` captured before input: the requested point, element label,
role, accessible name, cursor and link target. Pixel targeting resolves through the page script and
keeps the original point; the receipt names the control even when a nested child received the hit.

Add a caller's toolkit with `additionalTools` and provide its handler layer to the run. It is
merged last, so the caller's tool wins a name clash, and its calls share the batch's halt behavior.

Every module is also an entry point, such as `effect-browser/Agent`. The
[repository README](https://github.com/mannyc2/effect-agent-browserbase#readme) has examples.
