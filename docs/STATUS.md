# Project status

The Browserbase runtime's completed unpaid implementation was merged in [PR #3](https://github.com/mannyc2/effect-agent-browserbase/pull/3). Its immutable source identity, exact acceptance results and artifact checksums are retained in the [2026-09-19 acceptance record](history/2026-09-19-acceptance.md).

Current maintenance uses `Library CI` and a separate, manual, default-off npm OIDC workflow. Check the exact current PR/commit's Actions results; the historical acceptance record is not a claim that later changes were tested. Release procedures and required account configuration are in [RELEASING.md](RELEASING.md).

No npm version has been published from this repository. Hosted Browserbase allocation/cleanup, Live View authorization and actual operator handoff, persistent-context behavior, provider keep-alive reconnection, real provider files/recordings/replays and signed-URL expiry remain separately authorized hosted checks. Local CDP/video and scripted-provider results are not substituted for those guarantees.

## Historical material

`checkpoints/` is preserved byte-for-byte as provenance and is not needed to bootstrap current source. The old transfer handoff, canonical-input fetcher and transient development logs were retired from active paths. Their original bytes remain available at merge commit `e61e3d75c15cbd467e196170fce5c064c13d4bb0` in Git history:

```sh
git show e61e3d75c15cbd467e196170fce5c064c13d4bb0:docs/handoff.md
git show e61e3d75c15cbd467e196170fce5c064c13d4bb0:tools/fetch-inputs.py
git ls-tree -r e61e3d75c15cbd467e196170fce5c064c13d4bb0 results/
```

Do not follow historical transfer instructions as current contributor requirements. The maintained development entry point is [CONTRIBUTING.md](../CONTRIBUTING.md).
