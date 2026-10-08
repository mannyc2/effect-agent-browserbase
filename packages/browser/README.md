# effect-browser

Browser automation for [Effect](https://effect.website) agents, over Playwright: page control, a
compact page outline for models, screencast frames, `effect/ai` browser tools, an agent loop, and
moments, a picture-and-timeline account of what a page showed at one point in time.

```sh
npm install effect-browser@beta effect playwright-core
npx playwright-core install chromium
```

`Chromium.layer` launches that Chromium without its sandbox, as Playwright does, so an exploit in a
page's renderer runs with your user's privileges. `Chromium.layer({ sandbox: true })` runs it
sandboxed. Hosts that don't allow unprivileged user namespaces, such as many containers and Ubuntu
23.10 or later by default, can't start the sandbox; opening then fails and says so.

`Chromium.layer` leaves signals to your program: Playwright's own handlers, which close every
browser and, on SIGINT, exit before any finalizer runs, are off. Run the program with
`NodeRuntime.runMain` from `@effect/platform-node`, which interrupts it on SIGINT and SIGTERM, so
the browser closes with its scope. A signal that ends the process outright still takes Chromium
with it, since its pipe closes, but leaves Playwright's temporary profile behind.

| Module         | What it holds                                                                        |
| -------------- | ------------------------------------------------------------------------------------ |
| `Browser`      | The `Browser` service: tabs, recent events and the Playwright context                |
| `Chromium`     | A local Chromium as a `Browser` layer                                                |
| `Cdp`          | Any DevTools endpoint as a `Browser` layer                                           |
| `Page`         | One tab: navigation, reads, screenshots, input, waits and the screencast             |
| `Snapshot`     | The model-readable outline of a page, with refs for its controls                     |
| `Frame`        | A screencast frame                                                                   |
| `BrowserEvent` | Tabs, documents, loads, actions, dialogs, pointer motion and the browser's end       |
| `Motion`       | The replaceable, bounded pointer planner, with a tuned sigma-lognormal default       |
| `BrowserError` | Typed failures, whether input reached the page first, and what each leaves           |
| `Tools`        | The `effect/ai` browser toolkit                                                      |
| `Agent`        | A model with the tools, in a loop, until it reports an answer of the shape you asked |
| `Policy`       | Judges that read what an input means, and a guard that acts on them unattended       |
| `Moment`       | What a page showed and what happened on it over a window, laid out as a model prompt |
| `Plan`         | A walk recorded from a page's events, replayed on a fresh page by subject            |
| `Supervisor`   | A browser kept open across losses and session ends, as generations                   |

`Agent.run` batches each turn's tool calls in order, halting on the first failure or a completed
`done` / `give_up`. Skipped calls receive a not-executed result. A malformed `done` answer can
be corrected on the next turn. A response whose model output cannot be read, one calling a tool
that does not exist or with arguments that are not JSON, runs none of its calls: the model is told
so, and the turn counts as a step. `onStep` reports it with `rejected` set. A reply that the
provider's client cannot decode is not the model's to correct and ends the run with its `AiError`.

`Agent.run` fails with `AgentError | AiError | BrowserError | E`: how the agent ended (`StepLimit`,
`GaveUp` or `Refused`), the model's provider, the browser, or `E`, what `onStep` fails with. An
added tool's failure goes back to the model rather than ending the run. The run needs the
`Browser`, a `LanguageModel`, the added tools' handlers and whatever `onStep` uses. A caller that
spells out the options writes `Agent.Options<E, Extra, R>`, with `R`, `onStep`'s services, last.

The model gets one outline and screenshot at the start and after each turn. `observation` selects
`"outline"`, `"screenshot"`, or `"both"` (the default). When the current page cannot be observed,
the model is told why and the run goes on; when no page can be had at all, as after the browser
closed, the run fails with that `BrowserError` instead of calling the model again. The turn
before it is still reported to `onStep`, and an answer it gave with `done` is still returned. `Page.observe` returns that observation as
a schema value. `Tools.make` returns receipts. A caller writing its own loop spreads a fresh
`yield* tools.batch` into each `generateText` call: it carries the toolkit with the same ordered,
halting execution and the `concurrency: 1` that `effect/ai` needs to keep calls in order.
`Tools.batch` does the same for any toolkit with handlers. After the batch, the caller observes
the current `tools.page` and drains `tools.takeZooms` into that same observation message.

`browser_zoom` captures a region in viewport CSS pixels when the tool runs. Requested crops arrive
with the next observation even in outline mode, labeled with their tab's number and viewport origin.
At most eight crops may await an observation. `Page.zoom` exposes the same capture as a `Zoom`
schema value with `region` and `image`; crop pixel coordinates need the region's origin added before
using them as click coordinates.

`Page.click` returns a `ResolvedTarget` captured before input: the requested point, element label,
role, accessible name, context, cursor and link target. Pixel targeting resolves through the page
script and keeps the original point; the receipt names the control even when a nested child
received the hit. Refs inside same-origin frames are measured, scrolled and checked for cover in the
top viewport. A ref that no longer names an element of the current documents, including one in a
frame that has since navigated, fails with `StaleRef` naming that ref, with or without a guard.

A subject names an element durably: its role, accessible name and tag, and its context, the words
around it that say which one it is. In a table, `row` is the row's header or first cell with text
and `column` the header over it, spanned cells counted; elsewhere, `label` is the words just before
it in its row, item, group or block. `heading` is the nearest heading above it, left out for what
is pinned to the viewport. The page binds each to the element, so a value is never read under
another column's header.

`Page.find` reads structure without the outline, in one call to the page. It returns every element
that matches a query, in tree order, each a `Found`: a ref the actions take, its `subject`, its box,
whether it is in the viewport, and its state (disabled, focused, and checked, expanded, selected,
pressed or a heading's level where they apply). A `role` matches ignoring case. A `name` matches
when it reads the same once spaces are collapsed and case folded, or when a `RegExp` finds itself
in it. `text` matches the smallest element showing it, and a control or heading for the words
inside it; `near` matches whole words of the context, as replay's choice does. With no rule,
`find` returns every element in scope that has a role or is a control. There is no ordinal: a
caller tells equal elements apart by their context, and finding none is an empty result, not a
failure. `scope: "document"` reads the whole page; the default is the viewport.

`Page.text` reads what the viewport shows, or one element whole with `scope` set to its ref, in one
call to the page: a line per block, table cells apart by tabs, cut at a line after `maxChars`
(12,000 by default). Like the outline, it leaves out what the page hides from assistive technology,
such as icon glyphs. What a field holds reads `••••` unless `unmask` is set, and a secret field's
always does, as does one that was secret when the library saw it, such as a password its page now
reveals. The outline shows what fields hold, as the agent needs, but masks a secret field the same
way.

Reading the viewport, the outline, `find` and `text` skip a subtree whose box lies outside it before
styling anything in it, so a long table costs only its rows in view. A box says nothing of what is
positioned out of it, so a subtree is kept when its box is empty, or when it holds what is painted
at the viewport's edges, corners or middle, or in its top layer; something pinned elsewhere, inside
a subtree out of view, is missed. The outline's `above` and `below` count the parts skipped, each an
element out of view with all it holds.

`Page.ready` waits until a page is ready to be shown, asking the page in one call every 100 ms:
its document is parsed and has painted since, nothing that ends is animating in view, its fonts
and the images in view have loaded, and the viewport shows something. A hidden tab, which paints
nothing, is never ready. With `quietMillis`, the screen must then also stay still that long: no
screencast frame comes, counted from the first frame of a capture the wait starts itself, since a
hosted browser sends that frame over half a second late. Stillness is a heuristic on a canvas: a
canvas that keeps drawing, such as a live chart, is never still, and one that pauses longer than
`quietMillis` between phases reads as still. On the slot machine fixture, 0 of 130 waits, at
local speed, with the CPU slowed four times, and behind 70 and 300 ms round trips, ended while
the reels spun.

`Plan` rehearses a walk once and replays it later, near live, with no model call.
`Plan.fromEvents(page.recentEvents)` keeps one page's completed actions with their subjects and
the options they were given, its navigations with the address asked for and the one reached, and
what was typed as an input slot named for its field, never the text itself. `Plan.replay(page,
plan, { inputs })` takes the steps in turn: before each that acts, it waits for `Page.ready`
(`settle` sets how, or `false` not to wait), finds the one element the step's subject names with
`Plan.locate`, and acts on it. Context decides between equal candidates: one in another row or
under another column is not the subject, and the rest rank by how much of the recorded context
they repeat; a tie is `Ambiguous`, since there is no ordinal. An element step never falls back to
coordinates. A step recorded at a point presses the same place within the element found, brought
into view first, and only when a press there reaches that element, not something over it. Replay
stops at the first step it cannot take, with a `ReplayError` naming the step and why: `Missing`,
`Ambiguous`, `Drifted` (the subject is only in another row, or the walk ended on another site), or
the step's `BrowserError`. Nothing is replayed automatically, and a plan of another version does
not decode.

Add a caller's toolkit with `additionalTools` and provide its handler layer to the run. It is
merged after the browser tools, so the caller's tool wins a name clash with one, and its calls
share the batch's halt behavior. `done` and `give_up` end the run and stay the agent's own: a
toolkit that names either does not type-check.
A failure of a tool with failure mode `"error"` reaches the model encoded by that tool's failure
schema and marked as possibly effective; a call whose parameters fail validation never reaches its
handler and answers as not executed.

`Browser.Options.guard` is the input policy. Its `InputRequest` schema contains the action, the
resolved element, the page's URL and title, and the `facts` the page's structure establishes:
`form-submit`, `cross-origin`, `download`, `upload`, `secret` (typing with `type` into a
password, one-time code or card field, or submitting a form that holds a filled one), `scripted` (the activated
control has no effect of the browser's own, so only page script decides what happens) and
`opaque` (nothing names what receives the input, such as a canvas or an unlabelled icon). More
than one may apply. They describe what the input activates, found as the browser finds it: the
submit button around a painted label, an SVG link around a shape, an image-map area. Hovering and
scrolling activate nothing and carry none. `point` is present for literal pixel targets; a ref's
coordinates are resolved after approval so preparation never scrolls.

Facts never come from what an element's text says: words change meaning with context and
language, so a payment, a deletion or a consent is for a judge to recognise. The request carries
the evidence one needs: the target's name and description, its dialog, the heading before it, the
text beside it in its row or form, and the form's fields with their types and autocomplete tokens.
Fields carry whether they are filled, never their values. All of it is page text the page
controls, to read as evidence and never as instructions. Text typed into a `secret` field reaches
the guard and the recorded `Action` as `redacted`, and its key events as `Unidentified` keys;
`press` sends and records the keys it is given, so type secrets with `type`.
It covers clicks, drags, typing, keys, selection, hover, scroll and navigation, including a new
tab's destination.

The policy's effect succeeds to allow, fails with `PolicyDenied` to refuse, or waits for a signal
the consumer owns to hold. For example:

```ts
import { Effect } from "effect";
import { PolicyDenied } from "effect-browser/BrowserError";
import * as Chromium from "effect-browser/Chromium";

const browser = Chromium.layer({
  guard: (request) =>
    request.facts.includes("secret") && request.facts.includes("cross-origin")
      ? Effect.fail(new PolicyDenied({ detail: "Secrets are never sent to another site." }))
      : Effect.void,
});
```

`effect-browser/Policy` builds guards for a browser with nobody watching. A judge reads what an
input means. `Policy.reviewer()` asks the `LanguageModel` in context for a structured review, and
`Policy.decider` asks a `DecisionModel`, such as Jev through `@effect/ai-typesafe`. Both give a
`Judgement`: for each `Risk` (`financial`, `account`, `access`, `deletion`, `communication` and
`secret`), the probability that the input does it, and the probability that the user's task asks
for it. `Policy.escalate(first, second)` asks `second` only when `first` is unsure.
`Policy.make({ judge })` denies an input with a likely risk the task does not ask for, saying which
and why. `origins` keeps input to some origins, and `deny` refuses facts outright:

```ts
import { Effect, Layer } from "effect";
import * as Chromium from "effect-browser/Chromium";
import * as Policy from "effect-browser/Policy";

const browser = Layer.unwrap(
  Effect.gen(function* () {
    const judge = yield* Policy.reviewer();

    return Chromium.layer({ guard: Policy.make({ judge, origins: ["https://shop.example"] }) });
  }),
);
```

The task comes from `Policy.Task`, which `Agent.run` provides to its inputs; elsewhere, provide it
yourself, or risky input is denied for want of one. A judge sees the task, the action, the typed
text and the facts as trusted, and the page's text only as evidence. It never sees the agent's own
words. A judgement only adds to structure: a `secret` fact counts whatever the judge reads. A judge
that fails or exceeds `timeout` (30 seconds) leaves the input unjudged. `make` then denies the input
if it has any fact, with the judge's failure as the `PolicyDenied` cause, and lets an input without
facts, such as a same-origin link, go ahead. `Agent.run` ends with a `Refused` reason after three
refusals in a row. Through `@effect/ai-openrouter` 4.0.0, structured output needs
`strictJsonSchema: true` in the model's config, or OpenRouter drops the response format and every
review fails to decode.

Holds use `policyTimeout`, a finite positive duration defaulting to five minutes, separately from
the action timeout. They do not keep the page locked. After approval, the library verifies the same
document, target and relevant facts before sending input: a control's name is bound but other page
text, such as a live price, is not; the URL is bound without a fragment that only marks a place on
the page, as scroll-spy and feed pages rewrite while scrolling (a `#/` or `#!` hash route stays
bound). Changed targets fail undispatched; the library never retries the action or the policy
automatically. A pointer press is checked again once the pointer has arrived and the page has had a
frame to react: the approved control must still receive the press point, so a control that appears
under the pointer, such as a hover menu, stops the action before the button goes down. A link,
button or other control nested inside the target between it and the press point stops it too, since
the approval inspected the target, not that control. Each
further press of a double or triple click is checked the same way after the earlier clicks' handlers
have run. Typing checks before each further key that the approved control still has focus, so a key
handler that moves focus stops the typing before any key reaches another control; this waits for
each key's answer, about two protocol round trips per key, and the typing deadline allows 250 ms
per key for it. A policy timeout is a typed `PolicyTimeout`, and tools surface both timeout and denial as ordinary failed
receipts. Without a guard, actions are allowed and nothing is revalidated. Canvas and opaque frames
expose their outer element's metadata.

With `humanize`, off-screen ref targets are reached with visible wheel input before the pointer
moves to them. Scroll attempts are bounded and may use one instant fallback. A denied or held action
does not scroll. After scrolling, a guarded action checks the original target again; a page handler
that changes its meaning can therefore stop it after its wheel input but before a click, and the
failure is undispatched: travel toward a press is not the action's input. Drag endpoints are
resolved together in the final viewport, and checked under the pointer, before the button is
pressed.

Humanized pointer movement uses a tuned two-stroke sigma-lognormal planner. It evaluates the model
every 16.7 ms but sends a move only when the pointer reaches a new pixel; the exact destination
lands at the model's end time, so only that final move can repeat the position before it.
`Motion.Motion` is a service reference with that default; the browser captures it once when
constructed. A custom `plan(from, to)` returns a complete schedule with finite coordinates and
nondecreasing absolute `afterMillis` offsets, at most 2,048 samples and 5,000 milliseconds, ending
at the exact destination. The browser decodes it with `Motion.Plan` into its own copy, then checks
the endpoint; invalid plans fail with `InvalidRequest` before their track or input is sent.
Equal-time samples are retained. Plain pointer movement does not use the service.

For recorded human strokes, install the optional `effect-browser-human-strokes` package and
provide it to the layer that builds the browser:

```ts
import * as HumanStrokes from "effect-browser-human-strokes";
import * as Chromium from "effect-browser/Chromium";

const browser = HumanStrokes.provideTo(Chromium.layer({ humanize: true }));
```

Because the planner is read once, at construction, merging `HumanStrokes.layer` beside a browser
layer instead of providing it to that layer leaves the default planner in place.

That package bundles 32,130 attributed CC BY 4.0 strokes, preserving their original sample times.
The core package includes no stroke data. Every glide reserves its full bounded schedule before
its published clock starts, so delayed replies cannot stretch a dense stroke through backpressure.
At most 2,112 input commands and reservations are owned at once; ordinary input retains its
64-command admission limit. Actions still await their replies before succeeding, and interruption
stops the unsent suffix and releases held input.

Typing sends key pairs for printable US characters in both plain and humanized modes; other text
uses Unicode insertion. A typed space or letter can press a focused button, toggle a box, follow a
link or change a select, so `type` refuses before any input when its `into` ref is not a text field
or, without `into`, when focus is on such a control; `press` sends keys to those. Humanized typing
aims for about 75 WPM including slower word starts, with key holds around 110 ms that can overlap.
The ordered schedule releases a repeated physical key before pressing it again. Keys follow that
schedule without waiting for each network reply. Pending replies are bounded and drained before an
action succeeds; interruption stops new input and releases every submitted held key. Shortcut chords
retain Playwright’s platform-specific editing behavior. Before each key, typing and repeated presses
check that the page is still in the document the action began in, and stop with a dispatched
`NotActionable` once it has moved on. The browser reports a new document as it commits, so a key
sent within about one protocol round trip of that commit can still reach it. Under a guard, typing's
submit Enter and each repeated Enter or Space are first checked against the approved element.

`Page.type(text, { prose: true })` opts eligible textarea or contenteditable prose into occasional
corrected slips when humanized, with an explicit `into` ref and whole-field replacement. The
`browser_type` tool exposes the same `prose` flag. It is off by default; explicit opt-in cannot enable
it for numbers, URLs, credentials, payment/order fields or other excluded targets. Eligibility is
decided once the field has focus, after its focus handlers ran, and its final text must match
before Enter can submit. Append and implicit-focus typing stay exact. Presentation pauses come
from bounded distributions and supplement the functional navigation delay and document wait; they
never shorten that wait.

`Browser.now`, event stamps, frame `receivedAt` and `Moment.at` share host monotonic milliseconds
from the clock captured when the browser is made. They remain ordered across wall-clock corrections.
Page operations also pace input and measure their deadlines on that clock, so a caller running
under another `Clock`, such as a `TestClock`, cannot stall an action or the browser-wide input lock.
Compare these stamps only within that clock: they are not epoch dates or comparable across hosts.
`Frame.timing` distinguishes `BrowserPaint` from `Screenshot`. Native frames retain browser epoch
milliseconds in `timestamp` and map them to `hostTime`, with an explicit clock uncertainty.
Screenshot fallbacks have only a host capture interval; their `timestamp` getter is undefined.
Moment windows and frame captions use `hostTime`, so delayed delivery cannot make old paint current.
A picture states how old it may be. `Page.frame({ maxAge, after })` serves the newest screencast
frame when it has the viewport's size and was painted at most `maxAge` ago, at the earliest its
timing allows: 250 ms by default, while 0 always takes a new screenshot. With `after: "input"` the
frame must also follow the page's latest submitted input, including input of an interrupted action,
while no action is changing the page: what a caller that has just acted needs. `Page.screenshot`
always applies that rule, so a caller that acts and then looks sees what its action did; a deck or a
narrator that wants a picture of a stated age reads `frame`. A screencast sends only changes and can
miss a final paint, so a frame is only ever as current as its age. No read reuses a frame painted
before the page's current document began, when the page's own session saw its main frame commit
it: a page that keeps painting while the next document loads would otherwise leave its own frames
the newest when the navigation returns. Otherwise a new screenshot is
taken, which `frame` returns as a `Screenshot`-timed frame. `observe` takes a screenshot and a
`Moment`'s last frame uses `after: "input"`, so a stopped capture, a lost final paint or later input
never presents older paint as the page an action left.

A new picture goes on the page's own protocol session. Where a device pixel is a CSS pixel and
nothing is cropped, it is one `Page.captureScreenshot`; a crop, or another device pixel ratio, adds
the page's layout metrics for Playwright's clip formula. Where Playwright knows no viewport, as in
the default context over CDP, the page's first picture also learns it. Where Playwright emulates the viewport, as `Chromium.layer` does, a crop or a
scaled picture is Playwright's own screenshot, on its own session: a clipped capture on another
session would clear that emulation when it restores its own. Such a picture sends Playwright's
335 KB injected script with a document's first one, as it would over CDP once a caller gives
Playwright a viewport. A crop on the page's own session, as on Browserbase, likewise clears a
screen size another session emulates, for the rest of the session: on Browserbase, `screen` went
from the session's 1280×720 to Chromium's default 800×600, while the viewport and the device pixel
ratio stayed as they were.

Reads go to the page script in an isolated world. The page's own session registers the script at the
library's first read of the page, so every later document runs it from its start: a document's
first read takes two round trips and later reads one. Tabs the library only tracks are left alone,
and the clock probe runs in a world of its own.
Every operation is recorded as an `Action`, also when its caller interrupts it. An element or point
action records its `subject`, and a drag where it ended (`to`): the role, accessible name, tag and
context of what it found, read as the input was sent, the same subject `Page.find` gives. A ref is
reused by later outlines, so read `subject` rather than resolving `target` against a later snapshot.

Every renderer reads the same host wall clock, so the browser keeps one clock mapping for all of its
pages. Opening a browser measures nothing: the browser's first capture measures the mapping, with
three read-only probes in a world of their own, and waits for that one estimate. A busy page answers
each probe late, behind its own work, so the probes it answered within two seconds serve: the
estimate is as uncertain as the page made the wait, and the capture fails, undispatched, only if
the page answered none. A later capture starts with the estimate there is. While frames flow, a
capture measures again once the estimate is ten seconds old, and every frame is timed by the
browser's newest estimate, so a wide first estimate narrows once a probe finds the page idle, and
hours on air leave frames as certain as a fresh capture's. An estimate says less about the offset
as it ages, by up to 100 parts per million of its age, and a frame carries its estimate's
uncertainty at its paint. A new measurement
replaces the estimate only if it says more about the offset than the aged one, or if its interval
cannot contain the current offset (the clocks moved); a probe slowed by one busy tab cannot skew
every tab's stamps. Transport asymmetry remains in the reported uncertainty.

Once a capture has mapped the clock, mouse input and raw text-key events carry the epoch time each
was meant for; until then Chromium stamps them as it receives them, and input never waits for a
measurement. Shortcut chords retain Playwright's platform behavior, and Unicode insertion has no
timestamp field.

`Page.captureStats()` counts, over the page's life or with `{ window }` over up to the latest
minute: received and accepted frames, missing timestamps, `late` frames (Chromium encodes several at
once and finished these after a newer one; they are dropped, never reordered, and a busy machine
makes more of them), frames dropped for their size (`foreignSize`) or for coming during one of the
library's own clipped pictures (`duringPictures`), frames a reader `lost` by falling behind, and
paint-time gap totals/minimum/maximum/last. `ackBacklog` is the acknowledgements still unanswered:
Chromium sends a frame only while few are, so a backlog over a slow connection means fewer frames.
Chromium draws a clipped or scaled screenshot of the page, taken
from any session, into its running screencast. Readers never receive a frame whose picture has
another shape than its device. Frames of another device size wait, in order: the page's own size
returning drops them, while the page reporting a viewport of their size, or their lasting a second,
delivers them as a real resize, so a page that cannot answer, or that measures in other units as
under browser zoom, is never stalled. `foreignSize` therefore also counts some of the page's own
frames: those of a new size still unconfirmed when another size replaced it, when the capture
stopped, or beyond the 16 held. The library's own clipped pictures are left out while they are
taken: from the picture's call until 50 ms after its reply, by when a frame arrived or by its paint
time widened by the clock's uncertainty either side. A crop on the page's own session, as over CDP
and on Browserbase, is drawn at the crop's own size, so there only frames of another size are left
out, and the page's own keep reaching readers. Where Playwright emulates the viewport, as
`Chromium.layer` does, a crop keeps the device's size, so every frame in that window is left out,
the page's own included: the capture pauses for the picture's round trip, plus 50 ms, plus twice
the clock's uncertainty, about 100 ms a zoom locally, and a crop with the viewport's own
proportions never reaches readers either. A clip someone else takes passes where Chromium keeps
the device's size during it and the clip has the viewport's proportions, and on a page that paints
nothing after it, a clip of any shape lasts long enough to pass for a resize.
Each page's own session holds focus emulation, so a tab behind another keeps painting and its
capture keeps delivering, whatever else is attached; a capture starts once the browser has
confirmed it, and fails with `Timeout` at the action timeout if a renderer stuck in a script never
does.
A provider that reaches its browser over a network can run captures on a connection of their own,
a `Browser.CaptureSource` given as `Cdp.Options.capture`, as `effect-browserbase` does: there a
frame never waits behind a large message on the connection that drives the page. Frames then carry
the document their own connection saw commit, numbered as `Navigated` numbers them, and a failure
of that connection ends the capture with `Failed` and leaves the page as it was.
Concurrent readers share one native screencast and its quality and size: a reader without options
joins whatever is running, and one whose explicit options differ fails with `InvalidRequest` rather
than silently receiving other frames. Each reader has a bounded 16-frame queue; a slow reader's
observed sequence gaps add to `lost`. Late subscribers do not count earlier history.
ACKs are independent of reader speed and bounded to 32 unresolved replies; exhaustion ends capture
with a typed error. `recentFrames` keeps the frames painted within `frameHistory` of the newest,
5 seconds by default, a moment's default window. Capture stops when its last
reader leaves; a stop whose reply is late is never resent, and the next capture waits for it (up
to 2 s per attempt) rather than disabling capture for the page.

A page's `id` is its CDP target id. A new connection to the same browser, as after a dropped one,
finds each page under the id it had, with `browser.page(id)`; a stored id the browser no longer
finds is a page that closed. `browser.pages` lists the open pages in the order the browser began
tracking them, and `browser.firstPage` gives the first, opening one when there is none.

A page's life is told on the browser's timeline. `PageOpened`; `Navigated` for every move of its
main frame, `sameDocument` for one within the document, such as `pushState`, with `document`
counting the page's documents from 0, the one it had when the browser began tracking it;
`PageLoaded` as a document finishes parsing and loading; `DialogShown`; and `PageClosed`, by the
page or because it crashed. A document count belongs to the page within one `Browser`, and starts
again on a new connection. Each frame carries the document it followed and the page's address. A
tab the site opened that the library could not track is `PageUntracked`. Chromium announces a
title change only with the next change of address, so there is no title event: read `page.title`
when `Navigated` or `PageLoaded` says the page moved.

The browser's own end is one `Disconnected`, and `browser.disconnected` completes with its cause:
`connection`, `session`, at or after the provider's `expiresAt`, which `SessionEnding` announces,
or `released`, by the owner's scope. A browser lost so publishes no `PageClosed` for its pages,
and calls in flight on them fail at once rather than at their deadline. A crashed page is closed:
Playwright drives it no more, and its calls would never return.

A failure on a page that is gone is `Closed` with its cause: `page`, `crashed`, or the browser's.
`BrowserError.consequence(error)` says what any failure leaves: what was `lost` (`nothing`, the
`page`, or the `session` with its pages), and whether to `repeat` the call: `safe`, as nothing
reached the browser; `check` its effect first, as it may have taken place; `pointless` as it is,
such as with a stale ref; or `resume` reading events from a newer cursor. `message` is a sentence
for operators, and the browser tools tell a model what to do about the failure.

Every address the library reports, in events, frames, reads, errors and a guard's request, keeps
its identity and loses its userinfo and the query and fragment parameters named for credentials:
tokens, keys, signatures, passwords, sessions, assertions and authorization codes. A chart's
`?ticker=ETH` stays.

`initScripts` take `{ match, source }`. The source runs before each new document's own scripts, in
every frame, or only where `match`, a `RegExp`, finds the document's address, as a block. Playwright
registers them as it sets each page up, so a popup's first document runs them too, at no call per
document.

`Browser.events()` streams `RecordedEvent` values: `{ sequence, event }`. The sequence orders
all browser events and is the replay cursor. Call `browser.events({ after: lastSequence })` to
resume, or use `after: 0` for everything since the browser opened if it is still retained. With
no cursor, streaming begins at subscription. `eventHistory` keeps a positive bounded number of
events (4,096 by default), also exposed without envelopes by `recentEvents`. A reader whose next
event has expired fails with `EventHistoryExpired`; it never skips events silently. Consume the
stream promptly and size retention for the consumer’s delay. Closing the browser scope wakes and
ends idle readers.

The presentation track uses the same channel. `TrackPlanned` publishes a whole glide before
input, with `from` and samples whose `afterMillis` are offsets from `at`. Its sequence identifies
the plan. `TrackPerformed` ends that plan, names it in `plan`, and records the number of samples
actually submitted plus the last submitted point. The consumer must trim the planned suffix to
that count after interruption or failure. `complete` means all samples were submitted; it does
not claim that the browser acknowledged or painted them.

`PointerPressed`, `PointerReleased`, `WheelScrolled`, `KeyChanged`, `TextInserted` and
`CursorChanged` describe the remaining input. Button, key and text events are published at
submission, including cleanup releases. Cursor shape comes from resolved target metadata.
`TrackEvent` is the schema union for these presentation events; `Moment` excludes them from its
narrative timeline. Compositing remains the consumer’s job.

The pointer starts at the first active viewport’s center and belongs to the browser across tabs.
Input actions share ownership of it, one at a time across tabs; navigation and a policy hold leave
that ownership free. An action first waits for its own page (another operation there, or its
unresolved input replies) and only then queues for the browser-wide turn, so one slow tab never
holds the others up. The action's timeout bounds those waits before a full timeout bounds the
action itself. Every sent
move updates the position, including a partially cancelled glide. A later viewport clamps the
starting point to its bounds if necessary.

`Supervisor.make` keeps a browser open across losses and session ends, as generations, each a new
browser from the provider's `open`. Opens run in the supervisor's own scope, so a caller that stops
waiting never interrupts a half-open browser. `browser` gives the current generation, waiting up to
`waitTimeout` while one opens. A lost browser is published at once, `Lost` with its browser's
`disconnected` cause, and the next one opens on the `reopen` schedule, which also retries a failed
open until it gives up, unless the provider deems the failure `definite`, such as a refused key:
then the generation is `Down` at once, with its cause, which `Unavailable` also gives anyone
waiting, because a schedule would only hide a configuration error. `rotate`, or the time
`rotateBefore` ahead of a generation's browser's `expiresAt`, opens the next generation before it
releases the current one, unless generations are `exclusive`: then the current one is released
first.
`retire` stops reopening at once and releases what is open; closing the scope retires too. `states`
streams each generation's `Opening`, `Reopening`, `Open`, `Lost`, `Down` and `Closed`, the last with
the provider's release outcome, `Settled` or `Unconfirmed`, so time open is a subtraction of their
stamps. Pages don't carry over from one generation to the next. `effect-browserbase`'s
`Browserbase.supervise` supervises hosted sessions.

Every module is also an entry point, such as `effect-browser/Agent`. The
[repository README](https://github.com/mannyc2/effect-agent-browserbase#readme) has examples.

## Tracing

Operations are spans in Effect's tracer, so an application that installs an exporter sees them in
its own traces; the library installs none. For the agent in the repository's README, with
`effect/observability` provided outermost so that opening the browser is traced too:

```ts
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { Otlp, OtlpSerialization } from "effect/observability";

// Exports to OTEL_EXPORTER_OTLP_ENDPOINT when OTEL_TRACES_EXPORTER=otlp is set.
const Observability = Otlp.layerFromConfig({ resource: { serviceName: "my-agent" } }).pipe(
  Layer.provide(OtlpSerialization.layerJson),
  Layer.provide(FetchHttpClient.layer),
);

program.pipe(
  Effect.provide([Chromium.layer(), Model]),
  Effect.provide(Observability),
  Effect.runPromise,
);
```

`Agent.run` carries OpenTelemetry's GenAI agent attributes, its steps and its token usage. Each step
is an `Agent.step` span around its model call (`effect/ai`'s `LanguageModel.generateText`, whose
provider request is its HTTP child), its tool calls and the observation after them. A tool call is a
`Tools.<name>` span with the GenAI tool attributes; `effect/ai` runs tool calls inside the model
call's span, so read a model call's own time from its HTTP child. Every page operation is a
`Page.<name>` span, such as `Page.click`, `Page.type` or `Page.navigate`, with what its `Action`
records except text: the target, the subject's role, name and tag, whether input was dispatched,
`queuedMillis` spent waiting for admission and the locks, and a failure's reason as `error.type`.
`Page.prepare`, the policy's preparation, and `Page.guard`, which lasts as long as a hold and holds
a judge's model call, are its children, as are pointer travel (`Page.move`) and the settle after input (`Page.settle`).
`Page.observe`, `Page.snapshot`, `Page.find`, `Page.text`, `Page.screenshot` and `Page.frame` (with
`source`: a reused screencast `frame` or a new `screenshot`), `Page.zoom`, `Page.ready` and the
other waits are spans, as are `Plan.replay` and `Plan.locate`, and so is each round trip to the
page's script (`Page.evaluate`) and its registration (`Page.register`). Each page span reports its cost on the page's own protocol session: `calls`,
`bytesOut` and `bytesIn` (their parameters and results as JSON) and `waitedMillis`, how long at
least one call awaited its reply. An operation inside another counts toward both. Calls Playwright
makes on its own sessions, such as navigation, are not counted. `Chromium.launch`, `Cdp.connect` and
`Browser.newPage` cover opening a browser; `Browserbase.open` records its session's id and region,
`Browserbase.release` a release and its outcome, and `Browserbase.holdContext` the wait for a
stored context another session writes to. `Page.calibrateClock` maps the browser's clock onto the
host's with three probes, each a `Page.evaluate` of `clock`, and records the fastest answered
probe's `roundTripMillis`: the round trip to the browser, plus any wait behind the page's own work.
One that runs alongside a capture shows its failure only there.

Spans never carry typed text. A tool span keeps a browser tool's parameters with `text` replaced by
`redacted`, and only the names of any other tool's parameters, which may hold anything; a script
round trip is named by its function alone. `Page.evaluate` spans are at `Trace` level and the phases
inside an action at `Debug`: set `Tracer.MinimumTraceLevel` to `"Info"` to keep only the coarser
spans.
