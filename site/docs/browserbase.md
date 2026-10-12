# Browserbase

`effect-browserbase` makes a [Browserbase](https://www.browserbase.com) session the same `Browser` a local Chromium is. Swap the layer; the agent and its tools don't change.

The program from [Get started](/docs/get-started), on a Browserbase session instead of a local Chromium:

:::Example
```ts
import { Browserbase, BrowserbaseClient, ContextLease } from "effect-browserbase";

const Hosted = Browserbase.layer({ session: { region: "us-west-2" } }).pipe(
  Layer.provide(BrowserbaseClient.layerConfig()), // reads BROWSERBASE_API_KEY
  Layer.provide(ContextLease.layer), // one writer per stored context in this process
  Layer.provide(FetchHttpClient.layer),
);

program.pipe(Effect.provide([Hosted, OpenRouter]), Effect.runPromise);
```

Run on 11 October 2026 with `npm install effect-browserbase@beta` added, and `BROWSERBASE_API_KEY` set. Browserbase lists the session, in us-west-2, as completed when the program ended:

```text output
[20:25:37.832] INFO (#1): {
  title: 'Total Annihilation, rebuilt for modern computers',
  points: 161
} RunTotals {
  modelCalls: 1,
  inputTokens: 6161,
  outputTokens: 55,
  webSearchCalls: 0,
  costMicrousd: 0,
  usageStatus: 'complete',
  pricingStatus: 'unknown',
  unobservedModelCalls: 0
}
```
:::

## Sessions you can account for

The session is created when the layer is built; closing its scope asks Browserbase to release it, and waits for the outcome. A confirmed `Settled` outcome establishes that the session ended. Each create carries a nonce of its own, so a create whose answer was lost is found and ended rather than left billing until its timeout.

`attach` connects to a running session without owning it, as from another process. `supervise` keeps sessions open across losses and session ends, as generations. The browser announces the session's end ahead of time as a `SessionEnding` event.

## Capture on its own connection

A hosted page's screencast runs on a second connection to the session, so frames keep coming while a large read or upload crosses the connection that drives the page. Moments and narration on Browserbase read the same frames as on a local Chromium.

## Stored contexts

Stored contexts keep logins and cookies between sessions. `ContextLease` decides who may write one: `ContextLease.layer` allows one writer at a time in this process, and an application whose processes share contexts provides its own, such as an advisory lock in its database.
