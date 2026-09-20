# Project status

The Browserbase runtime's completed unpaid implementation was merged in [PR #3](https://github.com/mannyc2/effect-agent-browserbase/pull/3). Its immutable source identity, exact acceptance results and artifact checksums are retained in the [2026-09-19 acceptance record](history/2026-09-19-acceptance.md).

Current maintenance uses `Library CI` and a separate, manual, default-off npm OIDC workflow. Check the exact current PR/commit's Actions results; the historical acceptance record is not a claim that later changes were tested. Release procedures and required account configuration are in [RELEASING.md](RELEASING.md).

No npm version has been published from this repository. Live View *authorization* and actual operator handoff, persistent-context behavior, provider keep-alive reconnection, and replays remain separately authorized hosted checks. Local CDP/video and scripted-provider results are not substituted for those guarantees. Provider recording assembly and signed-URL download were covered by the 2026-09-20 run below; Live View issuance was exercised there too, but issuing a URL is not the same as proving an operator takeover.

[HOSTED.md](HOSTED.md) describes the manual, default-off workflow those checks run under and the separate demo recording that documentation publishes. A demo recording is documentation rather than evidence for any check above; the run records below are the evidence for the two checks they cover.

## Maintainer-reported hosted execution

The PR #16 author reported hosted allocation and cleanup on 2026-09-19, against source `d5892f2f7e1bdaf06c99f210891af6d7b0750a05`, producing the recording committed under [`media/`](media/README.md). Three sessions ran for 37.8s of total browser lifetime:

| Session | Runtime | Outcome | Lifetime |
| --- | --- | --- | --- |
| `1fcd0607-cffb-4c48-918a-bf1d999fd332` | Bun 1.4.2 | complete | 11.2s |
| `73727a3d-a2b3-4c71-8961-4b7e6658fb7d` | Node 22.22.0 | complete | 11.5s |
| `eff029fb-16fe-4d33-a000-0ee8b224ea1c` | Bun 1.3.14 | `connect` / `timeout`, undispatched | 15.1s |

Both complete runs allocated a session, connected over CDP, navigated, dispatched four bounded scrolls and captured 31 frames with `dropped: 0`, `duplicates: 0`, `nativeStop: "confirmed"` and `reason: "duration-limit"`, then released with `releaseRequested: true`, `remote: "confirmed"`, `local: "closed"` and provider status `COMPLETED`. The third allocated and then timed out inside `chromium.connectOverCDP`; its scope finalizer released the session anyway, which exercises cleanup after failed attachment to a known allocation, not an unknown allocation outcome. No session was left running.

Two limits on this record. It ran `examples/hosted-demo.ts` directly rather than through the `Hosted Browserbase` workflow, whose credentials are not configured, and on Node 22.22.0 rather than the pinned 24.14.1; Bun was the pinned 1.4.2. And it covers allocation, connect, navigation, bounded actions, live capture, observation and cleanup only. `recordSession` was `false`, so no provider recording, replay, download or signed URL was requested, and Live View, handoff, persistent context and keep-alive reconnection were not touched.

The Bun 1.3.14 failure does not establish a runtime-version root cause or minimum supported version. The reported success on pinned Bun 1.4.2 is a separate observation, not a controlled reproduction. This reconciliation independently checks committed media and unpaid acceptance; it does not repeat the hosted sessions or independently prove their reported provider cleanup responses.

## Owner-authorized hosted run, 2026-09-20

A second hosted execution was authorized by the repository owner and run from a maintenance host, this time through `tools/hosted-acceptance.sh` rather than an example script. Four sessions were allocated in total and all were released; none was left running.

`examples/hosted-acceptance.ts` failed `configure`/`configuration` before allocating anything, because it shared one options object between the interactive host layer and `BrowserbaseRecordings.layer`. Only the interactive layer projects its options through `httpOptions`, and `makeHttp` rejects excess keys. That is fixed in the example; the inconsistency between the four construction sites is recorded on [#6](https://github.com/mannyc2/effect-agent-browserbase/issues/6). This script had apparently never executed successfully before.

With that corrected, one bounded session covered allocation, navigation, a 129-byte observation, a 29,810-byte full-page screenshot, a three-second live capture ending `nativeStop: "confirmed"` with `dropped: 0` and `duplicates: 0`, Live View issuance, and cleanup reporting `releaseRequested: true`, `remote: "confirmed"`, `local: "closed"` and `observedStatus: "COMPLETED"`. Provider recording was then requested, assembled to `COMPLETED`, and downloaded — 1,545,695 bytes through the `artifactOrigins` allowlist. Recording downloads are served from a signed CloudFront URL that expires six hours after issue and is re-minted on each list call.

Three separate recordings were decoded with `ffprobe`. Each contains exactly one h264 video stream and no audio stream, including one from a page confirmed from inside the document to be playing a 440 Hz tone (`AudioContext.state: "running"`, media element unpaused, `currentTime` advancing). That closed [#13](https://github.com/mannyc2/effect-agent-browserbase/issues/13): provider recording does not carry website audio, and the README now records the measurement.

Limits on this record. It ran on Node 24.14.1 and Bun 1.4.2 — both pinned — but not through the `Hosted Browserbase` workflow, whose credentials remain unconfigured. It did not exercise operator takeover or release, persistent contexts, keep-alive reconnection, replays, or BYOS delivery. `pageControl` was not enabled. The audio finding is about Browserbase's recording pipeline, not about any future self-hosted transport.

## Historical material

`checkpoints/` is preserved byte-for-byte as provenance and is not needed to bootstrap current source. The old transfer handoff, canonical-input fetcher and transient development logs were retired from active paths. Their original bytes remain available at merge commit `e61e3d75c15cbd467e196170fce5c064c13d4bb0` in Git history:

```sh
git show e61e3d75c15cbd467e196170fce5c064c13d4bb0:docs/handoff.md
git show e61e3d75c15cbd467e196170fce5c064c13d4bb0:tools/fetch-inputs.py
git ls-tree -r e61e3d75c15cbd467e196170fce5c064c13d4bb0 results/
```

Do not follow historical transfer instructions as current contributor requirements. The maintained development entry point is [CONTRIBUTING.md](../CONTRIBUTING.md).
