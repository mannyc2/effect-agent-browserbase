# Watched browsing

Most automation is built to be fast and invisible. effect-browser is built for runs an audience watches: input arrives the way a person's would, the output switches between pages on real events, and what the screen shows is never claimed beyond what was painted.

## Performed input

`Presentation` performs input for viewers. A presenter owns one drawn pointer, and `presenter.view(page)` is the page with its actions performed:

- each action waits first as a person reacts: 280 ms after an expected change, 600 ms after a new document, a second on another page;
- the pointer glides from where viewers last saw it, along a tuned two-stroke sigma-lognormal planner's paths;
- off-screen targets scroll into view with visible wheel input, in 100 px notches;
- typing runs near 70 WPM, with overlapping key holds and slower word starts.

The page itself stays plain, and plain input never waits for a view. `view.aim(target)` starts a glide as soon as a target is known, as when it appears in a model's streamed tool call. The optional `effect-browser-human-strokes` package swaps in 32,130 recorded strokes as the planner.

`Browser.events()` carries the timed input track for your own cursor rendering: complete glide plans, submission receipts, button and key phases, wheel input and cursor shape. The demo's player draws its pointer from exactly that track.

## A stage

`Stage` is the source of a live output. `stage.cue(page)` starts capture; `cue.ready` waits for a current frame; `cue.commit({ at })` switches on the host time of something that actually happened, such as a line going out. `stage.shown()` describes the output without inventing frames: `Painted`, `Still` (confirmed after a fresh round trip), `Stalled` (silence that could not be confirmed) or `Gone`.

```ts
const cue = yield * stage.cue(page);
yield * cue.ready;
const sent = yield * lineSent; // Some(hostTime) when the line goes out
if (Option.isSome(sent)) yield * cue.commit({ at: sent.value });
```

## Owned work

The [composition examples](https://github.com/mannyc2/effect-agent-browserbase/blob/main/docs/COMPOSITION.md) put these together: prepared pages held across browser generations, reveals in order, step-by-step plans that stop at clean cuts, and an operator-assisted workflow that refuses unresolved consequential input. The library owns browser lifetimes, input admission and capture; the consumer owns its editorial choices and durable records.
