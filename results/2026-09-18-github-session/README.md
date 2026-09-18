# Fresh execution record — 2026-09-18, GitHub session

Every result below was executed in this session. None is inherited from the
checkpoint's saved logs. The historical logs live in `checkpoints/runs/` and were
not modified, re-run, or reinterpreted here.

## Environment

| | This session | Checkpoint 04's historical runs | Upstream requirement |
| --- | --- | --- | --- |
| Node | 22.22.2 | 24.11.1 | `^22.18.0 \|\| >=24.11.0` |
| Bun | 1.3.11 | 1.4.2 | `1.4.2` (`packageManager`) |
| TypeScript | 7.0.2 (from catalog) | not exercised | 7.0.2 |
| Vitest / `@effect/vitest` | 4.1.11 / 4.0.0-rc.115 | not exercised | same |

Both runtimes here differ from the historical ones. Node 22.22.2 is inside the
declared engine range; Bun 1.3.11 is **below** the pinned 1.4.2. Results on the
pinned Bun are not established by this session. In particular, the Bun `Request`
`credentials` discrepancy recorded earlier in the checkpoint's history was not
re-tested on Bun 1.4.2 here.

## What was verified

### 1. Checkpoint integrity — passed

`tools/verify-checkpoint.py` against `checkpoints/browserbase-continuation-04.zip`:

```json
{ "bytes": 133654,
  "sha256": "60c9fe450109e100a6483756690462894c9f7e936fb3f0c60b2b0296faf0efed",
  "crc": "passed",
  "manifest_entries_verified": 43 }
```

The user's two separate uploads (`browserbase-continuation-04.zip` and the copy
inside the transfer kit) are byte-identical to each other and to the handoff's
stated SHA-256.

### 2. Canonical inputs are obtainable — resolved

The pinned upstream `danieljvdm/effect-agent` is a **public** repository. A full
clone succeeded and contains revision `ea53ea6671a94eb44b8019e942cc2c9468786723`
(`chore: version packages (beta) (#524)`, 2026-09-17).

All eight canonical npm inputs resolve — see `canonical-inputs.json` for tarball
URLs and registry integrity hashes.

This supersedes `checkpoints/access/*.json`, which recorded `curl` exit 6 / DNS
resolution failure for these same hosts. Those failures were a property of that
network-isolated environment, not of the inputs. No "prepared" dependency archive
is required, and none is missing.

### 3. `review.patch` applied to the exact upstream — passed

`git apply --check` then `git apply` against a clean worktree of
`ea53ea66…`: clean application, 33 files, 3,584 insertions, exit 0. One cosmetic
warning (`new blank line at EOF`).

`diff -r` between the patched upstream tree and this repo's
`packages/platform-browserbase/` reports **zero differences**.

This closes the item the handoff listed as "the clean-upstream application remains
to be checked."

### 4. Workspace install — passed, after one catalog addition

`bun install --frozen-lockfile` fails on the unmodified upstream:

```
error: playwright-core@catalog: failed to resolve
```

The package manifest declares `"playwright-core": "catalog:"`, but the pinned
upstream root catalog has no `playwright-core` entry, and `review.patch` touches
no file outside `packages/platform-browserbase/`. Adding
`"playwright-core": "1.63.0"` to the root `catalog` makes the install succeed:
2,247 packages in 7.71s. Log: `bun-install-frozen.log`.

Because Bun here is 1.3.11 rather than the pinned 1.4.2, the retry used a
non-frozen `bun install`. A frozen install on Bun 1.4.2 with a regenerated
lockfile is still unverified.

### 5. Real-framework compilation — 2 errors, both trivial

`tsc --noEmit` (TypeScript 7.0.2) over the package inside the installed monorepo,
against real `effect@4.0.0-rc.115` and the real workspace `effect-agent` and
`@effect-agent/testing` packages. Log: `tsc-noEmit.log`.

```
src/internal/Playwright.ts(3,114): error TS6133: 'Viewport' is declared but its value is never read.
test/fixtures/ScriptedProvider.ts(2,46): error TS6133: 'BrowserbaseError' is declared but its value is never read.
```

Both are unused imports. **There are no type errors against the real framework
contracts.** This is the first real-framework compilation of this package; it was
previously performed only against a browser-contract extract.

Note this is `tsc` invoked directly for diagnosis. The repository's `AGENTS.md`
requires `vp check` for static checks; that gate has not been run repo-wide.

### 6. Package tests under the repository's own gate — 57/66, then 66/66

`vp test --run` as checked in (`it.effect`): **9 failed, 57 passed**, all nine
failing with `Test timed out in 5000ms`. Log: `vp-test-it-effect.log`.

`@effect/vitest`'s `it.effect` installs a `TestClock`. The nine failures are
exactly the cases that wait on elapsed time — capture duration expiry, idle-browser
elapsed expiry, late connection after interruption, and similar. They never advance
the virtual clock, so they hang until Vitest's 5s limit.

Changing the four test files to `it.live` gives **66 passed (66)** in 3.60s.
Log: `vp-test-it-live.log`.

`it.live` is the diagnosis, not necessarily the right fix. The brief calls for
"deterministic service/clock tests for state transitions", which argues for
advancing `TestClock` explicitly in those cases instead. That decision is open.

**The committed source in `packages/platform-browserbase/` was not changed.** The
`it.live` edit was made only in a scratch worktree.

### 7. Independent boundary harness — 66/66 on both runtimes

`checkpoints/probes/run.mjs` against real `effect@4.0.0-rc.115`, no monorepo:

| Runtime | Result | Exit |
| --- | --- | --- |
| Node 22.22.2 | 66/66 | 0 |
| Bun 1.3.11 | 66/66 | 0 |

Logs and JSON: `node.log`, `node.json`, `bun.log`, `bun.json`. Reproduce with
`tools/run-boundary-suite.sh`.

## What was NOT verified

- Anything requiring a **real browser**. No Chromium was launched, no CDP
  connection opened, no Playwright control or screencast exercised.
- **Hosted Browserbase** anything — no session allocated, no provider recording,
  no Live View, no handoff. Not authorized.
- **Model inference** of any kind, including the unpaid `ScriptedModel`
  integration the brief requires.
- `vp run ready`, `vp check` repo-wide, exports/purity checks, `vp pack`, or
  packed-consumer verification.
- Public **examples** — the manifest names `examples/agent.ts`,
  `examples/hosted.ts` and `examples/record-video.ts`; none of these files exist
  in the checkpoint.
- **Bun 1.4.2** behavior, including the historical `Request.credentials`
  discrepancy.
- Any claim about **live capture fidelity**. Synthetic frames are not
  remote-browser capture.
