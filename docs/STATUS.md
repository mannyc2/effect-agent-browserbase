# Status / restart note

Last updated: 2026-09-18. Update this file whenever the state below changes.

## Objective

Deliver `@effect-agent/platform-browserbase` as a first-class package of the
`danieljvdm/effect-agent` monorepo, to the full scope in [`handoff.md`](handoff.md):
interactive browser control, ownership and lifecycle, provider recordings, replay
access, downloads, optional live capture, public examples, documentation, and
repository acceptance on supported Node and Bun.

## Latest durable checkpoint

| | |
| --- | --- |
| Source | `packages/platform-browserbase/` — checkpoint 04, byte-exact, 33 files |
| Archive | `checkpoints/browserbase-continuation-04.zip`, 133,654 bytes |
| SHA-256 | `60c9fe450109e100a6483756690462894c9f7e936fb3f0c60b2b0296faf0efed` |
| Upstream | `ea53ea6671a94eb44b8019e942cc2c9468786723` (beta.102) |
| Patch | `checkpoints/patches/review.patch` — applies clean to that revision |

Checkpoint 03 is **not** held in this repository as an archive. Its content is
reachable as `checkpoints/patches/review.patch` minus
`checkpoints/patches/from-checkpoint03.patch`; the checkpoint-03 ZIP itself
(SHA-256 `a2ce9178…`) was never transferred here. Nothing in the current work
depends on it — `review.patch` alone reproduces the package from clean upstream.

## Most recent check results

All from [`results/2026-09-18-github-session/`](../results/2026-09-18-github-session/),
executed 2026-09-18 on Node 22.22.2 / Bun 1.3.11 (note: **not** the pinned Bun 1.4.2).

| Check | Result |
| --- | --- |
| Checkpoint archive integrity | pass — CRC + 43/43 manifest entries |
| Canonical inputs reachable | pass — upstream clone + all 8 npm inputs resolve |
| `review.patch` → pinned upstream | pass — clean apply, tree identical to this repo |
| `bun install` | pass — **only after** adding `playwright-core` to the root catalog |
| `tsc --noEmit` vs real framework | 2 errors, both unused imports; no contract errors |
| `vp test --run` (as committed) | 57/66 — 9 `TestClock` timeouts |
| `vp test --run` (with `it.live`) | 66/66 in 3.60s |
| Independent boundary harness | 66/66 on Node, 66/66 on Bun |

## Open blockers and findings

1. **Root catalog is missing `playwright-core`.** `packages/platform-browserbase/package.json`
   declares `"playwright-core": "catalog:"`, but the pinned upstream root catalog
   has no such entry and `review.patch` touches no root manifest. A frozen install
   fails with `error: playwright-core@catalog: failed to resolve`. The patch needs
   to carry root `package.json` and `bun.lock` changes — that is required workspace
   integration work, not a workaround.

2. **The four test files use `it.effect`, which installs a `TestClock`.** Nine
   time-dependent cases never advance the virtual clock and time out at Vitest's
   5s limit. `it.live` makes all 66 pass and confirms the diagnosis, but the brief
   asks for deterministic clock tests — so the likely correct fix is to advance
   `TestClock` explicitly in those cases and keep `it.effect`. Decide deliberately.

3. **Two unused imports** block a clean typecheck: `Viewport` in
   `src/internal/Playwright.ts:3` and `BrowserbaseError` in
   `test/fixtures/ScriptedProvider.ts:2`. Check whether each is genuinely dead or
   signals an unfinished code path before deleting it.

4. **No examples exist.** The manifest's `example:agent`, `example:hosted` and
   `example:record-video` scripts point at `examples/*.ts` files that are not in
   the checkpoint. The brief requires runnable public examples for ordinary
   interaction, multi-turn agent use, handoff and resume, persistent context and
   reconnect, downloads, recording retrieval after close, and a capture interval.

5. **Nothing has touched a real browser.** No Chromium launch, no CDP session, no
   Playwright control or screencast. Native capture, downloads, dialogs, popups
   and viewport behavior are unexercised.

6. **Bun 1.4.2 is unverified here.** This environment has 1.3.11. The historical
   `new Request(...).credentials` discrepancy on Bun 1.4.2 has not been re-tested.

## Next concrete action

Run `./tools/bootstrap.sh` to get a patched, installed worktree. Then, in order:

1. Resolve findings 1–3 (catalog entry + lockfile, clock strategy, unused imports)
   and get `vp check` and `vp test` green for the package.
2. Compose the real `AgentRuntime` / `ScriptedModel` integration described in
   brief §5 using actual public exports and `@effect-agent/testing` — no contract
   extracts, ambient declarations or stubs.
3. Stand up local Chromium via `playwright-core install chromium` and exercise
   native control, downloads and capture against a real browser.
4. Write the public examples, documentation and changeset; then work toward
   `vp run ready`, exports/purity and packed-consumer checks.

Keep hosted Browserbase sessions, paid inference, publication and deployment out
of scope — they are not authorized.
