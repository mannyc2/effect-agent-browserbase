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

Here the output starts on one page, prepares another off air, and switches once it has painted:

:::Example
```ts
import { Effect, Stream } from "effect";
import { Browser, Chromium, Stage } from "effect-browser";

const program = Effect.gen(function* () {
  const browser = yield* Browser.Browser;
  const stage = yield* Stage.make();

  const home = yield* browser.firstPage;
  yield* home.goto("https://example.com");
  yield* stage.present(home);

  // Prepare the next page off air, then switch when it has painted.
  const next = yield* browser.newPage("https://news.ycombinator.com");
  const cue = yield* stage.cue(next);
  yield* cue.ready;
  const presented = yield* cue.commit();

  yield* Effect.log(`on air, ${presented.latency.toFixed(0)} ms after the time asked for`);

  // What the output shows from then on: paint, or what a second without paint establishes.
  yield* stage.shown({ hold: "1 second" }).pipe(
    Stream.take(3),
    Stream.runForEach((shown) => Effect.log(shown._tag)),
  );
}).pipe(Effect.scoped);

program.pipe(Effect.provide(Chromium.layer()), Effect.runPromise);
```

Run with `node stage.ts` on 11 October 2026. The switch landed a millisecond after the time asked for, and once Hacker News stopped painting, a second without paint was confirmed as still:

```text output
[20:26:10.695] INFO (#1): on air, 1 ms after the time asked for
[20:26:10.710] INFO (#1): Painted
[20:26:10.758] INFO (#1): Painted
[20:26:12.698] INFO (#1): Still
```
:::

## Owned work

The [composition examples](https://github.com/mannyc2/effect-agent-browserbase/blob/main/docs/COMPOSITION.md) put these together: prepared pages held across browser generations, reveals in order, step-by-step plans that stop at clean cuts, and an operator-assisted workflow that refuses unresolved consequential input. The library owns browser lifetimes, input admission and capture; the consumer owns its editorial choices and durable records.
