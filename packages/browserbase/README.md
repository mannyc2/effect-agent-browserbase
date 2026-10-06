# effect-browserbase

[Browserbase](https://www.browserbase.com) for [effect-browser](../browser): hosted sessions as a
`Browser` layer, and an Effect client for the Browserbase REST API.

```sh
npm install effect-browserbase@beta effect-browser@beta effect playwright-core
```

- `Browserbase`: `open` and `layer` create a session and release it when their scope closes, so
  billing stops then rather than at the session's timeout. `attach` connects to a running session
  without taking ownership of it.
- `BrowserbaseClient`: sessions and their logs, Live View, stored contexts, extensions, Search and
  Fetch. `layerConfig()` reads `BROWSERBASE_API_KEY` and, optionally, `BROWSERBASE_BASE_URL`.
- `BrowserbaseError`: one error with a reason: `Unauthorized`, `NotFound`, `RateLimited`, `Status`,
  `Transport`, `Decode` or `InvalidRequest`.

The API key travels only in the `x-bb-api-key` header, which logs and traces redact, and the client
refuses redirects so the key never follows one. Each request attempt has a deadline
(`requestTimeout`, 60 seconds by default), so a session create that never answers still settles
and its caller can stop. Only `GET` requests are retried, twice, after a transient failure; a
create that fails in transit is not resent, because it may have created the session. Connect URLs and the Live View debugger URL are `Redacted`: keep them away from
models and logs. A failed connect names only the connect URL's scheme, host and port.

`open` and `attach` record the session's id and region on their spans, so a trace finds its
session in Browserbase's dashboard (`https://browserbase.com/sessions/<id>`). `sessionLogs` returns
the DevTools messages Browserbase logged in a session, each by method with a command's request and
response times; it leaves out their parameters and results, which can carry typed text, page
content and screenshots.

## Session settings

`session` takes Browserbase's session create request. Anything left unset takes Browserbase's
default, and this package changes none of them. Browserbase records every session for replay, keeps
its logs and solves captchas unless told not to:

```ts
Browserbase.layer({
  session: { browserSettings: { recordSession: false, logSession: false, solveCaptchas: false } },
});
```

A session made with `logSession: false` has no logs for `sessionLogs` to return.

## Stored contexts

A context keeps cookies, storage and cache between sessions. A session that loads it with
`persist: true` saves its browser state back to it when the session ends; without `persist` it
only reads.

```ts
const program = Effect.gen(function* () {
  const client = yield* BrowserbaseClient.BrowserbaseClient;
  const { id } = yield* client.createContext({ name: "signed-in" });

  yield* signIn.pipe(
    Effect.provide(
      Browserbase.layer({ session: { browserSettings: { context: { id, persist: true } } } }),
    ),
  );
  // Later sessions on the same context start signed in.
});
```

Two sessions saving to one context at once can lose one's changes, and sites may sign a session out
when another uses its login. So `Browserbase.open` and `layer` let one persisting session at a time
hold each context in this process; another waits. When its scope closes, the writer releases its
session and keeps holding the context until Browserbase reports the session ended and then
`contextSettle` (10 seconds by default) longer, because the save lands after the session ends and
Browserbase does not acknowledge it. Writers in other processes are the application's to exclude:
take its own lock first, in the same scope, and the lock is released only after the save has
settled. A session create that fails in transit may still have made a session nobody can see,
which saves to the context when it reaches its `timeout`; keep persisting sessions' timeouts
short. `attach` never holds a context. `deleteContext` is permanent.

## Extensions

Upload a zipped Chrome extension, with `manifest.json` at its root and at most 100 MB, and pass
its id when creating a session. Loading one makes a session slower to start.

```ts
const program = Effect.gen(function* () {
  const client = yield* BrowserbaseClient.BrowserbaseClient;
  const extension = yield* client.uploadExtension(archive, { fileName: "my-extension.zip" });

  yield* work.pipe(Effect.provide(Browserbase.layer({ session: { extensionId: extension.id } })));
  // getExtension reads its name and timestamps; deleteExtension removes it from the project.
});
```

## More

The [repository README](https://github.com/mannyc2/effect-agent-browserbase#readme) has an example.
