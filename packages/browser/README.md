# effect-browser

Browser automation for [Effect](https://effect.website) agents, over Playwright: page control, a
compact page outline for models, screencast frames, `effect/ai` browser tools, an agent loop, and
moments, a picture-and-timeline account of what a page showed at one point in time.

```sh
npm install effect-browser effect playwright-core
npx playwright-core install chromium
```

| Module         | What it holds                                                                        |
| -------------- | ------------------------------------------------------------------------------------ |
| `Browser`      | The `Browser` service: tabs, recent events and the Playwright context                |
| `Chromium`     | A local Chromium as a `Browser` layer                                                |
| `Cdp`          | Any DevTools endpoint as a `Browser` layer                                           |
| `Page`         | One tab: navigation, snapshots, screenshots, input, waits and the screencast         |
| `Snapshot`     | The model-readable outline of a page, with refs for its controls                     |
| `Frame`        | A screencast frame                                                                   |
| `BrowserEvent` | Actions, navigations, tabs, dialogs and pointer motion, as they happen               |
| `Motion`       | The replaceable, bounded pointer planner, with a tuned sigma-lognormal default       |
| `BrowserError` | Typed failures, saying whether input reached the page before the failure             |
| `Tools`        | The `effect/ai` browser toolkit                                                      |
| `Agent`        | A model with the tools, in a loop, until it reports an answer of the shape you asked |
| `Moment`       | Capture what a page showed around a point in time, and describe it in one model call |

`Agent.run` batches each turn's tool calls in order, halting on the first failure or a completed
`done` / `give_up`. Skipped calls receive a not-executed result. A malformed `done` answer can
be corrected on the next turn. A response `effect/ai` cannot read, usually one calling a tool that
does not exist, runs none of its calls: the model is told so and given the tool names, and the
turn counts as a step. `onStep` reports it with `rejected` set.

The model gets one outline and screenshot at the start and after each turn. `observation` selects
`"outline"`, `"screenshot"`, or `"both"` (the default). When the current page cannot be observed,
the model is told why and the run goes on; when no page can be had at all, as after the browser
closed, the run fails with that `BrowserError` instead of calling the model again. `Page.observe` returns that observation as
a schema value. `Tools.make` returns receipts. A caller writing its own loop spreads a fresh
`yield* tools.batch` into each `generateText` call: it carries the toolkit with the same ordered,
halting execution and the `concurrency: 1` that `effect/ai` needs to keep calls in order.
`Tools.batch` does the same for any toolkit with handlers. After the batch, the caller observes
the current `tools.page` and drains `tools.takeZooms` into that same observation message.

`browser_zoom` captures a region in viewport CSS pixels when the tool runs. Requested crops arrive
with the next observation even in outline mode, labeled with their source page and viewport origin.
At most eight crops may await an observation. `Page.zoom` exposes the same capture as a `Zoom`
schema value with `region` and `image`; crop pixel coordinates need the region's origin added before
using them as click coordinates.

`Page.click` returns a `ResolvedTarget` captured before input: the requested point, element label,
role, accessible name, cursor and link target. Pixel targeting resolves through the page script and
keeps the original point; the receipt names the control even when a nested child received the hit.
Refs inside same-origin frames are measured, scrolled and checked for cover in the top viewport.

Add a caller's toolkit with `additionalTools` and provide its handler layer to the run. It is
merged after the browser tools, so the caller's tool wins a name clash with one, and its calls
share the batch's halt behavior. `done` and `give_up` end the run and stay the agent's own: a
toolkit that names either does not type-check.
A failure of a tool with failure mode `"error"` reaches the model encoded by that tool's failure
schema and marked as possibly effective; a call whose parameters fail validation never reaches its
handler and answers as not executed.

`Browser.Options.guard` is the input policy. Its `InputRequest` schema contains the action,
resolved element and inferred `classifications`: `form-submit`, `purchase`, `delete`, `confirm`,
`cross-origin`, `download` and `upload`. More than one may apply. `point` is present for literal
pixel targets; a ref's coordinates are resolved after approval so preparation never scrolls.
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
    request.classifications.includes("purchase")
      ? Effect.fail(new PolicyDenied({ detail: "Purchases are disabled." }))
      : Effect.void,
});
```

Holds use `policyTimeout`, a finite positive duration defaulting to five minutes, separately from
the action timeout. They do not keep the page locked. After approval, the library verifies the
same document, target and relevant facts before sending input. Changed targets fail undispatched;
the library never retries the action or the policy automatically. A pointer press is checked again
once the pointer has arrived and the page has had a frame to react: the approved control must still
receive the press point, so a control that appears under the pointer, such as a hover menu, stops
the action before the button goes down. A policy timeout is a typed
`PolicyTimeout`, and tools surface both timeout and denial as ordinary failed receipts. Without a
guard, actions are allowed. Canvas and opaque frames expose their outer element's metadata.

With `humanize`, off-screen ref targets are reached with visible wheel input before the pointer
moves to them. Scroll attempts are bounded and may use one instant fallback. A denied or held action
does not scroll. After scrolling, the library checks the original target again; a page handler that
changes its meaning can therefore stop an action after its wheel input but before a click. Drag
endpoints are resolved together in the final viewport, and checked under the pointer, before the
button is pressed.

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
import * as Chromium from "effect-browser/Chromium";
import * as HumanStrokes from "effect-browser-human-strokes";

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
uses Unicode insertion. Humanized typing aims for about 75 WPM including slower word starts, with
key holds around 110 ms that can overlap. The ordered schedule releases a repeated physical key
before pressing it again. Keys follow that schedule without waiting for each network reply.
Pending replies are bounded and drained before an action succeeds; interruption stops new input and
releases every submitted held key. Shortcut chords retain Playwright’s platform-specific editing behavior.

`Page.type(text, { prose: true })` opts eligible textarea or contenteditable prose into occasional
corrected slips when humanized, with an explicit `into` ref and whole-field replacement. The
`browser_type` tool exposes the same `prose` flag. It is off by default; explicit opt-in cannot enable
it for numbers, URLs, credentials, payment/order fields or other excluded targets. The field is
checked again after focus, and its final text must match before Enter can submit. Append and
implicit-focus typing stay exact. Presentation pauses come from bounded distributions and
supplement the functional navigation delay and document wait; they never shorten that wait.

`Browser.now`, event stamps, frame `receivedAt` and `Moment.at` share host monotonic milliseconds
from the clock captured when the browser is made. They remain ordered across wall-clock corrections.
Page operations also pace input and measure their deadlines on that clock, so a caller running
under another `Clock`, such as a `TestClock`, cannot stall an action or the browser-wide input lock.
Compare these stamps only within that clock: they are not epoch dates or comparable across hosts.
`Frame.timing` distinguishes `BrowserPaint` from `Screenshot`. Native frames retain browser epoch
milliseconds in `timestamp` and map them to `hostTime`, with an explicit clock uncertainty.
Screenshot fallbacks have only a host capture interval; their `timestamp` getter is undefined.
Moment windows and frame captions use `hostTime`, so delayed delivery cannot make old paint current.
`Page.screenshot({ fresh: true })` bypasses the frame cache. A cached frame is reused only if it
was painted after the page's latest submitted input, including input of a running or interrupted
action, and within the last 250 ms: a screencast sends only changes and can miss a final paint, so
a page that stopped changing gets a new capture. Every operation is recorded as an `Action`, also when its caller interrupts it.

Local launches and new Browserbase sessions measure clock offset and send-to-captured-image delay
on a private blank page before user scripts or public pages run. `Browser.captureCalibration`
holds those samples; `delayFor(frame)` maps their median delay onto that frame's clock estimate for
the consumer's compositor. This measures the first observed captured marker, not pure rendering lag.
The measurement is evidence, not a prerequisite: if it fails, `captureCalibration` is empty and the
browser opens anyway. Only a private page that cannot be closed fails `Browser.make`.
Supplied contexts and attached sessions receive read-only clock probes and expose no active startup
measurement. Transport asymmetry remains in the reported uncertainty.

Every renderer reads the same host wall clock, so the browser keeps one clock mapping for all of its
pages. The startup measurement seeds it; otherwise the first page that needs it probes it. Each new
capture refreshes the mapping and keeps the previous estimate if the page cannot answer in time, so a
busy page only fails while its browser has no estimate at all; that failure is undispatched.

Mouse input and raw text-key events carry the calibrated epoch timestamp. Shortcut chords retain
Playwright's platform behavior, and Unicode insertion has no timestamp field. Startup probes are
unstamped so the measurement remains observable.

`Page.captureStats` reports lifetime received and accepted frames, missing timestamps, frames
dropped out of order, observed subscriber losses and paint-time gap totals/minimum/maximum/last.
Concurrent readers share one native screencast and its quality and size: a reader without options
joins whatever is running, and one whose explicit options differ fails with `InvalidRequest` rather
than silently receiving other frames. Each reader has a bounded 16-frame queue; a slow reader's
observed sequence gaps add to `subscriberMissed`. Late subscribers do not count earlier history.
ACKs are independent of reader speed and bounded to 32 unresolved replies; exhaustion ends capture
with a typed error. Frame history remains bounded by `frameHistory`. Capture stops when its last
reader leaves; a stop whose reply is late is never resent, and the next capture waits for it (up
to 2 s per attempt) rather than disabling capture for the page.

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
that ownership free. A page with unresolved input replies waits for them before queueing, and an
action's timeout bounds its wait for that queue before a full timeout bounds the action. Every sent
move updates the position, including a partially cancelled glide. A later viewport clamps the
starting point to its bounds if necessary.

Every module is also an entry point, such as `effect-browser/Agent`. The
[repository README](https://github.com/mannyc2/effect-agent-browserbase#readme) has examples.
