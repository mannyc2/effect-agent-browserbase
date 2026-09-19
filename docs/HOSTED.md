# Hosted Browserbase runs

Ordinary CI never allocates a Browserbase session. `Library CI` stays unpaid,
credential-free and open to fork pull requests, and **Unpaid acceptance** remains
the only required check. Hosted runs are a separate, manual, default-off
workflow so that paid execution is always a deliberate maintainer action.

Two guarded commands exist, and they answer different questions:

| Command | Question it answers | Bounds |
| --- | --- | --- |
| `tools/hosted-acceptance.sh` | Does the integration actually work against the real provider? | one session, 180s, 10 actions, 3s capture, ≤512 MiB recording download, zero model calls |
| `tools/hosted-demo.sh` | What does a real session look like, for the README? | one session, 120s, 10 actions, ≤15s capture, no recording request or download, zero model calls |

The demo is documentation evidence and is not a substitute for acceptance. A
recording proves a session ran; it does not prove Live View authorization,
operator handoff, persistent-context behavior, reconnection or signed-URL
expiry. Those remain the separately authorized hosted checks tracked in
[STATUS.md](STATUS.md).

## Why this shape

Running paid provider tests from CI is ordinary practice, but it is only safe
under conditions this repository enforces in workflow source:

- **The required check stays unpaid.** Contributors and fork pull requests are
  never blocked on a credential they cannot have, and a lapsed subscription
  cannot make `main` unmergeable.
- **No trigger that unreviewed code can influence.** `hosted.yml` uses
  `workflow_dispatch` only. `pull_request`, `pull_request_target` and `schedule`
  are deliberately absent; `tools/test/hosted.test.mjs` fails if one is added.
  A `pull_request_target` job would hand the key to any fork's diff.
- **The credential lives in a protected environment**, not in repository
  secrets available to every workflow, so a run has an approver and an audit
  record.
- **Default off.** The workflow refuses to start until `BROWSERBASE_LIVE_ENABLED`
  is set, which makes accidental enablement a two-step mistake rather than one.
- **Runs are never cancelled mid-flight.** An interrupted allocation cannot
  report whether the provider released the browser, so the concurrency group
  uses `cancel-in-progress: false`.

The per-run cost is one short session. The real exposure is an unattended
trigger loop or a leaked key, which the rules above are aimed at, not the price
of any single run.

## One-time setup

1. Create a **dedicated Browserbase project** for CI. Scope the key to it so a
   leak cannot reach anything else, and so the usage in your dashboard is
   attributable to CI rather than to your own work.
2. Create a GitHub environment named **`browserbase-live`** with required
   reviewers. Restrict its deployment branches to `main`.
3. Add these **environment** secrets (not repository secrets) with exactly these
   names:

   | Secret | Required for | Value |
   | --- | --- | --- |
   | `BROWSERBASE_API_KEY` | both commands | the dedicated project's API key |
   | `BROWSERBASE_PROJECT_ID` | both commands | that project's id |
   | `BROWSERBASE_ARTIFACT_ORIGINS` | `acceptance` only | comma-separated exact HTTPS origins approved for provider recording delivery |

   The names are checked by the scripts before allocation; a misnamed secret
   fails the run rather than silently skipping a check.
4. Set repository variable **`BROWSERBASE_LIVE_ENABLED`** to the literal string
   `true` only after reviewing the above.

Nothing in this repository creates those settings. Rotate the key if it is ever
pasted outside GitHub's secret store — including into a terminal, an issue, a
chat window or an agent session.

## Running

Dispatch **Hosted Browserbase** from the Actions tab:

- `run: demo` — records the README media. Optionally set `demo_url` to an exact
  HTTPS page; it defaults to this repository's own GitHub page.
- `run: acceptance` — the guarded correctness run.
- `run: both` — two sessions.

Each run retains its line-delimited JSON records, the encoded video, the source
commit and SHA-256 checksums as an Actions artifact for 14 days. To publish the
recording, follow [docs/media/README.md](media/README.md).

## Running locally instead

Neither command needs GitHub. If you would rather not store a key at all, run
them from a trusted workstation against a bootstrapped workspace:

```sh
bash tools/bootstrap.sh
export EFFECT_AGENT_BROWSERBASE_LIVE=1
export BROWSERBASE_API_KEY=...        # not BROWSER_BASE_API_KEY
export BROWSERBASE_PROJECT_ID=...
bash tools/hosted-demo.sh .work/upstream/tree .work/demo

# Acceptance additionally needs approved provider delivery origins.
export BROWSERBASE_ARTIFACT_ORIGINS=https://...
bash tools/hosted-acceptance.sh .work/upstream/tree
```

`tools/hosted-demo.sh` needs caller-installed FFmpeg, the same way
`examples/record-video.ts` does; encoding is deliberately not a package
dependency.
