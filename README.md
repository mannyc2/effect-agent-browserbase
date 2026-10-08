# effect-browser

Browser automation for [Effect](https://effect.website) agents: page control, a compact page
outline for models, screencast frames, a record of what visibly changed on a page, and moments:
what a page showed, and what changed on it, over a window of time, ready for a model. Agents run on
[Yielded Agent](https://github.com/yielded-dev/agent), whose browser ports `effect-browser-agent`
implements over these pages.

| Package                                                  | What it is                                                         |
| -------------------------------------------------------- | ------------------------------------------------------------------ |
| [`effect-browser`](packages/browser)                     | The browser, its pages and moments, over Playwright                |
| [`effect-browser-agent`](packages/agent)                 | Its pages as Yielded Agent's browser ports, with the agent's tools |
| [`effect-browserbase`](packages/browserbase)             | Browserbase sessions as a `Browser`, and a client for its REST API |
| [`effect-browser-human-strokes`](packages/human-strokes) | Optional recorded pointer motion, as a presenter's planner         |
| [`bench`](bench) (private)                               | Graded tasks over canvas games, live charts, quotes and forms      |
| [`demos`](demos) (private)                               | A site that replays recorded bench runs, graded                    |

0.3 is not on npm yet. Until its first beta is published, `@beta` installs `0.2.0-beta.9`, whose
API differs; [docs/STATUS.md](docs/STATUS.md) has the state.

## An agent in a local Chromium

A [Yielded](https://github.com/yielded-dev/agent) agent runs the loop; `BrowserTools` gives it
Yielded's browser tools over an `effect-browser` page, and tools of its own for what has no ref.
Any `effect/ai` `LanguageModel` drives it. This one goes through OpenRouter:

```ts
import { OpenRouterClient, OpenRouterLanguageModel } from "@effect/ai-openrouter";
import { Agent, AgentRuntime, InMemory } from "@yielded/agent";
import { Config, Effect, Layer, Schema } from "effect";
import { Model } from "effect/ai";
import { Browser, Chromium } from "effect-browser";
import { BrowserTools } from "effect-browser-agent";
import { FetchHttpClient } from "effect/http";

const tools = BrowserTools.make();

const reader = Agent.make("top-story", {
  input: Schema.String,
  output: Schema.Struct({ title: Schema.String, points: Schema.Finite }),
  instructions: "Do the task with the browser tools, then answer.",
  toolkit: tools.toolkit,
  // One call at a time: a turn's calls act on one page, in the order the model made them.
  policy: { maxTurns: 12, maxToolCalls: 40, maxDuration: "5 minutes", toolConcurrency: 1 },
});

const program = Effect.gen(function* () {
  const page = yield* (yield* Browser.Browser).firstPage;
  const task = "Report the title and points of the top story.";

  yield* page.goto("https://news.ycombinator.com");

  // The tools act on this page, and the input policy's judge reads the task.
  const result = yield* AgentRuntime.run(reader, task).pipe(
    Effect.provide(Layer.merge(tools.layer({ page }, { task }), InMemory.layer)),
  );

  yield* Effect.log(result.output, result.usage);
});

const OpenRouter = Layer.mergeAll(
  OpenRouterLanguageModel.layer({ model: "<model id>" }),
  Layer.succeed(Model.ProviderName, "openrouter"),
  Layer.succeed(Model.ModelName, "<model id>"),
).pipe(
  Layer.provide(OpenRouterClient.layerConfig({ apiKey: Config.Redacted("OPENROUTER_API_KEY") })),
  Layer.provide(FetchHttpClient.layer),
);

program.pipe(Effect.provide([Chromium.layer(), OpenRouter]), Effect.runPromise);
```

## The same agent on Browserbase

Swap the `Browser` layer. The session is created when the layer is built and released when it is
released, so billing stops then rather than at the session's timeout:

```ts
import { Browserbase, BrowserbaseClient, ContextLease } from "effect-browserbase";

const Hosted = Browserbase.layer({ session: { region: "us-west-2" } }).pipe(
  Layer.provide(BrowserbaseClient.layerConfig()), // reads BROWSERBASE_API_KEY
  Layer.provide(ContextLease.layer), // one writer per stored context in this process
  Layer.provide(FetchHttpClient.layer),
);

program.pipe(Effect.provide([Hosted, OpenRouter]), Effect.runPromise);
```

Its pages' screencasts run on a second connection to the session, so frames keep coming while a
large read or upload crosses the connection that drives the pages. An application whose processes
share stored contexts provides a `ContextLease` of its own, such as an advisory lock in its
database, in place of `ContextLease.layer`.

## A moment

`Moment.capture` gathers a page's screencast frames over a window, what visibly changed on it, and
its events in between; `snapshot: true` adds the page's outline at the end. A page records what
changes on it from its first moment, so its next moments can say `"$61,240" became "$62,010" (row
"BTC", column "Price")`, or that an alert came and went between two frames. `Moment.toPrompt` lays a
moment out as one message for any `effect/ai` call, leading with what changed and naming an action
(`click button "Play"`), never by ref, only as what a change followed or where its effect is drawn,
as on a canvas:

```ts
import { LanguageModel, Prompt } from "effect/ai";

const VideoPrompt = Schema.Struct({
  scene: Schema.String,
  motion: Schema.String,
  prompt: Schema.String,
});

const watch = Effect.gen(function* () {
  const page = yield* (yield* Browser.Browser).firstPage;

  yield* page.screencast().pipe(Stream.runDrain, Effect.forkScoped);
  yield* page.goto("https://example.com/live-chart");
  yield* Effect.sleep("5 seconds");

  const moment = yield* Moment.capture(page, { frames: 3 });

  const { value } = yield* LanguageModel.generateObject({
    prompt: Prompt.setSystem(
      Moment.toPrompt(moment),
      "Write a prompt for a five-second video of this moment.",
    ),
    schema: VideoPrompt,
  });

  return value.prompt;
}).pipe(Effect.scoped);
```

Each moment can start where the last one ended, so a narrator neither repeats nor misses an event
or a change. Keeping one `Chat` lets the model see what it already said:

```ts
import { Chat } from "effect/ai";

const narrate = (page: Page.Page) =>
  Effect.gen(function* () {
    const chat = yield* Chat.fromPrompt([
      { role: "system", content: "Caption the stream in five words." },
    ]);

    let last = yield* Moment.capture(page);

    const caption = Effect.gen(function* () {
      last = yield* Moment.capture(page, { since: last });
      const { text } = yield* chat.generateText({ prompt: Moment.toPrompt(last) });

      yield* Effect.log(text);
    });

    return yield* caption.pipe(Effect.repeat(Schedule.spaced("5 seconds")));
  });
```

Every turn adds its moment's pictures to the chat's history, so trim `chat.history` on a long
stream. Add what your own code knows about the page, such as a game's score, as more text in the
prompt.

## How the tools work

`BrowserTools.make()` gives an agent Yielded's browser tools over `PageControl`'s ports, and this
package's pointer tools: `observe`, `act`, `inspect`, `navigate`, `scroll`, `wait`, `press` and
`select_tab`, then `click_at`, `hover`, `drag`, `type_text`, `press_keys`, `zoom`, `wait_still` and
`back`. `BrowserTools.Control` and `BrowserTools.Pointer` are the two groups, for an agent that
wants fewer. `tools.layer({ page })` serves them on one page; `tools.layer({ browser, follow })`
on a browser's tabs. `PageControl.layer` serves the ports alone, for Yielded's own `BrowserUse`
tools.

- An observation is a compact outline of the viewport whose controls carry refs such as `e12`, and
  the controls as values. A ref from an old observation fails as stale rather than naming another
  element. `inspect` reads inside a CSS selector, and narrows a select's options.
- `act` clicks, fills and selects refs, up to eight in one call with the default `"batched"` mode,
  in order, stopping at the first failure, and answers with the next observation. That observation
  begins with what followed the actions on the page: a dialog and how the browser answered it,
  where the page went, a tab they opened and what their input visibly changed. Every result says
  whether input reached the browser: `acknowledged`, `not-dispatched` for a refusal before any, or
  `unknown` for a failure after it; nothing is ever retried.
- Anything an outline cannot show, such as a canvas game, a chart or a video, takes x and y in
  viewport CSS pixels with the pointer tools. Before each turn the model sees a screenshot of the
  current tab, and the crops `zoom` took since its last turn, as context the run never keeps: only
  the current picture is ever in a request, so the prompt cache keeps the history. `vision: false`
  leaves the pictures out.
- Tools that follow a browser's tabs act on the tab the model last saw, since it planned on what it
  saw there, and list the others. A tab that opens is shown at the next look as `follow` says:
  `"select"`, the default, makes it current without bringing it to front, so the page on air and an
  operator's view stay; `"front"` brings it to front; `"never"` stays.
- `navigate` opens only http and https addresses, `data:` URLs and `about:blank`; a model cannot
  open a local file. `Page.goto` also opens the `file:` URLs its caller passes.
- The browser answers dialogs itself, so `respond_dialog` is left out and the port refuses it.
  Yielded's `screenshot` tool is left out too: the pictures before each turn replace it, and the
  port takes PNGs for a host that asks.
- The run is Yielded's: its policy bounds turns, tool calls, time and spend, and it adds approval,
  context management, durable runs and run events. See its
  [documentation](https://github.com/yielded-dev/agent).
- A page waits only for itself. An action has its page to itself, in the order actions were asked,
  and reads share it after the action in flight, so a read describes the page an action left. A
  wait behind other operations on the page fails `Busy`, and `Page.failFast` fails it at once.
  Identical reads in flight share one call, and a read whose caller gave up serves the next caller
  to ask the same. `Browser.Options.maxPages` bounds the open pages, failing `Limit`.
- `Browser.Options.guard` checks input and navigation, including hover, scroll and a new tab's URL.
  It receives the facts the page's structure establishes (form submissions, other-origin
  destinations, downloads, uploads, secret fields, script-only controls and unnamed targets) and
  the page text around the target as evidence, never a field's value; no fact comes from an
  element's words, and typed secrets are redacted. Its effect succeeds to allow, fails with
  `PolicyDenied` to deny, or waits for an external signal to hold. Holds have a separate
  `policyTimeout` (five minutes by default) and leave the page free for other operations. Changed
  targets fail before input when a hold resumes. A field is approved once: plain text goes into it
  in one insertion. With no guard, every action is allowed.
- `Policy.make` builds a guard for unattended runs. A judge, `Policy.reviewer` over a
  `LanguageModel` or `Policy.decider` over a `DecisionModel` such as Jev, reads what an input
  means: a payment, an account, access, a deletion, a message or a secret. The guard denies a risk
  the user's task does not ask for, and fails closed on input with facts when the judge fails.
  `BrowserTools` and `PageControl` give the guard the run's `task`.
- `Presentation` performs input for viewers: `presenter.view(page)` is a page whose actions wait as
  a person reacts, glide the presenter's one drawn pointer along a tuned two-stroke
  sigma-lognormal planner's paths, scroll off-screen targets into view with visible wheel input and
  type at about 70 WPM, with overlapping key holds and slower word starts, while the page itself
  stays plain. Presentation time has a budget of its own, outside `actionTimeout`, and
  `view.aim(target)` starts a glide early. The optional `effect-browser-human-strokes` package
  supplies 32,130 recorded strokes as a planner, `HumanStrokes.motion`; the core package contains
  no data. Each full glide is validated and admitted before its clock starts.
- `Stage` is the source of a live output: `present(page, { at })` switches it between pages, in one
  session or across two, overlapping their captures, and stamps when each switch took effect.
- After input, a page settles in one call, a task and a frame, which spans any navigation the input
  asked for, and then waits for a committed document to be parsed; there is no fixed sleep.
  Printable US text uses key events; other text uses Unicode insertion.
- Events, frame arrivals and moments share the owning browser’s host monotonic clock in milliseconds.
  `Browser.now` reads that clock. These stamps measure elapsed time, not calendar dates.
  Native frames map browser paint to `hostTime` with explicit uncertainty; screenshot timing has
  separate provenance. `Page.captureStats` reports frame gaps, filtering, late frames apart from
  lost ones and the acknowledgement backlog, over a page's life or a window of the latest minute.
- `Browser.events()` carries the timed input track for the consumer’s cursor rendering: complete
  glide plans, submission receipts, button and key phases, wheel input and cursor shape. Each page
  has its own pointer position. Events have sequence cursors for bounded replay; a lagging reader
  gets an explicit history-expired error instead of missing events silently.
- Page actions with their phases, reads, captures and opening the browser are Effect spans, without
  typed text, and Yielded traces the agent's turns and tool calls. Provide an exporter, such as `effect/observability`'s OTLP
  layer, to see them; the [package README](packages/browser/README.md#tracing) lists them.

## Development

The [bench](bench) has seeded operate and understand tasks, including a dense quote table and
multi-frame changes. Trials have separate browsers, bounded concurrency, per-trial metrics and one
shared model budget. A paired quote comparison reuses one capture across the shipping description,
the historical on-air representation and visible-DOM facts. A judges runner grades the input
policy's judges against the labelled corpus of consequential controls. Scripted runs remain free;
model and hosted runs require explicit opt-in.

See [CONTRIBUTING.md](CONTRIBUTING.md). `bun run ready` formats, lints, typechecks, tests against a
real local Chromium and builds. No test calls a model or a hosted browser.
[docs/STATUS.md](docs/STATUS.md) is the current state.

## License

The core packages and code are MIT. The optional `effect-browser-human-strokes` data is CC BY 4.0;
its [README](packages/human-strokes/README.md) carries attribution. Parts of the build configuration are adapted from
[Yielded Agent](https://github.com/yielded-dev/agent), then named effect-agent, under the MIT
License; see [LICENSE-effect-agent](LICENSE-effect-agent).
