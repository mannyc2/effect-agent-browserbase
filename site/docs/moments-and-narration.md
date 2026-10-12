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

Give `BrowserTools.layer` the option `vision: "moments"` and it puts a moment of the tab in the agent's thread after each turn's tool results: what happened since the turn before, what changed, and three frames with their times, the last one the page as it is. The agent reads its session in order, each action followed by what the page did, as you would watch a recording of it.

Each moment starts where the one before ended, so nothing that happened while the model was thinking is missed. Every moment's account stays in the thread for the whole run; the frames only for the latest three, since pictures cost the most and the newest show the page as it is. The frames are the ones a running screencast painted; without one, a moment holds a single screenshot.

## The agent's own voice

In the demo, nobody narrates for the agent. What it writes beside its tool calls is spoken over the video in the first person, as its instructions tell it people are watching and listening. Every line is the agent's own reading of the moments in its thread, so you can judge from it whether the page was understood. A voice model speaks each line as that turn's actions start, or as soon as the line before has finished.

::Replay{id="casino"}

Open the frames under any line in the transcript to see the moment the agent was shown before that turn.

## A long stream

Keep one `Chat` and the model sees what it already said; every turn adds its moment's pictures to the chat's history, so trim it on a long stream. Add what your own code knows about the page, such as a game's score, as more text in the prompt.
