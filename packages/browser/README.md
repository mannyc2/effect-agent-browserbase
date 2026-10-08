# effect-browser

Browser automation for [Effect](https://effect.website) agents, over Playwright: page control, a
compact page outline for models, screencast frames, `effect/ai` browser tools, an agent loop, a
record of what visibly changed on a page, windows over a page's events, changes and frames, and
moments, an account in pictures and words of what a page showed and what changed on it.

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
| `Motion`       | A bounded pointer planner, as a value, and the tuned sigma-lognormal one             |
| `Presentation` | Input performed for viewers: a presenter, and its views of pages                     |
| `Stage`        | The source of a live output, switched between pages and stamped                      |
| `BrowserError` | Typed failures, whether input reached the page first, and what each leaves           |
| `Tools`        | The `effect/ai` browser tools, pinned to a page or following tabs, with receipts     |
| `Agent`        | A model with the tools, in a loop, until it reports an answer of the shape you asked |
| `Policy`       | Judges that read what an input means, and a guard that acts on them unattended       |
| `Change`       | What visibly changed on a page over a window, element by element                     |
| `Moment`       | A page's events, changes and frames over a window; a moment, laid out as a prompt    |
| `Plan`         | A walk recorded from a page's events, replayed on a fresh page by subject            |
| `Supervisor`   | A browser kept open across losses and session ends, as generations                   |

`Agent.run` batches each turn's tool calls in order, halting on the first failure or a completed
`done` / `give_up`. Skipped calls receive a not-executed result. A malformed `done` answer can
be corrected on the next turn. A response whose model output cannot be read, one calling a tool
that does not exist or with arguments that are not JSON, runs none of its calls: the model is told
so, and the turn counts as a step. `onStep` reports it with `rejected` set. A reply that the
provider's client cannot decode is not the model's to correct and ends the run with its `AiError`.

`Agent.run` fails with `AgentError | AiError | BrowserError | E`: how the agent ended (`StepLimit`,
`GaveUp` or `Refused`), with what it spent and its whole conversation, the model's provider, the
browser, or `E`, what `onStep` fails with. A tool's failure goes back to the model rather than
ending the run. The run takes its page, or a browser whose tabs its tools follow, as a value, and
needs a `LanguageModel` and whatever `onStep` and `observe` use.

The model gets an outline and a screenshot at the start and after each turn that does not end the
run. `observe` replaces that with any function of the page; `Agent.observe("outline")`,
`Agent.observe("screenshot")` and `Agent.observe("both")`, the default, read what they can and name
what they could not, failing only when nothing could be read. When the page cannot be observed,
the model is told why and the run goes on; when the browser is gone, or a pinned page, the run
fails with that `BrowserError` instead of calling the model again. The turn before it is still
reported to `onStep`, and an answer it gave with `done` is still returned. `system` makes the
system prompt from the standard one. `tools` makes the run's tools from the default ones: it gets
them with their handlers, which a caller wraps, renames under tools of its own (`Tool.make` with
the default's schemas) or drops, and returns a toolkit and its handlers, its own tools' included.

Each call answers with a `Tools.Receipt`: what it did and, for an action, what followed on its page
while it ran, from the page's events and one read of its changes: the `Action` it recorded, the
dialogs that opened and how each was answered (an alert accepted, a confirm dismissed), where the
page went, the tabs it opened and what changed, with what could not be read in `missing`. The
model is told it as text, up to three of the changes the action's input caused; `onStep` and
`generateText`'s tool results hold the value. A failure is the call's `BrowserError`, told to the
model with what it leaves: a tab gone, a stale ref, an action that may have taken effect, or a page
busy with other work. The actions a call performs record the model's call id as their
`correlation`; `Page.correlate(id)` does the same for any effect.

`Tools.make({ page })` pins the tools to a page. `Tools.make({ browser, follow })` adds
`browser_tabs`, and its calls act on the tab the model last saw: a tab that opens meanwhile is
shown at the next look of `tools.page` as `follow` says, `"select"` (the default) without bringing
it to front, `"front"` bringing it to front, `"never"` not at all. After `browser_tabs` switches,
reads see the new tab and actions wait until it is seen. A caller writing its own loop spreads a
fresh `yield* tools.batch` into each `generateText` call: it carries the toolkit with the same
ordered, halting execution and the `concurrency: 1` that `effect/ai` needs to keep calls in order.
`Tools.batch` does the same for any toolkit with handlers. After the batch, the caller observes
`tools.page`, with the crops the receipts hold.

Each page operation is one contract: its parameters, its receipt and `BrowserError` as schemas,
and one handler. The tools are made from it, and so are `Tools.on(page)`, the operations bound to
a page, and `Tools.PageRpcs`, an `effect/rpc` group of them. A program that runs the browser in one
process and the model in another serves `PageRpcs.toLayer(Tools.on(page))` and calls it from the
other, where the receipts and failures arrive as they left.

`browser_zoom` captures a region in viewport CSS pixels when the tool runs; its receipt holds the
crop, which the agent shows with the next observation whatever it observes, labeled with its
viewport origin, and its tab's number where the tools follow tabs. At most eight crops follow a
batch. `Page.zoom` exposes the same capture as a `Zoom` schema value with `region` and `image`;
crop pixel coordinates need the region's origin added before using them as click coordinates.

`Page.click` returns a `ResolvedTarget` captured before input: the requested point, element label,
role, accessible name, context, cursor and link target. Pixel targeting resolves through the page
script and keeps the original point; the receipt names the control even when a nested child
received the hit. Refs inside same-origin frames are measured, scrolled and checked for cover in the
top viewport. A ref that no longer names an element of the current documents, including one in a
frame that has since navigated, fails with `StaleRef` naming that ref, with or without a guard.

A subject names an element durably: its role, accessible name and tag, and its context, the words
around it that say which one it is. In a table, `row` is the row's header, or else its first cell
with letters, so a rank or a price never names it, and `column` is the header over it, spanned cells
counted; elsewhere, `label` is the words just before it in its row, item, group or block. `heading`
is the nearest heading above it, left out for what is pinned to the viewport. The page binds each to
the element, so a value is never read under another column's header.

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
always does: a password, a one-time code or a card field, one whose style shows dots for what it
holds, as a PIN field's may, and one that was secret when the library saw it, such as a password
its page now reveals. The outline shows what fields hold, as the agent needs, but masks a secret
field the same way.

Reading the viewport, the outline, `find` and `text` skip a subtree whose box lies outside it before
styling anything in it, so a long table costs only its rows in view. A box says nothing of what is
positioned out of it, so a subtree is kept when its box is empty; when it holds what is painted at
the viewport's edges, corners or middle, beneath any transparent layer too, or in its top layer; or
when it holds what its style attribute pins in view. Something a stylesheet pins inside a subtree
out of view, away from those points or ignoring the pointer, is missed. The outline's `above` and
`below` count the parts skipped, each an element out of view with all it holds.

`Page.ready` waits until a page is ready to be shown, in one call that checks in the page until it
is, or until the time is up: its document is parsed and has painted since, nothing that ends is
animating in view, its fonts and the images in view have loaded, nothing in view is marked busy
(`aria-busy`), and the viewport shows something: text, a canvas drawn on, a picture or drawing
larger than an icon, a video or a frame. A canvas mounted blank, as chart libraries mount theirs,
or a spinner alone is still loading. A screen that only says "Loading…" in words reads as ready,
and a WebGL canvas drawn once, without keeping its drawing, reads as blank. A hidden tab, which
paints nothing, is never ready.

With `quietMillis`, the screen must then also stay still that long: no screencast frame comes,
counted from the first frame of a capture the wait starts itself, since a hosted browser sends that
frame over half a second late. A capture's silence alone proves little: a stalled connection holds
frames on their way, and Chromium sends frames only while few acknowledgements are unanswered. So
the spell counts only while every acknowledgement is answered, and it ends with one more call to the
page, whose answer arrives behind every frame sent before it; a frame that comes first starts the
spell again. That call costs the wait one round trip. A capture on a connection of its own, as on
Browserbase, gets one round trip there too, beside the call, since frames there do not wait behind
the page's calls: a 4 fps canvas whose capture connection stalled for a frame read as still in 2
of 2 waits before, and in none since. Where the page's changes are recorded, the
page's own check also waits until nothing in view has changed for the spell, so frames the browser
holds back, as an encoder's backlog does, cannot pass for a still page. Stillness is a heuristic
on a canvas: a canvas that keeps drawing, such as a live chart, is never still, and one that pauses
longer than `quietMillis` between phases reads as still. On the slot machine fixture, with the
connection stalled for 450 to 900 ms toward either end while the reels spun, none of 132 waits
ended early, where all 36 did before.

`Page.changes({ since, until })` says what visibly changed on a page over a window, in one call to
the page, element by element, as a `Change`: text that changed, appeared, disappeared or came and
went (`brief`), a field's value, or the title. Each says what it showed at the window's start and
end, how often that changed, the lowest and highest of a number that changed more than once, when
it last changed before the window, so news stands apart from what keeps changing, and its
`subject` with the context that binds it: a price under its row and column. A field's value reads
`••••` unless `unmask` is set, and a secret field's always does. A change names its `cause`, the
trusted input it followed, only where it was that input's doing. It must not have been in flux: in
the 10 s before the input it had not changed, and nothing had come into or left what it sits in, so
a ticker's next tick or a feed's next line names no click. Then it changed within 3 s inside what
the input acted on or its row, form, dialog or controlled element, so "Order placed" a server's
reply later keeps its click; or elsewhere within 500 ms, on a page where nothing had changed in the
2 s before the input, so a menu a portal puts at the end of the page keeps its click, and a chat
line beside a ticking board does not. What holds the input's target, as a menu holds its item, does
not count against it. Against inert clicks on boards whose 2 to 20 cells tick every 0.25 to 6 s,
the rule credited none of 401 ticks and none of 96 chat lines, where a second's quiet on the element
and 500 ms anywhere had credited about half the ticks of the slower boards and every chat line.
What a busy page costs is the credit for an effect out of a click's reach, which a moment then
tells as a step; on a still page, an unrelated line 250 ms after a click is still credited.

A page records once something reads its changes: the first read starts it, and finds nothing yet.
From then the page's own session starts the recorder at the start of each later document, once it
is parsed, until nobody has read it for two minutes; a page nobody reads records nothing and costs
nothing. The first read also registers the recorder, in the same round trip, and every later read
is one call. A browser whose clock no capture has mapped yet maps it on its first read of changes,
once, in four round trips more. While it runs, a MutationObserver marks what changed: a text-only
element, as most prices are, is read at once, and anything else, with whether it was in view, as
the page renders it, through an IntersectionObserver that forces no layout. A change counts as seen
when it was in the viewport as the page rendered it, its style showing it, so one scrolled away
later is still told, and something removed or hidden only if it was in view before. On a
2,000-cell table rewritten every 50 ms, locally, the page's busy time went from about 100 ms per
3 s to about 230 recording, where an empty observer costs about 180.

The record keeps 256 elements with their last 32 changes, for a minute. On a busier page, an
element that keeps changing gives way first, then one never seen in view, then one that has gone,
so news stays; whatever gives way, or finds no room, is counted in `dropped`, and `from` moves
past it: the record never claims to be whole where it is not. A window can start at a previous
read's `Changes`, continuing exactly where it ended on the page's own clock, or at a frame's
paint, and end at a frame's paint, so a narrator airing a frame late is told nothing that frame
does not show. Times are host milliseconds through the browser's one clock mapping, as frames'
are. The record does not see pictures, a canvas, frames, shadow roots or SVG, a value a script
sets, or a class that reveals an element it has not seen before, such as a toast already on the
page, though its later changes it does.

A page's timeline has three tracks on the browser's host clock: its events, what changed on it,
and its frames. `page.window({ since, until })` reads them over a window, a `Moment.Window`: the
events and frames the page keeps, at no call, and its changes, in one call, the first starting its
record as any read of changes does. `since` is a previous window, to go on exactly where it ended, a
frame, a host time, or a `Duration` back from `until`; `until` is a frame or a host time, now by
default. A consumer that airs a frame seconds after it was painted reads the window that ends at
that frame, so that a line it writes now tells what its viewers will see. A part that cannot be
read is in `missing`, with why: a window fails only for bounds that are not finite, or a negative
reach back.
`Moment.stillness(window)` says how long the page had been still at the window's end, by the last
change in view its record shows or the last paint among its screencast frames; a screenshot shows
the page, not when it changed. Frames show paint only while a capture runs, and the record does
not see a canvas, so a canvas that draws with no capture running reads as still. A wait for a still
screen is `Page.ready({ quietMillis })`, which also holds through a stalled connection.

`Moment.capture` is a window that ends at a picture of the page now. It takes the picture first,
then the window up to its paint, from where a previous window or moment ended, so the changes hold
nothing the picture does not show. A picture, a read of changes or an outline that cannot be had is
missing from the moment, with why, and the moment is still made. `Moment.toPrompt` leads with what
changed: news first, then what keeps changing, with the cells of a column that changed together on
one line. It names an action as what a change followed, or as a step: where changes followed it but
none names it, as when its effect landed out of its reach on a busy page; where its effect is drawn,
such as a click on a canvas, which only the screenshots show; or where it came before the record
began. Hovers, scrolls and attempts that nothing followed are left out, and a failed action is told
only as failed: its error is advice to the caller that acted, and may name a ref. A moment whose
record saw none of its window, as a page's first, whose read starts the record, says that what
changed was not recorded and lists every step instead; one whose record began within the window
says nothing changed only after that. What it could not read, it names, with why, and a last frame
that is not the picture is not shown as the moment.

`Plan` rehearses a walk once and replays it later, near live, with no model call.
`Plan.fromEvents(page.recentEvents)` keeps one page's completed actions with their subjects and
the options they were given, its navigations with the address asked for and the one reached, and
what was typed as an input slot named for its field, never the text itself. A navigation to an
address with a credential withheld is an input slot too, `address`, so replay goes where the caller
says, never to the address without its credential. `Plan.replay(page,
plan, { inputs })` takes the steps in turn: before each that acts, it waits for `Page.ready`
(`settle` sets how, or `false` not to wait), finds the one element the step's subject names with
`Plan.locate`, and acts on it. An element that does not repeat every part of the recorded context
is another subject: its row read whole, so a row named "Wrapped BTC" is not the row "BTC" (laid out
again without rows, as cards, one of its fields must start with the row's words), its column where
it is under one, and its label and heading read the same or found as words in order. So the one
element left once the recorded one has gone, such as Alice's "Remove" after Bob's, drifts rather
than stands in. The rest rank by how much they read the same; a tie is `Ambiguous`, since there is
no ordinal. Text typed into whatever had focus went into the focused field, which the action
records as its subject, so replay types into that field wherever focus has gone; and text first
typed into a secret field is typed only into one. An element step never falls back to coordinates.
A step recorded at a point presses the same place within the element found, brought into view
first, and only when a press there reaches that element, not something over it. Replay stops at
the first step it cannot take, with a `ReplayError` naming the step and why: `Missing`,
`Ambiguous`, `Drifted` (nothing with the subject's role and name repeats its context, or the walk
ended on another site), or the step's `BrowserError`. Nothing is replayed automatically, and a plan
of another version does not decode.

A caller's own tools go in the set `tools` returns, and their calls share the batch's halt
behavior. `done` and `give_up` end the run and stay the agent's own: a set that names either does
not type-check. A failure of a tool with failure mode `"error"` reaches the model encoded by that
tool's failure schema and marked as possibly effective; a call whose parameters fail validation
never reaches its handler and answers as not executed.

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
have run. Typing approves its field once. Plain text then goes into it in one insertion, which no
key handler can split, so the page sees one `input` event and no keys, and a paste's time does not
grow with its length: 2,000 characters took half a second at a 70 ms round trip. Typing key by key,
as a presenter's view does, checks that the approved control still has focus once the keys before
are answered, before each space, which could press a focused button, and after its last key, so a
key handler that moves focus stops the typing before its next space; each check is about two
protocol round trips, and the typing deadline allows 250 ms for it. A policy timeout is a typed `PolicyTimeout`, and tools surface both timeout and denial as ordinary failed
receipts. Without a guard, actions are allowed and nothing is revalidated. Canvas and opaque frames
expose their outer element's metadata.

A presenter's view reaches an off-screen ref target with visible wheel input before the pointer
moves to it. Scroll attempts are bounded and may use one instant fallback. A denied or held action
does not scroll. After scrolling, a guarded action checks the original target again; a page handler
that changes its meaning can therefore stop it after its wheel input but before a click, and the
failure is undispatched: travel toward a press is not the action's input. Drag endpoints are
resolved together in the final viewport, and checked under the pointer, before the button is
pressed.

A view's pointer follows the planner its presenter was given, `Motion.lognormal` unless another.
That tuned two-stroke sigma-lognormal model is evaluated every 16.7 ms, but a move goes only when
the pointer reaches a new pixel; the exact destination lands at the model's end time, so only that
final move can repeat the position before it. A custom `plan(from, to)` returns a complete
schedule with finite coordinates and nondecreasing absolute `afterMillis` offsets, at most 2,048
samples and 5,000 milliseconds, ending at the exact destination. The browser decodes it with
`Motion.Plan` into its own copy, then checks the endpoint; invalid plans fail with
`InvalidRequest` before their track or input is sent. Equal-time samples are retained. Plain input
never plans a glide: its pointer jumps, or moves in eight short steps while dragging.

For recorded human strokes, install the optional `effect-browser-human-strokes` package and give
its planner to the presenter:

```ts
import * as HumanStrokes from "effect-browser-human-strokes";
import * as Presentation from "effect-browser/Presentation";

const presenter = yield * Presentation.make({ motion: yield * HumanStrokes.motion });
```

That package bundles 32,130 attributed CC BY 4.0 strokes, preserving their original sample times.
The core package includes no stroke data. Every glide reserves its full bounded schedule before
its published clock starts, so delayed replies cannot stretch a dense stroke through backpressure.
At most 2,112 input commands and reservations are owned at once; ordinary input retains its
64-command admission limit. Actions still await their replies before succeeding, and interruption
stops the unsent suffix and releases held input.

Typing sends key pairs for printable US characters, plainly and in a view; other text uses
Unicode insertion. A typed space or letter can press a focused button, toggle a box, follow a
link or change a select, so `type` refuses before any input when its `into` ref is not a text field
or, without `into`, when focus is on such a control; `press` sends keys to those. With `secret`,
`type` also refuses a field the page does not mark secret, so a password goes only where the page
hides it, as a replayed password does. A view types at its pacing's words a minute, 70 by
default, including slower word starts, with key holds around 110 ms that can overlap. The ordered schedule releases a repeated
physical key before pressing it again. Keys follow that schedule without waiting for each network
reply. Pending replies are bounded and drained before an action succeeds; interruption stops new
input and releases every submitted held key. Shortcut chords retain Playwright’s platform-specific
editing behavior. Before each key, typing and repeated presses check that the page is still in the
document the action began in, and stop with a dispatched `NotActionable` once it has moved on. The
browser reports a new document as it commits, so a key sent within about one protocol round trip of
that commit can still reach it. Under a guard, typing's submit Enter and each repeated Enter or
Space are first checked against the approved element.

After a click, a key, a submit or a scroll, the page settles before the action returns: one call
waits a task and a frame in the page, and Chromium answers it only once a navigation the input
asked for, by a link, a form or a handler's timer, has committed. A document that committed is then
waited for until it is parsed, within 5 seconds. `pushState` and a 204 answer wait for nothing. A
navigation a handler starts once a fetch answers comes too late for any wait; the next look sees
it, and a picture never shows a document the page has left.

## Presenting pages

`Presentation` performs input for viewers of a page, and `Stage` decides which page they see.

```ts
import { Effect, Stream } from "effect";
import { Browser } from "effect-browser/Browser";
import type { Frame } from "effect-browser/Frame";
import * as Presentation from "effect-browser/Presentation";
import * as Stage from "effect-browser/Stage";

declare const encode: (frame: Frame) => Effect.Effect<void>; // the application's own output

const program = Effect.gen(function* () {
  const stage = yield* Stage.make({ quality: 80 });
  const presenter = yield* Presentation.make();
  const page = yield* (yield* Browser).newPage("https://example.com");
  const shown = yield* stage.present(page); // Presented { page, at, latency }

  yield* stage.frames.pipe(Stream.runForEach(encode), Effect.forkScoped);
  yield* presenter.view(page).click("e12"); // glides, then clicks, as a person would
});
```

A presenter owns one drawn pointer. `presenter.view(page)` is the page with its actions performed:
each waits first as a person reacts, by `Presentation.human`'s medians, 280 ms after an expected
change, 600 ms after a new document and 1 second on another page; the pointer glides from where
viewers last saw it, on whichever page; a field is clicked before typing; and the wheel turns in
100 px notches, in bursts of up to nine. One view acts at a time. The time a view spends showing an
action, its glides, holds and typing, has a budget of its own outside `actionTimeout`. `page`
itself stays plain, and plain input on any page never waits for a view. `view.aim(target)` starts
the glide as soon as a target is known, as when it appears in a model's streamed tool call; the
view's next action completes it if it acts on that target, and stops it where it is otherwise. An
aim records no action, and does nothing under an input guard.

A stage is one per live output. `present(page, { at })` switches it at `at`, host monotonic
milliseconds on the frame clock, or at once: it starts the new page's capture ahead, waits for its
first frame, then for input already under way on the old page, and turns, stopping the old capture
after. The captures overlap, within a session as across two: on Browserbase, two captures in one
session ran together at the frame rate of one, where stopping first left 250 to 295 ms dark.
`Presented.at` is when the switch took effect, no earlier than the frames it followed or the new
page's first, and `latency` how long after `at`. A first frame that does not come in time fails
`present` with `Timeout`, and the old page stays. A capture that fails restarts on its page while the
page and its browser stand. A still page sends no frames until it changes, so a switch's first frame
can be older than the frames before it. A delay line, a liveness rule, redaction and repeating a
held frame stay the application's.

`Browser.now`, event stamps, frame `receivedAt` and a window's bounds share host monotonic milliseconds
from the clock captured when the browser is made. They remain ordered across wall-clock corrections.
Page operations also pace input and measure their deadlines on that clock, so a caller running
under another `Clock`, such as a `TestClock`, cannot stall an action or a page's turns.
Compare these stamps only within that clock: they are not epoch dates or comparable across hosts.
`Frame.timing` distinguishes `BrowserPaint` from `Screenshot`. Native frames retain browser epoch
milliseconds in `timestamp` and map them to `hostTime`, with an explicit clock uncertainty.
Screenshot fallbacks have only a host capture interval; their `timestamp` getter is undefined.
Windows and a moment's frame captions use `hostTime`, so delayed delivery cannot make old paint current.
A picture states how old it may be. `Page.frame({ maxAge, after })` serves the newest screencast
frame when it has the viewport's size and was painted at most `maxAge` ago, at the earliest its
timing allows: 250 ms by default, while 0 always takes a new screenshot. With `after: "input"` the
frame must also follow the page's latest submitted input, including input of an interrupted action,
and the read waits for the action in flight: what a caller that has just acted needs.
`Page.screenshot` always applies that rule, so a caller that acts and then looks sees what its
action did; a deck or a narrator that wants a picture of a stated age reads `frame`, which a frame
that qualifies serves at once, even while an action runs. A screencast sends only changes and can
miss a final paint, so a frame is only ever as current as its age. No read reuses a frame painted
before the page's current document began, when the page's own session saw its main frame commit
it: a page that keeps painting while the next document loads would otherwise leave its own frames
the newest when the navigation returns. Otherwise a new screenshot is
taken, which `frame` returns as a `Screenshot`-timed frame. A screenshot, which the agent's
observations take, and a `Moment`'s picture use `after: "input"`, so a stopped capture, a lost
final paint or later input never presents older paint as the page an action left.

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
`PageLoaded` as a document finishes parsing and loading, as the page's own session hears it, so
after the `Navigated` that began the document; `DialogShown`; and `PageClosed`, by the
page or because it crashed. A document count belongs to the page within one `Browser`, and starts
again on a new connection. Each frame carries the document it followed and the page's address. A
tab the site opened that the library could not track is `PageUntracked`. A tab a page opened names
it as its `opener`, and the opener's events hold its opening. Chromium announces a title change
only with the next change of address, so there is no title event: read `page.title` when
`Navigated` or `PageLoaded` says the page moved. The browser answers it, in one call that a busy
page cannot hold up, and an untitled page's is empty. `page.url` is where the page's own session
saw its main frame commit or move, as `page.state.url`.

The browser's own end is one `Disconnected`, and `browser.disconnected` completes with its cause:
`connection`, `session`, at or after the provider's `expiresAt`, which `SessionEnding` announces,
or `released`, by the owner's scope. A browser lost so publishes no `PageClosed` for its pages,
and calls in flight on them fail at once rather than at their deadline. A screencast's readers are
told as the page's scope closes, once that cause is known: a capture that fails first, as one on a
connection of its own can, waits up to two seconds for it before it fails as itself. A crashed page
is closed: Playwright drives it no more, and its calls would never return.

A failure on a page that is gone is `Closed` with its cause: `page`, `crashed`, or the browser's.
`BrowserError.consequence(error)` says what any failure leaves: what was `lost` (`nothing`, the
`page`, or the `session` with its pages), and whether to `repeat` the call: `safe`, as nothing
reached the browser; `check` its effect first, as it may have taken place; `pointless` as it is,
such as with a stale ref; or `resume` reading events from a newer cursor. `message` is a sentence
for operators, and the browser tools tell a model what to do about the failure.

Every address the library reports, in events, frames, reads, errors, a guard's request and the
outline's links, keeps its identity and loses its userinfo and its credentials' values, which read
`Page.redacted`. A credential is a query, fragment or path parameter named for a token, secret,
password, signature, assertion, session id or one-time code, or for a code or key that signs
someone in, such as `verification_code` or `api_key`. `code`, `key`, `session`, `sid` and `ticket`
as often name what a page shows, so under them only a value that looks generated, of at least 16
characters with letters and digits, is one. A chart's `?ticker=ETH` and a quote's `?code=BTC`
stay; a short one-time code under a bare `code` stays too.

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
`TrackEvent` is the schema union for these presentation events; a window leaves them out of its
events. Compositing remains the consumer’s job.

A page waits only for itself. Its operations take turns in one lane of its own: an action, which
sends input or navigates, has the page to itself, in the order actions were asked; reads (the
outline, `find`, `text`, `changes`, pictures, zooms, `title` and the viewport) share it, after the action in
flight and every action asked before them, so a read describes the page an action left, never one
an action is still changing. `ready` follows the action in flight too, and holds none back while it
watches. An action then waits for its page's unresolved input replies. Its timeout bounds those
waits before a full timeout bounds the action itself: a turn not given in time fails `Busy`, with
how long it waited and how many operations were ahead, and replies not answered in time fail
`Timeout`, as for a page that does not answer. `Page.failFast(effect)` runs operations that fail
`Busy` at once instead of waiting. A policy hold leaves the page's turn free.

Reads keep their work. An identical read asked while one is in flight on the page, with no action
asked between them, joins it, and costs no call of its own. Each read runs in the page's scope under
the action timeout whoever gives up, so a caller's own `Effect.timeout` loses nothing: a read that
ends after all its callers gave up serves the next caller to ask the same within an action timeout,
unless an action or a new document came first. An action stops the reads nobody awaits rather than
wait for them. Pictures and `changes` only join: a picture's caller says how old it may be, and a
window of changes ends as it is read.

`page.state` is what the library already knows of a page, at no call and with no wait for its
turn: where its main frame is, its document and when it was committed, how far that document has
loaded, its newest screencast frame, and the viewport's text and title as last read in that
document, each with when it was learned, so a caller reads their ages. A caller that must never
wait, such as one reading the screen on air, reads it rather than polling the page. Chromium
announces no title change, so the title is as a read of the text last found it.

`Browser.Options.maxPages` bounds the pages a browser keeps open, those a site opened included,
which are never refused: at the limit, `newPage` waits within the action timeout for one to close,
then fails `Limit`, or fails at once under `Page.failFast`.

Each page has its own pointer, where its last move left it, which is also where Chromium has it:
its first glide starts mid-viewport, and each later one where the one before ended, whatever
input on another tab does meanwhile. Every sent move updates the position, including a partially
cancelled glide. A later viewport clamps the starting point to its bounds if necessary.

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
`retire` stops reopening at once and releases what is open, asking the provider's `release` before
it closes a generation's scope; closing the scope retires too, unless the supervisor `keep`s: then
the generation serving is left running, `Kept`, its scope closed but its provider never asked to
release it, for a provider whose scope only disconnects. `states` streams each generation's
`Opening`, `Reopening`, `Open`, `Lost`, `Down`, `Closed`, the last with the provider's release
outcome, `Settled` or `Unconfirmed`, and `Kept`, so time open is a subtraction of their stamps.
Pages don't carry over from one generation to the next. `effect-browserbase`'s
`Browserbase.supervise` supervises hosted sessions, and with `keep` adopts the one it kept.

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
`queuedMillis` spent waiting for its turn and the page's replies, and a failure's reason as
`error.type`. A read that shared another's work says so in `shared`: `joined` or `kept`.
`Page.prepare`, the policy's preparation, and `Page.guard`, which lasts as long as a hold and holds
a judge's model call, are its children, as are pointer travel (`Page.move`) and the settle after input (`Page.settle`).
`Page.snapshot`, `Page.find`, `Page.text`, `Page.title`, `Page.viewport`,
`Page.screenshot` and `Page.frame` (with
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
