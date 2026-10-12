# effect-browser

effect-browser is browser automation for [Effect](https://effect.website) agents, built for runs people watch. It owns the browser: pages, a compact outline a model can act on, screencast frames, a record of what visibly changed, and **moments**, an account in pictures and words of what a page showed over a window of time. Agents run on [Yielded Agent](https://github.com/yielded-dev/agent), and Browserbase sessions plug in as the same `Browser`.

## What's in the box

| Package                        | What it is                                                          |
| ------------------------------ | ------------------------------------------------------------------- |
| `effect-browser`               | The browser, its pages, frames, events and moments, over Playwright |
| `effect-agent-browser`         | Its pages as Yielded Agent's browser ports, with the agent's tools  |
| `effect-browserbase`           | Browserbase sessions as a `Browser`, and a client for its REST API  |
| `effect-browser-human-strokes` | Optional recorded pointer motion, as a presenter's planner          |

## The demo

An agent explores [Polymarket](https://polymarket.com) on its own while a second model watches the screen and narrates it aloud. Every line you hear was written live from a moment of the page and spoken by a voice model. The markets the agent reports are then checked against Polymarket's public API. The pointer, clicks and keys drawn over the video are the exact input that was sent.

::Replay{id="polymarket"}

## Where to go next

- [Get started](/docs/get-started): install the packages and run an agent in a local Chromium.
- [Run the demo yourself](/docs/run-the-demo): record your own narrated take, on your machine.
- [Moments and narration](/docs/moments-and-narration): how the narrator sees the page.
- [Watched browsing](/docs/watched-browsing): input performed at a person's pace, and clean cuts between pages.
- [For AI agents](/docs/for-agents): every page here is also plain markdown.
