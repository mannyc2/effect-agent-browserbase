# Browser evaluation

This unpaid evaluation runs the real Effect AgentRuntime, maintained Tools and
browser owner. A finite scripted provider drives two resettable development
cases. It measures contract and browser integration behavior; it is not a
real-model benchmark.

From a freshly bootstrapped workspace, with the pinned runtimes and Chromium
installed, run these commands in `packages/agent-browser`:

```sh
../../node_modules/.bin/vp run evaluation preview --trials 1
../../node_modules/.bin/vp run evaluation run results/evaluation-1 --source-revision <candidate-40-character-SHA>
../../node_modules/.bin/vp run evaluation grade results/evaluation-1/signup-base-0
../../node_modules/.bin/vp run evaluation replay results/evaluation-1/signup-base-0
```

Supply the clean **owned repository** candidate SHA, not the disposable upstream
workspace's SHA. CI supplies that identity to the native test automatically.
Local test invocations without `EVALUATION_SOURCE_REVISION` explicitly record
`unavailable`. `qualifiedPins` describes the repository's dependency contract;
the actual browser version is currently unavailable. Retain the acceptance
runtime/version records beside the evaluation files.

`preview` imports no runner and allocates no browser or model. It enumerates
three runs per trial, in declared order: signup with base plus form tools,
signup with observed plus observed-form tools, then cancelled mutation with base
plus form tools. One to ten trials run serially, with fresh fixture and owner for
each; there are at most thirty runs. Each run admits eight turns, eight tool
calls and twenty browser actions. JSONL retains at most 256 records and 2 MiB;
terminal facts have a separate 32 KiB reserve. Output directories must be new.
Results stay in ignored `results/`; retention is caller-owned and no old result
is silently overwritten or pruned.

`--backend browserbase` and `--provider real-model` are refused before importing
the runners or creating output. There is no paid adapter or inference-budget
enforcement in this milestone, even with an external generic opt-in.

## Cases and independent outcomes

| Case                 | Initial state and goal                                                                                                                                              | Oracle and expected outcome                                                                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signup`             | New local ToolSite and Chromium, empty account form. Submit ada@example.test on Pro with terms accepted. Read observed control identities from the actual document. | A server-owned ledger records only POST submissions. Exactly one write with the requested values passes; `done: true` alone does not. Passwords are neither requested nor retained.                              |
| `cancelled-mutation` | New scripted browser owner at a terms page. Start a click, hold after dispatch, then cancel the agent waiter.                                                       | The original owner records one dispatch, refuses a host retry, and retains checked cleanup after cancellation. Application write count and late native outcome are unavailable, so task success is inconclusive. |

The cancellation case uses the public scripted-engine seam. It does **not**
simulate a server write followed by a lost acknowledgement. Its observed
`settlement` is the scripted engine's post-cancellation fact, not proof of a late
browser completion. The existing `scripted-agent.test.ts` separately checks an
actual model retry attempt after an unknown outcome.

Both cases are `tuning`; no held-out results exist yet. Task success, structured
output validity, safe handling, infrastructure failure and cleanup are reported
separately. A correct application write can coexist with invalid output or
unconfirmed cleanup. Missing records never establish task success.

## Evidence and replay

Each run writes `manifest.json`, ordered `steps.jsonl`, `terminal.json` and a
recomputed `report.json`. A terminal count and SHA-256 detect missing or changed
step files; this is integrity checking, not a signature or authenticity claim.
The host sink outlives the cancelled agent waiter. CLI finalization writes after
scoped cleanup, including failures and interruption; process death or filesystem
failure can still prevent persistence. Artifact errors fail the command.

Requests are captured at Effect LanguageModel's normalized provider-options
boundary, including prompt, tool schemas, choice, response format and incremental
fields. Response records contain the stream parts actually emitted. AgentRuntime's
`onHistory` captures projected tool-visible results even when no further model
request occurs. Host dispatch and cleanup facts remain separate, with local
sequence IDs and explicitly labelled host monotonic receipt times. No provider
HTTP body, source presentation clock, transport round-trip count, real tokens,
billing or timing breakdown is inferred from these records.

Only these trusted synthetic fixtures may use this recorder. It has no generic
secret scrubber. Exact retained local URLs include their ephemeral port; no URL
aliasing or redaction is performed. Never point the runner at accounts, private
pages or arbitrary sites. Run-local IDs are not provider session identifiers;
cleanup projection deliberately omits the owner's native reference.

Offline replay uses the real AgentRuntime and the maintained Toolkit schemas.
Every provider request must match its retained normalized request, and every
ordered handler action must match the retained name and arguments before a
recorded result is supplied. Comparison is conservative: a raw `null` that the
handler decodes to omission can be refused instead of called exact. Missing,
failed, schema-incompatible or truncated results that cannot decode are refused.
Divergence latches a terminal host error; the model cannot retry into the next
old result, and replay never falls back to a live browser. The optional changed
URL input is an internal regression seam, not a supported live branching mode.
Replaying these same scripted actions is unpaid; replay with another real model
is a different, separately budgeted capability.

Subjective judging is disabled. Before adding it, freeze a rubric and a held-out
known-good/known-bad calibration set, declare the passing criterion before tuning,
blind and swap comparison order, and retain abstentions and judge cost. Failed
calibration permits exploratory scores only, never a gate or ranking.

## Existing coverage and limits

These are coverage mappings, not newly executed benchmark results:

| Boundary                                                                     | Existing proof or status                                                                      |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Long text, continuation, truncation, stale readings                          | `test/reading.test.ts`; not yet a task-success evaluation                                     |
| Delayed content and waits                                                    | `test/native/wait-observed.test.ts` and `test/host-lane.test.ts`                              |
| Successful action followed by failed inspection, result budgets              | `test/observed-results.test.ts`                                                               |
| Partial forms and invalid controls                                           | `test/forms.test.ts`, `test/native/forms.test.ts`                                             |
| Provider null-for-absent semantics                                           | `test/provider-schemas.test.ts`, `test/scripted-agent.test.ts`                                |
| SPA/document identity, frames and pinned pages                               | Owner's native Chromium tests; agent fixture coverage remains partial                         |
| Open/closed shadow geometry                                                  | Owner's viewport/occlusion tests; not general shadow control support                          |
| Dialogs, popups and additional tabs                                          | Provider native interactive tests; maintained agent toolkit does not gain page authority here |
| File inputs                                                                  | Host file selection is tested; no maintained agent upload tool                                |
| Lazy/infinite content, login walls, long sessions, hostile-page task attacks | Untested by this evaluation                                                                   |

[BrowserGym's loop](https://github.com/ServiceNow/BrowserGym/blob/main/browsergym/experiments/src/browsergym/experiments/loop.py)
and [AgentLab reproducibility](https://github.com/ServiceNow/AgentLab#-reproducibility)
inform provenance, reset and bounded trial records. They own a separate Gym
browser environment; no replacement runtime is installed.
[Stagehand's preview and trial controls](https://github.com/browserbase/stagehand/blob/main/packages/evals/README.md)
are a useful comparison design, but its prompts and action space need a matched
fixture adapter and approved spend. Pinned upstream Cloudflare Browser Run uses
Puppeteer and the framework InteractiveBrowser, not this package's browser owner;
an equivalent controlled comparison needs a separate adapter/account/runtime.
[WebArena-Verified's network evaluator](https://servicenow.github.io/webarena-verified/dev/evaluation/network_event_based_evaluation/)
cannot prove rendered DOM/JavaScript state. A benchmark subset and its task/data
licenses remain unqualified; framework licenses alone do not qualify a dataset.

## What this doesn't prove yet

No paid baseline, two-model comparison, uncertainty estimate, framework ranking,
held-out task generalization, prompt-injection immunity or calibrated judge score
is claimed. Recording/capture overhead and shared-consumer evidence qualification
remain separate work tied to the available public capture APIs and #112. The
write-before-lost-ack mutation scenario remains pending. Issue #93 stays open.
