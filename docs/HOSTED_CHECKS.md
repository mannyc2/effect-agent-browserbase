# Hosted verification

H2 checks persisted rotation while the outgoing generation still has a live hold, followed by
reading its saved state in the next session. It is prepared, **not run for the leased-generation
release**. Local Chromium and `TestBrowserbase` establish different boundaries: native browser
behavior and client sequencing respectively. Neither proves Browserbase's save timing or billing.

## Allowance and setup

This run makes no model calls. It uses ordinary Browserbase sessions only: no proxies, Search,
Fetch, Functions, captcha solving or verified-browser add-ons. Use an isolated scratch context,
never an account's signed-in context. Keep keys, account identifiers and all private evidence out
of Git; never record connect URLs or Live View links in logs or sanitized reports. H3 delivers
its viewer capability only through the private file described below.

Before setting `EFFECT_BROWSER_BENCH_HOSTED=1`, verify the correct project's current included
browser-hour balance and billing settings in the provider dashboard. Reserve **10 included
browser-minutes** for this run and record that verification privately. The probe admits at most
two sessions, each with a 120-second provider timeout: four nominal session-minutes, with the
reservation covering timeout delay and billing rounding. This reservation is not proof that a
provider will stop billing on time. Do not proceed if the run's allowance, concurrent usage or
overage boundary cannot be established; report the missing included allowance instead. An opt-in
variable by itself does not establish that boundary.

Use the repository's pinned toolchain and a commit whose `bun run ready` and
`tools/check-packed.sh` passed. Run one probe, with no concurrent hosted checks. `bench contract`
tests REST contracts; it is not H2 and would allocate additional sessions. The executable probe is
`bench handover`, with run artifacts under `.work/h2/<run>/`. It requires a clean checkout and
records that commit and all four package versions.

Keep a private dashboard screenshot or verification note that establishes the correct key's
project, included balance, disabled overage and absence of concurrent project use. Reference that
file from a private allowance JSON file:

```json
{
  "verifiedAt": "<current ISO timestamp>",
  "verificationFile": "/private/path/to/dashboard-verification",
  "includedMinutes": 10,
  "overageDisabled": true,
  "exclusiveUse": true,
  "usageBeforeMinutes": 0
}
```

Replace the timestamp and usage with the verified values. The command requires verification
within the last hour and at least ten included minutes. These fields are an owner assertion;
neither the JSON nor the file's existence independently verifies Browserbase billing settings.
An agent must establish the allowance boundary before running the command. The result retains
the verification file's SHA-256 digest, without copying its private contents or path.

```sh
# From bench/, using the pinned toolchain and credentials already supplied privately:
EFFECT_BROWSER_BENCH_HOSTED=1 bun run bench handover --allowance /private/h2-allowance.json
```

The command checks that `EFFECT_BROWSER_BENCH_HOSTED` is exactly `1` before reading provider
configuration or creating a context or session. It supplies `BrowserbaseClient.layerConfig()`,
`ContextLease.layer` and `FetchHttpClient.layer`. Its client wrapper counts session attempts before
dispatch and admits at most two. An interrupted or failed create closes admission; an uncertain
allocation is retained as uncertainty. It does not retry that create. The probe runs under a scope
with a four-minute operation deadline. Cleanup still runs after interruption or timeout and can
outlast that deadline; it is not a hard billing cutoff.

Use these supervision settings, with `contextId` obtained from a newly created scratch context:

```ts
const sessions =
  yield *
  Supervisor.make({
    ...Browserbase.generations({
      build: Effect.succeed,
    session: {
      timeout: 120,
      proxies: false,
      browserSettings: {
        context: { id: contextId, persist: true },
        viewport: { width: 1280, height: 720 },
        solveCaptchas: false,
        recordSession: false,
        logSession: false,
        verified: false,
      },
    },
    }),
    reopen: Schedule.recurs(0),
  });
```

## Probe sequence

1. Subscribe to `sessions.states` before borrowing. Record only generation numbers, lifecycle
   tags, `hostTime`, `at` and release tags. Separately observe the client's
   create/release/status calls with host timestamps and local session aliases. Never serialize
   a whole `Session`, request headers or URLs.
2. In generation 1's `use`, register a scoped cleanup marker and suspend that cleanup behind a
   test-owned gate. Route `https://h2.browser.test/**` through the browser's request controls to a
   small static HTML page. On that origin, write a unique harmless marker to a persistent cookie
   and local storage through the page's typed script contract.
3. Start `sessions.rotate()` in a separate fiber, outside `use`. Await generation 1's `Ending`
   and the start of its revoked work's cleanup. Before releasing the cleanup gate, no provider
   release or second session create may be dispatched. This observes the exclusive barrier.
4. Open the cleanup gate. Its cleanup marker must precede the provider release request. Await
   the revoked work's failure and rotation, retaining every release outcome. A missing
   acknowledgement, `Unconfirmed`, create failure or context refusal is an incomplete check,
   never a pass or a reason to retry the whole probe blindly.
5. Read the first session's terminal status and `endedAt` through `getSession`. Compare the
   provider's `endedAt` with the second session's provider `createdAt`, and independently check
   the host trace: terminal confirmation and context settling must precede the second create.
   Keep wall-clock provider evidence separate from monotonic generation/frame stamps.
6. In generation 2's `use`, install the same intercepted fixture and navigate to its origin.
   Read the cookie and local storage without rewriting either. Both must equal generation 1's
   marker. A successful create or unchanged context `updatedAt` does not prove persistence.
7. Explicitly `retire`, then confirm both sessions ended through provider status reads. Delete
   the scratch context only after all known writers are confirmed ended. Record project usage
   after the run and its delta when the provider reports it; pending usage is not zero usage.
   If release remains unconfirmed, stop new admission, retain the private identifiers for
   reconciliation, and report the result as incomplete.

## Evidence to retain

The command creates its run directory with mode 0700 and its create-only `started.json` and
`result.json` files with mode 0600. They retain the tested commit and package versions, allowance
verification digest, sanitized host trace, provider timestamps, two read-back booleans and both
release outcomes. Provider identifiers, error descriptions and connection or viewer links are
omitted; only local session aliases appear. If the process is killed before `result.json` exists,
the started record is incomplete. Find its sessions in the provider dashboard by the `probe: h2`
and `run` user metadata before considering another run; never infer release from a missing file.

The usage delta stays `null`, because the client has no billing endpoint. When provider usage has
settled, retain a separate private `usage.json` with the dashboard evidence and delta; do not
replace the original report. No model, hosted session or provider billing check has been run as
part of preparing this command. Its free tests cover admission and sanitization plus the complete
probe using local Chromium and `TestBrowserbase`; the latter reconnects to one local context and
does not prove hosted persistence.

The public result can report these outcomes with session aliases.
It must say whether H2 passed, failed or remained incomplete, and what the provider actually
confirmed. A passing run establishes this provider ordering and save read-back for that run;
it does not establish frame delivery, cued presentation, Live View suspension or future billing.

## H1: capture overlap and cue warm-up

The executable `bench cue` is prepared; **no hosted H1 run is established by the local suites**.
Use the allowance JSON and verification procedure above, reserving **10 included minutes** for
this probe alone. It admits exactly one session attempt, with a **420-second provider timeout**,
no proxies, captcha solving, recording, session logs or verified-browser add-ons. A failed or
uncertain create is never retried. The operation deadline is 390 seconds; release cleanup can
outlast it. Provider billing and release timing still require the retained provider evidence.

```sh
# From bench/, on a clean tested commit, after establishing the included-hours boundary:
EFFECT_BROWSER_BENCH_HOSTED=1 bun run bench cue --allowance /private/h1-allowance.json
```

H1 uses two animated pages at **1280×720, JPEG quality 80**, and a third page that repeatedly loads
and reads a controlled page of about one MiB. Request interception serves these fixtures through
the browser's control connection. This gives reproducible competing browser work without a
public fixture server or a paid auxiliary provider API; it does not reproduce every internet
site's network behavior.

The timing is deliberate. Twenty actual event-triggered commits are scheduled 15 seconds apart.
Each cue starts 30 seconds before its scheduled event, and its event waits until at least
30 seconds have elapsed since that cue first reported ready; commit checks its current frame
again. Up to three preparation tasks overlap, alternating the two captured pages. Independent
consumers retain both pages' screencasts
for the entire measured window, including the final 15 seconds after the last commit; Stage
shares those captures at identical settings. Preparation begins before measurement: the first
commit starts a **full five-minute observation window**, and the final scheduled commit falls
285 seconds into it. Nominal session work is therefore about **five minutes thirty seconds**, plus
connection/setup and release. A slow cue records its actual event and switch times rather than
pretending it met the schedule; no option silently shortens this experiment.

The private `.work/h1/<run>/result.json` retains every commit's ready/event/shown host times,
latency and `stage.stats()`, the measured interval, emitted-frame count, largest observed output
delivery gap (including trailing silence), maximum paint age, third-page load count, both retained
captures' first/last arrival times, frame counts and lifetime stats, and counts of `Painted`,
`Still`, `Stalled` and `Gone`. A known loss or invalid frame size fails the run.
Native capture counters retain paint gaps separately from host delivery gaps. Errors retain
only their closed reason tag, including `Limit`; no frame bytes, page/session identifiers,
addresses or provider error descriptions are serialized.

`completed` means the whole measurement completed and provider release reported `Settled`.
It is not a claim about an undocumented 64 MiB limit, nor a universal acceptable gap threshold.
Review the measurements before adopting cued output in a demanding consumer. A limit not reached
in this run is not a verified provider limit. Retain the later usage delta separately as for H2.

## H3: manual Live View handoff

The executable `bench operator` is prepared; **a real Browserbase viewer and sign-in remain a
manual hosted check**. Reserve **10 included minutes**, separately from H1/H2. This probe admits
one session attempt with a **300-second provider timeout**, the same disabled add-ons, a
240-second operation deadline and a three-minute manual handoff wait. It creates no persisted
context. Choose an account and sign-in flow that are safe to exercise in this scratch session;
the consumer owns that choice and its credentials.

Create a private settings JSON file. `startUrl` must be HTTPS without embedded username/password;
`signedIn` must name text or an accessible name that specifically proves this account's signed-in
page. Neither settings nor page contents are printed or put in the sanitized result:

```json
{
  "startUrl": "https://your-approved-site.example/sign-in",
  "signedIn": { "role": "heading", "name": "Your account dashboard" }
}
```

```sh
EFFECT_BROWSER_BENCH_HOSTED=1 bun run bench operator \
  --allowance /private/h3-allowance.json --settings /private/h3-settings.json
```

The probe opens a scratch page with an **Open sign-in page** link, drains automated input through
`browser.suspend`, then writes `.work/h3/<run>/viewer.json` with mode **0600** inside a mode
**0700** directory. That file contains a credential-bearing Live View link. The console prints
only its private path. Open it privately, use the viewer's scratch-page link to open a new tab,
and sign in manually. Keep the scratch tab open. Do not paste the viewer URL, credentials or
settings into a model input, public artifact or repository. The viewer file is the explicit
exception to the sanitized reports; keep it private and remove it after the session ends.

During the handoff, the probe repeatedly attempts a harmless `Tab` on the scratch page. Every
attempt must fail `Suspended` with `dispatched: false`; screenshots and page reads must continue.
It resumes browser events after the suspension's cursor, retaining only sequence numbers, host
times, event kinds and local page aliases. It requires a newly observed page, navigation and
the authored signed-in read-back, and refuses any observed dispatched library action. Event
evidence is bounded at 2,048 records; overflow or lost event history makes the check incomplete.

Once all checks hold, the suspension scope closes and a harmless `Tab` on the scratch page must
succeed, proving admission resumed. Cleanup releases the session and records its confirmation.
Timeout, canceled handoff, lost connection, missing evidence or unconfirmed release stays a failed
or incomplete result. No missing acknowledgement authorizes a new session automatically.

The sanitized report does not prove an account's business state from generic page text. Keep the
private settings with the run's private allowance evidence so a reviewer can assess the read-back.
Local Chromium can establish the observer and suspension sequence with an external operator
stand-in; it does not establish Browserbase Live View delivery, hosted authentication or billing.
