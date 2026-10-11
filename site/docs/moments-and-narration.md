# Moments and narration

A screenshot says what a page shows; a **moment** says what it showed and what changed on it over a window of time. That is what a narrator needs, and what a model needs to understand a live chart, a game or a feed.

## A moment

`Moment.capture` gathers a page's screencast frames over a window, what visibly changed on it, and its events in between; `snapshot: true` adds the page's outline at the end. A page records what changes on it from its first moment, so its next moments can say `"$61,240" became "$62,010" (row "BTC", column "Price")`, or that an alert came and went between two frames.

`Moment.toPrompt` lays a moment out as one message for any `effect/ai` call, leading with what changed and naming an action (`click button "Play"`) only as what a change followed:

```ts
const watch = Effect.gen(function* () {
  const page = yield* (yield* Browser.Browser).firstPage;

  yield* page.screencast().pipe(Stream.runDrain, Effect.forkScoped);
  yield* page.goto("https://example.com/live-chart");
  yield* Effect.sleep("5 seconds");

  const moment = yield* Moment.capture(page, { frames: 3 });

  const { value } = yield* LanguageModel.generateObject({
    prompt: Prompt.setSystem(Moment.toPrompt(moment), "Describe what just happened."),
    schema: Schema.Struct({ caption: Schema.String }),
  });

  return value.caption;
}).pipe(Effect.scoped);
```

Frames carry the browser's paint time mapped onto one host clock, with its uncertainty, so a moment never passes old paint off as the page an action left.

## A narrator

Each moment can start where the last one ended, so a narrator neither repeats nor misses an event or a change. In the demo, the narrator runs beside the agent: every few seconds it captures the moment since its last line and asks a model for one sentence, sized to the interval so spoken lines don't pile up. It reads the screen and nothing else. It never steers, slows or grades the agent, and a failed caption call is skipped rather than ending the run.

A voice model speaks each line where the window it describes ends, at the last frame the narrator saw, or as soon as the line before has finished. On a live stream a line is heard when its words arrive, several seconds later and with the screen moved on; a replay places it where it belongs. The replay keeps all of it on the recording's clock: the window each line describes, when its words arrived, and when it was spoken.

::Replay{id="polymarket"}

Open "What the narrator saw" under any line in the feed to see the frames its moment held.

## A long stream

Keep one `Chat` and the model sees what it already said; every turn adds its moment's pictures to the chat's history, so trim it on a long stream. Add what your own code knows about the page, such as a game's score, as more text in the prompt.
