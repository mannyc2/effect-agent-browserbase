# Hosted lease verification

H2 checks persisted rotation while the outgoing generation still has a live hold, followed by
reading its saved state in the next session. It is prepared, **not run for the leased-generation
release**. Local Chromium and `TestBrowserbase` establish different boundaries: native browser
behavior and client sequencing respectively. Neither proves Browserbase's save timing or billing.

## Allowance and setup

This run makes no model calls. It uses ordinary Browserbase sessions only: no proxies, Search,
Fetch, Functions, captcha solving or verified-browser add-ons. Use an isolated scratch context,
never an account's signed-in context. Keep keys, account identifiers and all private evidence out
of Git; never record connect URLs or Live View links.

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
tests REST contracts; it is not H2 and would allocate additional sessions. There is no H2 CLI
command yet: implement the following probe under the bench's existing hosted opt-in, keeping its
run artifacts under `.work/h2/`.

The probe must check that `EFFECT_BROWSER_BENCH_HOSTED` is exactly `1` before creating a context
or session. Supply `BrowserbaseClient.layerConfig()`, `ContextLease.layer` and
`FetchHttpClient.layer`. Wrap the client's `createSession` with a two-attempt admission limit,
counted before dispatch, so automatic loss recovery cannot allocate a third session. Do not
retry a create whose acknowledgement was lost. Run the Effect under a scope, with a four-minute
operation deadline and cleanup still enabled on interruption.

Use these supervision settings, with `contextId` obtained from a newly created scratch context:

```ts
const sessions = yield* Browserbase.supervise({
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
  reopen: Schedule.recurs(0),
  handover: "30 seconds",
});
```

## Probe sequence

1. Subscribe to `sessions.states` before borrowing. Record only generation numbers, lifecycle
   tags, `hostTime`, `at`, revocation deadlines and release tags. Separately observe the client's
   create/release/status calls with host timestamps and local session aliases. Never serialize
   a whole `Session`, request headers or URLs.
2. In generation 1's `use`, retain its lease and register a cleanup marker in that retained
   scope. Route `https://h2.browser.test/**` through `browser.context.route` to a small static HTML
   page, so the fixture requires no public server. On that origin, write a unique harmless
   marker to a persistent cookie and local storage through `page.playwright.evaluate`.
3. Start `sessions.rotate` in a separate fiber, outside `use`. Await generation 1's `Draining`,
   then hold it for five seconds. During the hold, page reads must still work and no second
   session create may be dispatched. This observes the exclusive barrier, not just two events
   that happened to be ordered.
4. Close the retained scope with `Scope.close(hold, Exit.void)`. Its cleanup marker must precede
   the provider release request. Await rotation, retaining every release outcome. A missing
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

Keep the tested commit and package versions, allowance verification, sanitized host trace,
provider timestamps, two read-back booleans, both release outcomes and the eventual usage delta
in the private run directory. The public result can report these outcomes with session aliases.
It must say whether H2 passed, failed or remained incomplete, and what the provider actually
confirmed. A passing run establishes this provider ordering and save read-back for that run;
it does not establish frame delivery, cued presentation, Live View suspension or future billing.
