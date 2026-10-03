# Hosted Browserbase runs

Ordinary CI never allocates a Browserbase session. `Library CI` stays unpaid,
credential-free and open to fork pull requests, and **Unpaid acceptance** remains
the only required check. Hosted runs are a separate, manual, default-off
workflow so that paid execution is always a deliberate maintainer action.

Every paid question is one registered check. The registry,
[`packages/browserbase/hosted/checks.ts`](../packages/browserbase/hosted/checks.ts),
declares each check's budget, the settings it needs and the single claim a
successful run supports, and points at the recorded run that established it
(or `null` while it is outstanding). `tools/hosted-run.sh` is the only entry
point: it refuses any name the registry does not list and validates every named
check before the first one allocates. Every check passes through the same gate,
`hosted/harness.ts`, which owns the opt-in, credentials, account,
policy budgets, session count and JSON record. Ordinary unpaid CI holds each
entry to the registry's ceiling (`tools/test/hosted.test.mjs`), so an
over-budget check fails before anything is spent. Evaluation campaigns in
`packages/agent-browser` are the one other entry point that allocates hosted
sessions. They carry the same opt-in and add their own: each campaign's
approved plan counts and bounds its sessions, as the
[evaluation guide](../packages/agent-browser/test/evaluation/README.md#browserbase)
describes.

| Check                    | Question | What a passing run supports                                                                                                                                                                                                                  |
| ------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `acceptance`             | —        | allocation, connect, navigation, capture, Live View URL retrieval, confirmed release, recording download                                                                                                                                     |
| `demo`                   | —        | README media only; no correctness claim                                                                                                                                                                                                      |
| `handoff`                | —        | operator takeover and release through Live View (needs a person at a terminal; never runs in CI)                                                                                                                                             |
| `context-durability`     | H1       | a cookie and localStorage marker survive into a later session on the same context                                                                                                                                                            |
| `context-crash`          | H1       | the same markers survive when the writer's process is killed without a release, once the provider reports its session terminal                                                                                                               |
| `keepalive-reconnect`    | H4       | a keep-alive session survives detach, and an init script is ready after reconnect                                                                                                                                                            |
| `extension-identity`     | H3       | a registered MV3 extension keeps its identity and its content script runs                                                                                                                                                                    |
| `upload-routing`         | H6       | uploaded bytes reach the remote file chooser intact                                                                                                                                                                                          |
| `page-authority`         | H5       | issued Page/Frame routing, independent references, pictures, trusted typing and focus refusal, exact background containment, and last-page closure distinct from provider termination                                                        |
| `performed-presentation` | H7       | performed Page plan timing and logical action costs, trusted document-focus-qualified shifted input, independent journal readers sharing one capture, peer references, and checked release on a controlled animated scene                    |
| `replay-delivery`        | H7       | the replay playlist validates and a segment downloads; recording delivery is reported as observed                                                                                                                                            |
| `live-capture`           | —        | frame pacing and still-page delivery at real round trips and a viewport reading under a pass-through container with its cost; reported as measurements                                                                                       |
| `capture-isolation`      | H7       | captured frames keep flowing on hosted sessions while large protocol messages are in flight: at least two frames per fresh-document peer read and overlapping frame gaps bounded at 600 ms, followed by checked release                      |
| `long-session`           | —        | an action allowance above the former 1,000 cap spent to its maximum with live capture running throughout, `status.actions` agreeing with the host, the refusal at the maximum and a clean release; pace and capture reported as measurements |

The question codes come from the design research that preceded the checks
(retired to Git history; see [STATUS.md](STATUS.md#historical-material)): H1
persistence visibility, H2 context overlap and deletion, H3 extension and
profile identity, H4 reconnect and cleanup, H5 multi-page evidence, H6 files
and network routing, H7 observability and retention. H2 has no registered check;
H5's `page-authority` check and H7's `performed-presentation` follow-up first ran on 2 October 2026.
Each check narrows its question rather than answering all of
it; the registry's `claim` says exactly how far. The demo is documentation evidence and is not a
substitute for any check. [STATUS.md](STATUS.md) records which claims have a
run behind them.

## Why this shape

The optional paid path requires both workflow-source guards and separately
configured environment controls:

- **The required check stays unpaid.** Contributors and fork pull requests are
  never blocked on a credential they cannot have, and a lapsed subscription
  cannot make `main` unmergeable.
- **Manual, main-only execution.** `hosted.yml` uses `workflow_dispatch` only;
  both jobs require `refs/heads/main`, and checkout pins the dispatch commit.
  `pull_request`, `pull_request_target` and `schedule` are deliberately absent.
  Tests enforce these guards. A branch-restricted protected environment is
  still required: code on another branch can edit its own workflow guards,
  so source checks alone are not a credential authorization boundary.
- **Store the credential in a protected environment**, not repository
  secrets available to every workflow. Configure required reviewers and retain
  the run audit record before enabling this path.
- **Default off.** The workflow refuses to start until `BROWSERBASE_LIVE_ENABLED`
  is set, which makes accidental enablement a two-step mistake rather than one.
- **New runs do not automatically cancel an older run.** The concurrency group
  uses `cancel-in-progress: false`. Manual cancellation, a job timeout, or runner
  loss can still interrupt cleanup; none proves provider termination.

Each check allocates at most its registered `sessions` (never more than two),
and a run allocates at most the sum over the checks it names. No particular
monetary cost is guaranteed.
Keep the provider-side budgets and credential scope appropriate to that bound.

## One-time setup

1. Use a **dedicated Browserbase project** for CI attribution. Verify the
   provider's actual credential permissions and use the narrowest supported
   authority; a project ID alone does not prove that an API key is restricted
   to that project.
2. Create a GitHub environment named **`browserbase-live`** with required
   reviewers. Restrict its deployment branches to `main`.
3. Add these **environment** secrets (not repository secrets) with exactly these
   names:

   | Secret                         | Required for                                                          | Value                                                                        |
   | ------------------------------ | --------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
   | `BROWSERBASE_API_KEY`          | every check                                                           | an API key with verified minimum provider permissions                        |
   | `BROWSERBASE_PROJECT_ID`       | every check                                                           | that project's id                                                            |
   | `BROWSERBASE_ARTIFACT_ORIGINS` | checks that retrieve provider media (`acceptance`, `replay-delivery`) | comma-separated exact HTTPS origins approved for provider recording delivery |

   The names are checked before allocation; a misnamed secret fails the run
   rather than silently skipping a check.

4. Set repository variable **`BROWSERBASE_LIVE_ENABLED`** to the literal string
   `true` only after reviewing the above.

Nothing in this repository creates those settings. Rotate the key if it is ever
pasted outside GitHub's secret store — including into a terminal, an issue, a
chat window or an agent session.

## Running

Dispatch **Hosted Browserbase** from the Actions tab and set `checks` to one or
more space-separated registry names, for example `demo` or
`acceptance context-durability`. `demo_url` optionally sets the exact HTTPS page
the demo shows; it defaults to this repository's own GitHub page.

Each check writes `<check>.jsonl` and any files it produces under its own
directory, beside the source commit and checksums. A record that allocated past
its session budget or never completed fails the run. Outputs are retained as an
Actions artifact for 14 days. To publish a demo recording, follow
[docs/media/README.md](media/README.md).

## Running locally instead

Nothing needs GitHub. If you would rather not store a key at all, run from a
trusted workstation against an installed workspace. `handoff` can only run
this way, because it shows a Live View URL to the person at the terminal:

```sh
bash tools/workspace.sh .work/workspace
export EFFECT_AGENT_BROWSERBASE_LIVE=1
export BROWSERBASE_API_KEY=...        # not BROWSER_BASE_API_KEY
export BROWSERBASE_PROJECT_ID=...
# Only checks that retrieve provider media need approved delivery origins.
export BROWSERBASE_ARTIFACT_ORIGINS=https://...
bash tools/hosted-run.sh .work/workspace .work/hosted demo acceptance
```

The `demo` check needs caller-installed FFmpeg, the same way
`examples/record-video.ts` does; encoding is deliberately not a package
dependency.

`capture-isolation` needs no extra settings. Its approved bootstrap installs an animated
canvas on `https://example.com/` and a button in each of four fresh documents on a peer Page
in the same session. The first `observe` with an element in each document exercises the pinned
Playwright path that uploads its roughly 330 KB injected script on the control connection.
The check uses the public capture stream and records the idle cadence, each complete read
window and every inter-frame gap overlapping that window, including the gaps across its
edges. It requires at least two frames within each read and no overlapping gap above 600 ms.
The read window includes more than the upload itself; this check does not expose protocol
messages or claim to measure their byte-level dispatch times. The original capture must stop
cleanly without buffer overflow, and checked cleanup must confirm provider release. The
budget is one session, 120 browser seconds, 15 actions, 90 capture seconds and zero transfers.
Run it serially with other hosted checks so concurrent uploads from this host do not confound
the measured gap. Registration alone does not authorize execution.

`page-authority` additionally requires `BROWSERBASE_PAGE_AUTHORITY_URL`, an operator-owned,
credential-free HTTPS directory URL with no query or fragment. Its landing document must be
reachable, and its same-origin `pending` endpoint must hold a document navigation open without
completing it. The gate refuses a missing setting before allocation, and the check validates the
URL and makes one bounded reachability request before opening its one provider session. It does
not deploy or provision that fixture. For the existing protected manual workflow, configure
the same `BROWSERBASE_PAGE_AUTHORITY_URL` variable in its environment; it remains required for
this check and has no implicit fixture. The registered ceiling is 180 browser seconds, 30 actions,
10 capture seconds and zero provider transfers. Typing reports actual trusted DOM events,
values, one-action cost and the host receipt interval; native outstanding reply counts are not
observable through this public API and are explicitly reported as unobserved.

`performed-presentation` requires `BROWSERBASE_PERFORMED_PRESENTATION_URL`, an operator-owned,
credential-free HTTPS directory URL without a query or fragment. Before allocation it validates
that URL and makes one bounded reachability request. Its approved bootstrap installs a plain
input/button scene in each Page with a fixture animation that alternates without end, so the
captured scene keeps painting; it adds no pointer, pulse or caption artwork to the website. It
issues two original Pages. A created Page opens as the front tab of a headful window and puts the
Page behind it in the background, where its document stops painting, so the filmed stage is the
Page the check creates and the original Page is the peer, selected for display. Before capture
starts the stage must report `document.visibilityState` as visible, or the claim fails without
waiting on frames. Performed plans run on the stage while two independent public Timeline readers
observe its one original Capture interval. It cancels one reader, requires the other and captured
frames to continue, then explicitly stops the capture and requests checked provider cleanup
through the harness.

The same environment variable is forwarded by the protected manual workflow. The budget is
one provider session, 180 browser seconds, 30 actions, 10 capture seconds and zero transfers.
The first performed plan starts at `startAt`, 400 ms ahead on the original owner's monotonic
clock: the run must keep that instant, start no earlier, report lateness from it and bound
`within` from it. Both readers must see the same ordered events, the capture's first frame among them, until one
is canceled, and the canceled reader must end by interruption alone. The result reports original-owner schedule
timing, observed trusted DOM key hold intervals, logical action costs and capture accounting. Document `activeElement` observations qualify
focus; they do not prove OS focus or guarantee future input delivery. A successful run would
qualify this controlled animated scene and actual provider round trips, with no claim of exact
remote pacing, upstream frame loss, or still-page/background painting on other sites. Its run
record is in [STATUS.md](STATUS.md#hosted-checks-at-020-beta8-2-october-2026); registration does
not authorize execution, fixture deployment or allocation.
