# effect-browserbase

[Browserbase](https://www.browserbase.com) for [effect-browser](../browser): hosted sessions as a
`Browser` layer, and an Effect client for the Browserbase REST API.

```sh
npm install effect-browserbase@beta effect-browser@beta effect playwright-core
```

- `Browserbase`: `open` and `layer` create a session and release it when their scope closes, so
  billing stops then rather than at the session's timeout. `attach` connects to a running session
  without taking ownership of it. `supervise` keeps sessions open across losses and session ends,
  and `reconcile` ends a stored context's sessions.
- `BrowserbaseClient`: sessions, Live View, stored contexts, extensions, Search and Fetch.
  `layerConfig()` reads `BROWSERBASE_API_KEY` and, optionally, `BROWSERBASE_BASE_URL`.
- `BrowserbaseError`: one error with a reason: `Unauthorized`, `NotFound`, `RateLimited`, `Status`,
  `Transport`, `Decode` or `InvalidRequest`.

The API key travels only in the `x-bb-api-key` header, which logs and traces redact, and the client
refuses redirects so the key never follows one. Each request attempt has a deadline
(`requestTimeout`, 60 seconds by default), so a session create that never answers still settles
and its caller can stop. Only `GET` requests are retried, twice, after a transient failure; a
create that fails in transit is not resent, because it may have created the session. Connect URLs and the Live View debugger URL are `Redacted`: keep them away from
models and logs. A failed connect names only the connect URL's scheme, host and port.

`open` and `attach` record the session's id and region on their spans, so a trace finds its
session in Browserbase's dashboard (`https://browserbase.com/sessions/<id>`).

## Releases

`open` and `attach` give a `Hosted`: the `browser`, Browserbase's `session`, and `release`. A
release asks Browserbase to end the session and then reads it until Browserbase reports it ended,
trying both again a second apart for up to a minute, and says how it went: `Settled`, or
`Unconfirmed` when the session still ran, or Browserbase could not be asked, at the deadline. An
unconfirmed session may still bill until its timeout. `open`'s scope releases its session as it
closes; `release` does it sooner and gives the outcome as a value, and the scope then asks
Browserbase nothing more. Closing `attach`'s scope only disconnects; its `release` ends the
session.

## Supervised sessions

`supervise` keeps a browser on Browserbase as `Supervisor` generations, each a new session made
from `session`. A lost session is published at once and replaced on the `reopen` schedule; the
next session opens `rotateBefore` ahead of the current one's `expiresAt`, or on `rotate`, before
the current one is released. `states` reports each session's release outcome. Sessions that
persist to a stored context are exclusive: a rotation releases the current session, and lets its
save settle, before the next one opens.

```ts
const program = Effect.gen(function* () {
  const sessions = yield* Browserbase.supervise({
    session: { timeout: 6 * 60 * 60 },
    reopen: Schedule.exponential("1 second").pipe(Schedule.upTo({ duration: "5 minutes" })),
    rotateBefore: "20 minutes",
  });
  const browser = yield* sessions.browser;
  // `retire` releases every session; so does the scope's close.
});
```

## Session settings

`session` takes Browserbase's session create request. Anything left unset takes Browserbase's
default, and this package changes none of them. Browserbase records every session for replay, keeps
its logs and solves captchas unless told not to:

```ts
Browserbase.layer({
  session: { browserSettings: { recordSession: false, logSession: false, solveCaptchas: false } },
});
```

Pages open at Browserbase's default viewport, which was 2560×1440 on 7 October 2026: four times
the pixels of `Chromium.layer`'s 1280×720. `browserSettings.viewport` sets another.

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
hold each context in this process; another waits. The writer's release keeps holding the context
until Browserbase reports the session ended and then `contextSettle` (10 seconds by default)
longer, because the save lands after the session ends and Browserbase does not acknowledge it. A
release left `Unconfirmed` keeps the context held, since its session may still save to it.
Writers in other processes are the application's to exclude: take its own lock first, in the same
scope, and the lock is released only after the save has settled. `attach` never holds a context.
`deleteContext` is permanent.

`open` labels each persisting session with its context in Browserbase's user metadata, as
`persistsContext`. `reconcile(contextId)` finds the context's running sessions by that label, ends
them, confirms they ended and, after `contextSettle`, lets the context go: the way out of an
`Unconfirmed` release. It also ends sessions other processes, or a create whose answer was lost in
transit, left running, so call it after such a failure too.

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

## Testing

`effect-browserbase/testing` holds `TestBrowserbase`, the Browserbase API in memory: an `HttpClient`
under the real `BrowserbaseClient`, so the client and `Browserbase` run as they would against
Browserbase, for free. Sessions run until released or until their timeout on the Effect `Clock`, so
`TestClock` ends them. A `Script` loses a create, leaves a release pending, refuses it, or fails
status reads, in turn. `connectUrl` gives each session a DevTools address, such as a local
Chromium's. It keeps sessions and stored contexts only, and fails a test that calls anything else.
`BrowserbaseContract.checks` are what this package relies on Browserbase to do, each an Effect over
`BrowserbaseClient`; the fake passes them. Its answers also have the shapes Browserbase's published
API reference gives them, which the package's tests check against a copy of it, except that a
session has a `connectUrl` only when the script gives one.

```ts
it.effect("leaves the context held while a release is pending", () =>
  work.pipe(Effect.provide(TestBrowserbase.layer({ releases: [{ _tag: "Pending" }] }))),
);
```

## More

The [repository README](https://github.com/mannyc2/effect-agent-browserbase#readme) has an example.
