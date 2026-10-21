# Composing owned browser work

The compiled examples in [`bench/Watched.ts`](../bench/Watched.ts) and
[`bench/Workflow.ts`](../bench/Workflow.ts) use public package entry points. They are consumer
code: the library owns browser lifetimes, dispatch uncertainty, input admission and capture;
the consumer owns editorial choices, account policy and durable business records.

Run the examples' local Chromium scenarios from the repository root:

```sh
bun run --cwd bench test test/composition.test.ts
```

The tests launch local browsers and a temporary HTTP fixture. No model, hosted session or
credential is used. The fixture counts actual form submissions independently of the runner,
and its journal is reopened from a temporary file between attempts. This proves restart
semantics across a new browser generation; it does not certify a production storage system's
power-loss durability or Browserbase's persistence, capture or billing.

## Watched browsing

Create `Watched.make(sessions)` in the output's scope. `sessions` is a
`Supervisor.Supervisor<{ browser, value: A }, E>`: its provider's scoped `open(number)` returns
`{ value: { browser, value }, lost: browser.disconnected }`. Acquire application resources inside
that generation's scope. For hosted sessions, pass `Browserbase.generations({ build })` into
`Supervisor.make`, with `build` returning the browser and application value. Closing a generation
also closes its application resources.

`prepare(id, walk)` keeps a scoped `use` running, opens a page in that scope and restores the walk. Restore refuses to blindly repeat a committing step;
use navigation and other repeatable setup, or operation-specific durable read-back. Rotation, loss or retirement interrupts that work and closes its prepared page. The example uses no automatic retry loop:
the consumer chooses which preparation still matters on the next generation.

Keep each prepared page's caller scope alive while it is on output. `reveal(next, sent)` starts
the cue and waits for its first current frame before awaiting the consumer's send/drop event.
The event yields `Option.some(hostTime)` when the line actually goes out, or `Option.none()`
when it is dropped. Use the shared browser host clock for that time, never `Date.now()`.
The example bounds the event wait at 20 seconds. A dropped line abandons its cue and leaves
the prior page shown. The prepared page remains owned by its caller until that caller closes
its scope or explicitly closes its `hold`.

Sent reveals wait in order; a later reveal cannot overtake one already waiting. Waiting remains
cancelable. Once its turn starts, commit waits for outgoing input to drain. The example completes
commit and transfers its prepared-page ownership together, then closes the old page's hold. The returned `Presented.at` is the actual switch
time; `latency` records how late it was relative to the event. Journal this alongside the
consumer's line identifier if the application needs a durable editorial history.

`perform(prepared, plan, from, stop)` calls `Plan.take` one step at a time. A stop requested
during a step waits until that step completes, then returns its receipts and an unsent next
step. A previously unknown stopping point remains unknown. A hard interruption has no return
value: a consumer requiring crash recovery must durably record begun steps, as in the workflow
example. Neither rotation nor a stop signal changes a previously dispatched action into an
unsent one.

Subscribe to `output`, the stage's `shown` stream. `Painted` carries new paint, `Still` carries
a confirmed current image, `Stalled` says the last image cannot currently be confirmed, and
`Gone` reports known loss. A consumer can put up its own outage slate. A prepared page does not
survive revocation: stale work fails and its scope closes. Exclusive persisted contexts wait for
that cleanup and provider release before opening the next generation.

## Operator-assisted workflows

`Workflow.run(sessions, journal, run, plan, options)` has no presentation stage. It borrows a
generation, opens a scoped working page, restores the prefix and executes each remaining step.
The journal port deliberately has no library storage implementation. A production consumer must:

- Bind a run to the same plan version and input identity, and admit one runner for that run.
- Commit `begun(run, step)` durably before acknowledging it. Until `done` commits, `read`
  returns that step as `Stopped { input: "unknown" }`.
- Commit each receipt atomically with the next checkpoint. Fresh and completed checkpoints
  use `unsent` at zero and the next step respectively.
- Treat a failed journal write, interruption, revocation and missing acknowledgement as
  unresolved input. Do not clear the begun marker simply because the browser was replaced.

The native scenario clicks **Submit claim**, lets the server save **Saved claim RUN-1**, then
fails the journal's receipt write. The next attempt opens another browser generation and reads
the earlier begun marker from disk. An authored `Appeared` check with `durable: true` and that
operation's saved identifier reconciles the commitment and skips the click. A transient check
cannot justify that continuation, even when matching text is currently visible. An absent
durable effect cannot authorize another submission either. `Uncertain` stays a failure for the
consumer to reconcile; the runner never retries it as a fresh numeric step.

`durable: true` is allowed only on `Appeared` or exact-URL `Navigated`. It is the workflow author's
assertion about an actual lasting, operation-specific read-back. Absence and relative navigation
cannot recover unknown input. A toast, generic success heading, arbitrary exact URL or another
run's saved record is not sufficient. The library cannot
prove that a site's text represents the intended business operation. All plans use version 3
with canonical typed Actions; prior string-action encodings do not decode.

When a step is known unsent (or repeatable) and the consumer's `operator.needed(page)` confirms
an authentication challenge, the runner suspends automated browser input. Draining is bounded
at five seconds and the operator wait at two minutes. Reads and screenshots remain available;
the person acts through the provider's viewer. The local test uses Playwright as that external
operator and verifies that library input is refused during the intervention. After the scope
closes, the runner tries the original stopping point once. Operator assistance never converts
unknown consequential input into permission to repeat it.

The example's journal retains a conservative unknown marker even when a failed call reports
known-unsent input. A consumer may durably record that stronger receipt before resuming; this
example leaves such recovery policy to the application instead of weakening crash safety.
