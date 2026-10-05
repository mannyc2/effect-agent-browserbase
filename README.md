# effect-browser

Browser automation for [Effect](https://effect.website) agents: page control, a compact page
outline for models, screencast frames, browser tools for `effect/ai`, an agent loop, and moments, a
picture-and-timeline account of what a page showed at one point in time.

| Package                                                  | What it is                                                         |
| -------------------------------------------------------- | ------------------------------------------------------------------ |
| [`effect-browser`](packages/browser)                     | The browser, its pages, tools, agent and moments, over Playwright  |
| [`effect-browserbase`](packages/browserbase)             | Browserbase sessions as a `Browser`, and a client for its REST API |
| [`effect-browser-human-strokes`](packages/human-strokes) | Optional recorded pointer motion, supplied as one layer            |
| [`bench`](bench) (private)                               | Graded tasks over canvas games, live charts, quotes and forms      |

## An agent in a local Chromium

Any `effect/ai` `LanguageModel` drives the agent. This one goes through OpenRouter:

```ts
import { OpenRouterClient, OpenRouterLanguageModel } from "@effect/ai-openrouter";
import { Config, Effect, Layer, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { Agent, Browser, Chromium } from "effect-browser";

const program = Effect.gen(function* () {
  const page = yield* (yield* Browser.Browser).page;

  yield* page.goto("https://news.ycombinator.com");

  const result = yield* Agent.run("Report the title and points of the top story.", {
    answer: Schema.Struct({ title: Schema.String, points: Schema.Finite }),
  });

  yield* Effect.log(result.answer, result.usage);
});

const Model = OpenRouterLanguageModel.layer({ model: "<model id>" }).pipe(
  Layer.provide(OpenRouterClient.layerConfig({ apiKey: Config.Redacted("OPENROUTER_API_KEY") })),
  Layer.provide(FetchHttpClient.layer),
);

program.pipe(Effect.provide([Chromium.layer(), Model]), Effect.runPromise);
```

## The same agent on Browserbase

Swap the `Browser` layer. The session is created when the layer is built and released when it is
released, so billing stops then rather than at the session's timeout:

```ts
import { Browserbase, BrowserbaseClient } from "effect-browserbase";

const Hosted = Browserbase.layer({ session: { region: "us-west-2" } }).pipe(
  Layer.provide(BrowserbaseClient.layerConfig()), // reads BROWSERBASE_API_KEY
  Layer.provide(FetchHttpClient.layer),
);

program.pipe(Effect.provide([Hosted, Model]), Effect.runPromise);
```

## A moment

`Moment.capture` gathers screencast frames from the last few seconds, a snapshot of the page and
the browser's events over the same window. `Moment.describe` gives all of it to a vision model in
one call, and returns a `Description` or any schema you pass:

```ts
const VideoPrompt = Schema.Struct({
  scene: Schema.String,
  motion: Schema.String,
  prompt: Schema.String,
});

const watch = Effect.gen(function* () {
  const page = yield* (yield* Browser.Browser).page;

  yield* page.screencast().pipe(Stream.runDrain, Effect.forkScoped);
  yield* page.goto("https://example.com/live-chart");
  yield* Effect.sleep("5 seconds");

  const moment = yield* Moment.capture(page, { frames: 3 });
  const { value } = yield* Moment.describe(moment, {
    schema: VideoPrompt,
    instructions: "Write a prompt for a five-second video of this moment.",
  });

  return value.prompt;
}).pipe(Effect.scoped);
```

## How the tools work

`Tools.make` builds an `effect/ai` toolkit over the current tab: `browser_navigate`, `browser_back`,
`browser_snapshot`, `browser_zoom`, `browser_click`, `browser_hover`, `browser_type`,
`browser_press`, `browser_scroll`, `browser_drag`, `browser_select`, `browser_wait` and
`browser_tabs`. `Agent.run` adds `done` and `give_up`.

- A snapshot is a compact outline of the viewport. Controls carry refs such as `e12`; a ref from an
  old snapshot fails as stale rather than naming another element.
- Anything a snapshot cannot show, such as a canvas game, a chart or a video, takes x and y in
  viewport CSS pixels, as they appear in a full screenshot. Pixel click receipts name the element
  under that exact point, with its role and accessible name when available.
- Actions return short receipts. `Agent.run` executes each turn's calls in order, stops at the first
  failure or completion, and answers the remaining calls as not executed. A loop of your own gets
  the same by spreading a fresh `yield* tools.batch` into each `generateText` call. When a tab
  opens, the tools follow it: in the receipt when it registers in time, otherwise when they next
  look. Until the new tab has been observed, later actions do nothing and say so: the model
  planned them on the old tab.
- The model receives one outline and screenshot at the start and after each turn, including failed
  batches. If the browser is gone, the run fails with its `BrowserError` rather than calling the
  model again. Set `observation` to `"outline"` or `"screenshot"` when only one is needed; the default
  is `"both"`. A malformed `done` answer goes back to the model to correct, and so does a response
  that calls a tool that does not exist: none of its calls run.
- `browser_zoom` takes a viewport region (`x`, `y`, `width`, `height`) and returns its crop beside
  the next observation, including in outline mode. Captions give the source page and viewport
  origin; clicks still use viewport coordinates. A batch can request at most eight crops.
- Pictures go to the model in a user message after the tool results. Only the latest few stay in
  the conversation, and older ones are replaced several at a time, so the prompt cache keeps working.
- `Browser.Options.guard` checks input and navigation, including hover, scroll and a new tab's URL.
  It receives inferred classifications for form submissions, purchases, deletion, confirmation,
  external-origin destinations, downloads and uploads. Its effect succeeds to allow, fails with
  `PolicyDenied` to deny, or waits for an external signal to hold. Holds have a separate
  `policyTimeout` (five minutes by default) and leave the page unlocked. Changed targets fail before
  input when a hold resumes. With no guard, every action is allowed.
- `humanize` uses a tuned two-stroke sigma-lognormal pointer planner and scrolls off-screen targets into view with visible
  wheel input, using bounded attempts and an instant fallback. It rechecks the approved target
  before activation. Typing aims for about 75 WPM, with overlapping key holds and slower word
  starts; bounded pending replies keep connection latency out of the intended schedule.
  The optional `effect-browser-human-strokes` layer supplies 32,130 recorded strokes, preserving
  their original samples and timing; the core package contains no data. `Motion.Motion` is captured
  when the browser is built, and each full glide is validated and admitted before its clock starts.
- `Page.type(text, { prose: true })` and the `browser_type` tool's `prose` flag allow occasional
  corrected slips when replacing an explicitly targeted prose field while humanized. Final text
  is checked before submit; numbers, URLs, credentials and payment/order fields stay exact.
  Presentation pauses supplement the functional navigation wait.
  Printable US text uses key events; other text uses Unicode insertion.
- Events, frame arrivals and moments share the owning browser’s host monotonic clock in milliseconds.
  `Browser.now` reads that clock. These stamps measure elapsed time, not calendar dates.
  Native frames map browser paint to `hostTime` with explicit uncertainty; screenshot timing has
  separate provenance. New owned sessions expose startup capture calibration for the consumer's
  compositor, and `Page.captureStats` reports frame gaps, filtering and observed subscriber loss.
- `Browser.events()` carries the timed input track for the consumer’s cursor rendering: complete
  glide plans, submission receipts, button and key phases, wheel input and cursor shape. Pointer
  position is shared across tabs. Events have sequence cursors for bounded replay; a lagging reader
  gets an explicit history-expired error instead of missing events silently.
- `additionalTools` accepts an `effect/ai` toolkit, merged after the browser and completion tools.
  Supply its handlers through their usual layer; on a name clash the added toolkit wins. The same
  batch halting applies to those tools.
- `onStep` sees each model call and its tool calls; failing stops the run with that error, which is
  how a caller enforces a budget.

## Development

The [bench](bench) has seeded operate and understand tasks, including a dense quote table and
multi-frame changes. Trials have separate browsers, bounded concurrency, per-trial metrics and one
shared model budget. A paired quote comparison reuses one capture across the shipping description,
the historical on-air representation and visible-DOM facts. Scripted runs remain free; model and
hosted runs require explicit opt-in.

See [CONTRIBUTING.md](CONTRIBUTING.md). `bun run ready` formats, lints, typechecks, tests against a
real local Chromium and builds. No test calls a model or a hosted browser.
[docs/STATUS.md](docs/STATUS.md) is the current state.

## License

The core packages and code are MIT. The optional `effect-browser-human-strokes` data is CC BY 4.0;
its [README](packages/human-strokes/README.md) carries attribution. Parts of the build configuration are adapted from
[effect-agent](https://github.com/danieljvdm/effect-agent) under the MIT License; see
[LICENSE-effect-agent](LICENSE-effect-agent).
