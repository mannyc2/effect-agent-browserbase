# Project status

The Browserbase runtime's completed unpaid implementation was merged in [PR #3](https://github.com/mannyc2/effect-agent-browserbase/pull/3). Its immutable source identity, exact acceptance results and artifact checksums are retained in the [2026-09-19 acceptance record](history/2026-09-19-acceptance.md).

Current maintenance uses `Library CI` and a separate, manual, default-off npm OIDC workflow. Check the exact current PR/commit's Actions results; the historical acceptance record is not a claim that later changes were tested. Release procedures and required account configuration are in [RELEASING.md](RELEASING.md).

No npm version has been published from this repository. Live View authorization and actual operator handoff, persistent-context behavior, provider keep-alive reconnection, real provider files/recordings/replays and signed-URL expiry remain separately authorized hosted checks. Local CDP/video and scripted-provider results are not substituted for those guarantees.

[HOSTED.md](HOSTED.md) describes the manual, default-off workflow those checks run under and the separate demo recording that documentation publishes. A demo recording is documentation rather than evidence for any check above; the run records below are the evidence for the two checks they cover.

## First hosted execution

Hosted allocation and cleanup were exercised for the first time on 2026-09-19, against source `d5892f2f7e1bdaf06c99f210891af6d7b0750a05`, producing the recording committed under [`media/`](media/README.md). Three sessions ran for 37.8s of total browser lifetime:

| Session | Runtime | Outcome | Lifetime |
| --- | --- | --- | --- |
| `1fcd0607-cffb-4c48-918a-bf1d999fd332` | Bun 1.4.2 | complete | 11.2s |
| `73727a3d-a2b3-4c71-8961-4b7e6658fb7d` | Node 22.22.0 | complete | 11.5s |
| `eff029fb-16fe-4d33-a000-0ee8b224ea1c` | Bun 1.3.14 | `connect` / `timeout`, undispatched | 15.1s |

Both complete runs allocated a session, connected over CDP, navigated, dispatched four bounded scrolls and captured 31 frames with `dropped: 0`, `duplicates: 0`, `nativeStop: "confirmed"` and `reason: "duration-limit"`, then released with `releaseRequested: true`, `remote: "confirmed"`, `local: "closed"` and provider status `COMPLETED`. The third allocated and then timed out inside `chromium.connectOverCDP`; its scope finalizer released the session anyway, so the allocation-uncertain path was exercised against a real fault rather than a scripted one. No session was left running.

Two limits on this record. It ran `examples/hosted-demo.ts` directly rather than through the `Hosted Browserbase` workflow, whose credentials are not configured, and on Node 22.22.0 rather than the pinned 24.14.1; Bun was the pinned 1.4.2. And it covers allocation, connect, navigation, bounded actions, live capture, observation and cleanup only. `recordSession` was `false`, so no provider recording, replay, download or signed URL was requested, and Live View, handoff, persistent context and keep-alive reconnection were not touched.

The Bun 1.3.14 failure is a runtime floor rather than a package defect: the same source succeeded on the pinned Bun 1.4.2 minutes later, on the same host and credential.

## Historical material

`checkpoints/` is preserved byte-for-byte as provenance and is not needed to bootstrap current source. The old transfer handoff, canonical-input fetcher and transient development logs were retired from active paths. Their original bytes remain available at merge commit `e61e3d75c15cbd467e196170fce5c064c13d4bb0` in Git history:

```sh
git show e61e3d75c15cbd467e196170fce5c064c13d4bb0:docs/handoff.md
git show e61e3d75c15cbd467e196170fce5c064c13d4bb0:tools/fetch-inputs.py
git ls-tree -r e61e3d75c15cbd467e196170fce5c064c13d4bb0 results/
```

Do not follow historical transfer instructions as current contributor requirements. The maintained development entry point is [CONTRIBUTING.md](../CONTRIBUTING.md).
