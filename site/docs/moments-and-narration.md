# Moments and narration

A screenshot says what a page shows; a **moment** says what it showed and what changed on it over a window of time. That is what a model needs to follow a live chart, a game or a feed, and what an agent needs to see what its actions did.

## A moment

`Moment.capture` gathers a page's screencast frames over a window, what visibly changed on it, and its events in between; `snapshot: true` adds the page's outline at the end. A page records what changes on it from its first moment, so its next moments can say `"$61,240" became "$62,010" (row "BTC", column "Price")`, or that an alert came and went between two frames.

`Moment.toPrompt` lays a moment out as one message for any `effect/ai` call, leading with what changed and naming an action (`click button "Play"`) only as what a change followed. Here the page is a live game on Lichess TV:

:::Example
```ts
const watch = Effect.gen(function* () {
  const page = yield* (yield* Browser.Browser).firstPage;

  yield* page.screencast().pipe(Stream.runDrain, Effect.forkScoped);
  yield* page.goto("https://lichess.org/tv");
  yield* Effect.sleep("5 seconds");

  const moment = yield* Moment.capture(page, { frames: 3 });

  const { value } = yield* LanguageModel.generateObject({
    prompt: Prompt.setSystem(Moment.toPrompt(moment), "Describe what just happened."),
    schema: Schema.Struct({ caption: Schema.String }),
  });

  return value.caption;
}).pipe(Effect.scoped);
```

Run on 11 October 2026 with `Chromium.layer()` and the OpenRouter layer from Get started, it returned:

```text output
On Lichess, GM CondemnedToMove opened the rated 1+0 bullet game by moving the white pawn from e2 to e4. The e2 and e4 squares are highlighted and the move list shows “1. e4”; both clocks read 1:00.
```
:::

Frames carry the browser's paint time mapped onto one host clock, with its uncertainty, so a moment never passes old paint off as the page an action left.

## Moments in an agent's thread

Give `BrowserTools.layer` the option `vision: "moments"` and it puts an account of the tab in the agent's thread after each turn's tool results: what happened since the turn before and what changed. The latest three moments' pictures follow as reference messages labeled by turn, with each frame's time. The agent reads its session in order and can connect each action and account to its pictures.

Each moment starts where the one before ended, so nothing that happened while the model was thinking is missed. Accounts stay unchanged until Yielded compacts them with the surrounding conversation. Retiring older pictures never changes an account or invalidates a compacted prefix. The frames are the ones a running screencast painted, up to three per moment; without one, a moment holds a single screenshot.

For long runs, configure Yielded's native compaction and a model-aware image-token estimate. Its default JSON estimate counts image bytes as text and can overestimate screenshots. The [adapter guide](https://github.com/mannyc2/effect-agent-browserbase/tree/main/packages/agent-browser#moments-and-long-runs) shows how to compose the consumer's resolved model with the moments preparation. The bounded demo runs do not configure automatic compaction.

## The agent's own voice

In the demo, nobody narrates for the agent. What it writes beside its tool calls is spoken over the video in the first person, as its instructions tell it people are watching and listening. Every line is the agent's own reading of the moments in its thread, so you can judge from it whether the page was understood. A voice model speaks each line as that turn's actions start, or as soon as the line before has finished.

::Replay{id="casino"}

Open the frames under any line in the transcript to see the moment the agent was shown before that turn.

## A long stream

Keep one `Chat` and the model sees what it already said; every turn adds its moment's pictures to the chat's history, so trim it on a long stream. Add what your own code knows about the page, such as a game's score, as more text in the prompt.
