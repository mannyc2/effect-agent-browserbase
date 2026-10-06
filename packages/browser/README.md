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
| `BrowserError` | Typed failures, saying whether input reached the page before the failure             |
| `Tools`        | The `effect/ai` browser toolkit                                                      |
| `Agent`        | A model with the tools, in a loop, until it reports an answer of the shape you asked |
| `Moment`       | Capture what a page showed around a point in time, and describe it in one model call |

`Agent.run` batches each turn's tool calls in order, halting on the first failure or a completed
`done` / `give_up`. Skipped calls receive a not-executed result. A malformed `done` answer can
be corrected on the next turn.

The model gets one outline and screenshot at the start and after each turn. `observation` selects
`"outline"`, `"screenshot"`, or `"both"` (the default). `Page.observe` returns that observation as
a schema value. `Tools.make` returns receipts; a caller writing its own loop observes the current
`tools.page` after the batch and drains `tools.takeZooms` into that same observation message.

`browser_zoom` captures a region in viewport CSS pixels when the tool runs. Requested crops arrive
with the next observation even in outline mode, labeled with their source page and viewport origin.
At most eight crops may await an observation. `Page.zoom` exposes the same capture as a `Zoom`
schema value with `region` and `image`; crop pixel coordinates need the region's origin added before
using them as click coordinates.

`Page.click` returns a `ResolvedTarget` captured before input: the requested point, element label,
role, accessible name, cursor and link target. Pixel targeting resolves through the page script and
keeps the original point; the receipt names the control even when a nested child received the hit.

Add a caller's toolkit with `additionalTools` and provide its handler layer to the run. It is
merged last, so the caller's tool wins a name clash, and its calls share the batch's halt behavior.

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
the library never retries the action or the policy automatically. A policy timeout is a typed
`PolicyTimeout`, and tools surface both timeout and denial as ordinary failed receipts. Without a
guard, actions are allowed. Canvas and opaque frames expose their outer element's metadata.

Typing sends key pairs for printable US characters in both plain and humanized modes; other text
uses Unicode insertion. Humanized keys follow their schedule without waiting for each network reply.
Pending replies are bounded and drained before an action succeeds; interruption stops new input and
releases submitted held keys. Shortcut chords retain Playwright’s platform-specific editing behavior.

`Browser.now`, event stamps, frame `receivedAt` and `Moment.at` share host monotonic milliseconds
from the clock captured when the browser is made. They remain ordered across wall-clock corrections.
Compare these stamps only within that clock: they are not epoch dates or comparable across hosts.
`Frame.timestamp` retains browser paint wall time; screenshot fallbacks use host wall time.

Every module is also an entry point, such as `effect-browser/Agent`. The
[repository README](https://github.com/mannyc2/effect-agent-browserbase#readme) has examples.
