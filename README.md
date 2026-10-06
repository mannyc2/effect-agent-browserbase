# effect-browser

Browser automation for [Effect](https://effect.website) agents: page control, a compact page
outline for models, screencast frames, browser tools for `effect/ai`, an agent loop, and moments, a
picture-and-timeline account of what a page showed at one point in time.

| Package                                         | What it is                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| [`effect-browser`](packages/browser)            | The browser, its pages, tools, agent and moments, over Playwright  |
| [`effect-browserbase`](packages/browserbase)    | Browserbase sessions as a `Browser`, and a client for its REST API |
| [`bench`](bench) (private)                      | Graded tasks over canvas games, live charts and forms              |

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
const VideoPrompt = Schema.Struct({ scene: Schema.String, motion: Schema.String, prompt: Schema.String });

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
`browser_snapshot`, `browser_screenshot`, `browser_click`, `browser_hover`, `browser_type`,
`browser_press`, `browser_scroll`, `browser_drag`, `browser_select`, `browser_wait` and
`browser_tabs`. `Agent.run` adds `done` and `give_up`.

- A snapshot is a compact outline of the viewport. Controls carry refs such as `e12`; a ref from an
  old snapshot fails as stale rather than naming another element.
- Anything a snapshot cannot show, such as a canvas game, a chart or a video, takes x and y in
  viewport pixels, as they appear in a screenshot.
- Every action answers with what it did and a fresh snapshot, so most steps need no extra look.
  When a click opens a tab, the tools follow it.
- Pictures go to the model in a user message after the tool results. Only the latest few stay in
  the conversation, and older ones are replaced several at a time, so the prompt cache keeps working.
- `Browser.Options.guard` sees every input before it reaches the page and can refuse it, for
  example to keep an agent from placing a bet. `humanize` moves the pointer along curves and types
  at a human pace for watched sessions.
- `onStep` sees each model call and its tool calls; failing stops the run with that error, which is
  how a caller enforces a budget.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md). `bun run ready` formats, lints, typechecks, tests against a
real local Chromium and builds. No test calls a model or a hosted browser.
[docs/STATUS.md](docs/STATUS.md) is the current state.

## License

MIT. Parts of the build configuration are adapted from
[effect-agent](https://github.com/danieljvdm/effect-agent) under the MIT License; see
[LICENSE-effect-agent](LICENSE-effect-agent).
