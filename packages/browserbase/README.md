# effect-browserbase

[Browserbase](https://www.browserbase.com) for [effect-browser](../browser): hosted sessions as a
`Browser` layer, and an Effect client for the Browserbase REST API.

```sh
npm install effect-browserbase@beta effect-browser@beta effect playwright-core
```

- `Browserbase`: `open` and `layer` create a session and release it when their scope closes, so
  billing stops then rather than at the session's timeout, and closing it waits for the release.
  `attach` connects to a running session without taking ownership of it, as from another process:
  that is resume, of a session created with `keepAlive`. `supervise` keeps
  sessions open across losses and session ends, and with `keep`, past its own scope. `reconcile`
  ends a stored context's sessions, and `verifyContext` reads a stored context back.
- `ContextLease`: who may write a stored context. `ContextLease.layer` lets one writer at a time
  hold each context in this process; an application provides its own to exclude writers across
  processes. A persisting open that will not write to a context whose sessions may still save to
  it fails with `ContextHeld`.
- `BrowserbaseClient`: sessions, Live View, stored contexts, extensions, Search and Fetch.
  `layerConfig()` reads `BROWSERBASE_API_KEY` and, optionally, `BROWSERBASE_BASE_URL`.
- `BrowserbaseError`: one error with a reason: `Unauthorized`, `NotFound`, `RateLimited`, `Status`,
  `Transport`, `Decode` or `InvalidRequest`. A request Browserbase refuses as malformed, such as a
  session id that is not a UUID, is `InvalidRequest`, as is one this client refuses before sending.
  A create whose answer named its session but did not decode is `Decode` with `released`, whether
  the client released that session.

`open`, `layer`, `supervise`, `reconcile` and `verifyContext` need a `ContextLease`, and the client:

```ts
const Hosted = Browserbase.layer({ session: { region: "us-west-2" } }).pipe(
  Layer.provide(BrowserbaseClient.layerConfig()),
  Layer.provide(ContextLease.layer),
  Layer.provide(FetchHttpClient.layer),
);
```

Each page keeps its CDP target id as its `id` across connections, so `attach` to the same session,
after a dropped connection or from another process, finds a page stored before with
`browser.page(id)`. `attach` refuses a session that has ended, `Closed` by the session, before it
connects. The browser carries the session's `expiresAt`, announces it as a `SessionEnding` event,
and reports a loss at or after it as the session's end (`Disconnected` with cause `session`), any
other drop as `connection`.

The API key travels only in the `x-bb-api-key` header, which logs and traces redact, and the client
refuses redirects so the key never follows one. Each request attempt has a deadline
(`requestTimeout`, 60 seconds by default), so a session create that never answers still settles
and its caller can stop. Only `GET` requests are retried, twice, after a transient failure; a
create that fails in transit is not resent, because it may have created the session. Connect URLs and the Live View debugger URL are `Redacted`: keep them away from
models and logs. A failed connect names only the connect URL's scheme, host and port.

Each create `open` sends carries a nonce of its own in the session's user metadata, `createNonce`.
A create whose answer was lost, or that Browserbase answered 5xx or 408, may still have made a
session that nobody can see, and that bills until its timeout: `open` looks for it by its nonce,
again and again for up to 30 seconds, since Browserbase can list a new session late, ends it, and
then fails with the create's error. A `supervise` that tries again after such failures leaves no
session behind each try.

`open` and `attach` record the session's id and region on their spans, so a trace finds its
session in Browserbase's dashboard (`https://browserbase.com/sessions/<id>`).

## Releases

`open` and `attach` give a `Hosted`: the `browser`, Browserbase's `session`, and `release`. A
release first disconnects the browser, which is lost as `released`, so a call in flight or a
capture's reader says the session was released, not that the connection Browserbase then cuts was
lost. It asks Browserbase to end the session and then reads it until Browserbase reports it ended,
trying both again a second apart for up to a minute, and says how it went: `Settled`, or
`Unconfirmed` when the session still ran, or Browserbase could not be asked, at the deadline. An
unconfirmed session may still bill until its timeout. `open`'s scope releases its session as it
closes, so closing the scope waits for the release: up to a minute while Browserbase confirms the
end, and for a session that saves to a stored context `contextSettle` longer, 10 seconds by
default. `release` does it sooner and gives the outcome as a value, and the scope then asks
Browserbase nothing more. Closing `attach`'s scope only disconnects; its `release` ends the
session. Browserbase ends a session whose last connection closes unless it was created with
`keepAlive`, which `supervise({ keep })` sets and `session.keepAlive` asks for, so only such a
session outlives the process that opened it, for another to attach to.

## Supervised sessions

`supervise` keeps a browser on Browserbase as `Supervisor` generations, each a new session made
from `session`. A lost session is published at once, `Lost` with its cause, and replaced on the
`reopen` schedule; the next session opens `rotateBefore` ahead of the current browser's
`expiresAt`, or on `rotate`, before the current one is released. `states` reports each session's release outcome. Sessions that
persist to a stored context are exclusive: a rotation releases the current session, and lets its
save settle, before the next one opens. An open Browserbase refused, as for a bad key or an invalid
request, is `Down` at once with its cause, since no new try mends it; everything else, a held
context included, is tried again on the schedule.

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

### Keeping a session past the scope

With `keep`, a name, closing the supervisor's scope leaves its current session running instead of
releasing it, published as `Kept`, and the first generation of the next `supervise` under the same
name adopts that session, its pages and their ids with it, rather than creating one. So a deploy or
a restart of the process that owns the browser keeps its prepared pages and its signed-in state.
It is off by default, and opt-in, because a kept session bills until something adopts and releases
it, or until its own `timeout` ends it: set one that bounds what a forgotten session costs.

- Each session is created with `keepAlive`, so it outlives its connection, and labelled
  `keptAs: <name>` in its user metadata, since Browserbase sets user metadata only at the create.
  A name is 1 to 64 letters, digits, `_`, `.`, `:` or `-`; another is refused, `Down` at once.
- Adopting takes the newest session kept under the name that saves to the same stored context, or
  to none; any other session kept under the name is ended, as nothing else adopts it.
- `retire` always releases, `keep` or not. Only the first generation adopts: a later one, after a
  loss or a rotation, is a new session.
- One supervisor at a time per name: two at once would adopt one session together.

```ts
const sessions = yield * Browserbase.supervise({ keep: "on-air", session: { timeout: 60 * 60 } });
const browser = yield * sessions.browser; // the session the last process kept, if one runs
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

## The capture connection

A page's screencast runs on a second connection to the session that carries nothing else. On the
connection Playwright drives the pages over, a frame and its acknowledgement would wait behind any
large message, such as an upload or a read's answer, because Browserbase refuses compression: on a
hosted session at 1280×720, while another tab read and uploaded, the on-air page's longest wait
between frames was 1,802 ms on that connection and 352 ms on its own (8 October 2026).

The connection is raw CDP, with no Playwright, and read-only: a page's session on it starts,
acknowledges and stops the screencast, and turns on the Page domain and reads the frame tree, so
that each frame carries the document its own connection saw commit, numbered as `Navigated`
numbers them. A page's first capture there costs three round trips, run beside the control
connection's own: the attach, then the Page domain and the frame tree together, then the start.
The browser's first capture also opens the connection. A later capture of the page costs the start
alone, and on the control connection a capture costs one call fewer. The page's own session keeps the focus
emulation that keeps a tab behind painting: a session that held it too would blur the page as it
went. The connection opens with the first capture and closes with the browser. If it fails alone,
the capture ends with `Failed` two seconds on, the page and its own session stay as they were, and
the next capture opens another. If the browser is lost too, the capture's readers are told the
browser's loss, `Closed` by its cause, whichever connection hears the end first. A wait for a
still screen, `ready({ quietMillis })`, ends with one round trip on this connection,
`Page.getFrameTree`, whose answer comes behind any frame still on its way, so a stall here is not
read as stillness; it costs the control connection nothing. `captureConnection: false` keeps
captures on each page's own session; so does a DevTools server's `http:` address, such as a local
Chromium's in tests.

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
when another uses its login. So a persisting `open` holds the context through the `ContextLease`,
and another writer waits. It takes the hold before it creates the session, and the writer's release
keeps it until Browserbase reports the session ended and then `contextSettle` (10 seconds by
default) longer, because the save lands after the session ends and Browserbase does not
acknowledge it. `ContextLease.layer` excludes writers in this process. To exclude writers in other
processes, provide a `ContextLease` of your own, such as an advisory lock in your database: `hold`
holds a context for a scope, waiting while another holds it, and passes on how the writer before
left it. `attach` never holds a context. `deleteContext` is permanent.

```ts
const Lease = Layer.succeed(ContextLease.ContextLease, {
  // Take the row's lock for the scope; say `unsettled` when its holder left it so, or never said.
  hold: (context) => lockRow(context), // Effect<ContextLease.Hold, ContextHeld, Scope>
});
```

Three things leave a session that may still be saving to the context: a release left `Unconfirmed`;
a create whose answer was lost, which may have made a session nobody can see; and a session kept
past its supervisor's scope. Each leaves the context unsettled, through the lease, and the next
writer clears it before it writes: it ends the context's sessions, which `open` labels with
`persistsContext: <context id>` in Browserbase's user metadata, confirms they ended, waits
`contextSettle` and goes on. While they cannot be confirmed ended it fails with `ContextHeld`, which
leaves the context unsettled, so the open after it tries again. A lost create's own open ends that
session, found by its create's nonce, waits `contextSettle`, and then fails with the create's error.
A lease that outlives its holders' processes reads a holder that ended without saying, as when its
process was killed, as unsettled too. No context is ever held with no way out, and no two sessions
write to one context.

`reconcile(contextId)` does that clearing without opening a session: the way to end sessions another
process left running. It holds the context through the lease, so it waits for a writer, and a
session still running at its deadline makes it `Unconfirmed` and leaves the context unsettled.

`verifyContext(contextId, check)` reads a context back, as a login: a session that loads the
context and saves nothing runs `check` on its browser and is released, and `verifyContext` gives
what `check` gave. It holds the context meanwhile, so it reads what the last writer saved, once
that save has settled, and never runs beside a writer that a site could sign out; a session a
writer before may have left saving to the context is ended first.

```ts
const signedIn =
  yield *
  Browserbase.verifyContext(contextId, (browser) =>
    Effect.gen(function* () {
      const page = yield* browser.firstPage;

      yield* page.goto("https://example.com/account");

      return (yield* page.text()).text.includes("Sign out");
    }),
  );
```

A supervised persisting session reopens through the same path, so a held context is tried again on
the `reopen` schedule. An open that Browserbase refused outright, as for a bad key, is `Down` at
once instead, with its cause: a schedule would only hide a configuration error. A supervisor that
keeps a persisting session leaves its context unsettled, so any other writer ends that session
first; the next supervisor under its name adopts it without ending it. Under `ContextLease.layer`,
a later process's other writers can't know it runs: keep one where the next writer is the
supervisor that adopts it, or under a lease that outlives the process.

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
`TestClock` ends them. A `Script` loses a create, whose session it can list only `listedAfter` a
while, leaves a release pending, refuses it, or fails status reads, in turn. `connectUrl` gives
each session a DevTools address, such as a local Chromium's. It keeps sessions and stored contexts
only, and fails a test that calls anything else; `sessions` tells each session's status, user
metadata, releases asked, whether it was kept alive, and the stored context it loaded and whether
it saves to it. Its ids are UUIDs, as Browserbase's are, and it answers each id shape as Browserbase
does: it refuses a session id of any other shape, where it answers an unknown well-formed one as
not found. `BrowserbaseContract.checks` are what this package relies on Browserbase to do, each an
Effect over `BrowserbaseClient`; the fake passes them. Its answers also have the shapes
Browserbase's published API reference gives them, which the package's tests check against a copy
of it, except that a session has a `connectUrl` only when the script gives one. Give each test a
`ContextLease.layer` of its own, so no test inherits a context another left unsettled.

```ts
it.effect("leaves the context unsettled while a release is pending", () =>
  work.pipe(
    Effect.provide(
      Layer.merge(TestBrowserbase.layer({ releases: [{ _tag: "Pending" }] }), ContextLease.layer),
    ),
  ),
);
```

## More

The [repository README](https://github.com/mannyc2/effect-agent-browserbase#readme) has an example.
