# Project status

The Browserbase runtime's completed unpaid implementation was merged in [PR #3](https://github.com/mannyc2/effect-agent-browserbase/pull/3). Its immutable source identity, exact acceptance results and artifact checksums are retained in the [2026-09-19 acceptance record](history/2026-09-19-acceptance.md).

Current maintenance uses `Library CI` and a separate, manual, default-off npm OIDC workflow. Check the exact current PR/commit's Actions results; the historical acceptance record is not a claim that later changes were tested. Release procedures and required account configuration are in [RELEASING.md](RELEASING.md).

No npm version has been published from this repository. Live View authorization and actual operator handoff, persistent-context behavior, provider keep-alive reconnection, real provider files/recordings/replays and signed-URL expiry remain separately authorized hosted checks. Local CDP/video and scripted-provider results are not substituted for those guarantees.

The capabilities added after that merge — extension provisioning and launch selection, session uploads with modeled file selection, the bootstrap plan with per-document readiness, and borrowed attachment — are covered by unpaid acceptance only. Extension load and storage identity, provider upload identity and routing, and registration retention across a provider reconnect are hosted questions that no local run answers.

The platform services added for [#32](https://github.com/mannyc2/effect-agent-browserbase/issues/32) — session logs, project-wide Live View links, download filters and deletion, Projects, Certificates, Search, PageFetch, Webhooks, Agents and Functions, alongside the scoped binding runner, the single account layer, standalone scoped allocation, and the credential, policy and recipe defaults — carry the same unpaid-only standing. No request in that set has been sent to Browserbase; log payload sizes and Functions behavior stay unobserved. The signed-URL host is no longer among the unknowns — see the 21 September 2026 run below — but it is recorded as an observation rather than adopted as a default, because the specification promises only a "signed CDN URL" and the observed value is an opaque CDN distribution the provider can re-point without notice.

`internal/provider/Contract.ts` records the reviewed session-create subset against two authorities, and `node tools/verify-launch-contract.mjs` checks it against both. On 21 September 2026 that check re-derived all nine request fields and fourteen `browserSettings` fields from the pinned SDK revision `fe805b86cd860436eae63a2551b12cf02d708ce1`, whose bytes matched the recorded digest, and from the published OpenAPI specification, which names `timeout` directly and so establishes the SDK's `api_timeout` as a rename rather than a competing contract. `browserSettings.advancedStealth` and `browserSettings.extensionId` remain the only deliberate exclusions, and v2.20.0 was the latest SDK release at that time. The check reads the network and is run deliberately; ordinary acceptance covers its parsing rules offline against synthetic sources, so a provider field added later fails a deliberate check rather than any scheduled one.

[HOSTED.md](HOSTED.md) describes the manual, default-off workflow those checks run under and the separate demo recording that documentation publishes. A demo recording is documentation rather than evidence for any check above; the run records below are the evidence for the two checks they cover.

## Hard-cutover callback implementation, 21 September 2026

The implementation in PR #31 now connects `Bootstrap.binding` to the actual generic browser owner. Bootstrap is acquired through `open`, `acquire`, `attach` or `withBrowser`, not stored as an environment-free browser Layer option. Handler errors and services survive heterogeneous plan composition; invocation Scope is discharged. `fromSession` adapts that exact generic session into the fixed Agent Toolkit without another allocation, connection, action budget or capture reservation.

Callback admission, input/output bytes, codecs, deadlines, native replies and late native completion are bounded. Native execution-context identity and origin authorize decoding and handler work; the calling document is rechecked before a reply can be published. The pinned Playwright callback exposes only a frame, which survives navigation, so the implementation uses maintained Chromium Runtime bindings on child CDP sessions belonging to the existing connection rather than treating the frame's replacement URL as caller authority. Page replies never contain consumer causes or host stacks. Registration failure also supervises a waiting workflow while its page-action admission is paused; a retired connection cannot fault its replacement.

Natural Scope shutdown and explicit close share the same order: fence browser and callback admission, interrupt managed callbacks, remove owned registrations, disconnect locally, and independently reconcile remote release. The focused regression reproduces the old failure—callback finalizers dispatching before the fence—under both sequential and parallel application parent scopes. It now requires that attempted finalizer action to fail closed and undispatched, followed by one confirmed cleanup receipt. The maintained generic and actual AgentRuntime consumer programs exercise typed callbacks alongside shared actions and live capture. Exact-commit acceptance remains the authority for which candidate artifacts and checks passed.

This is **not a claim that all maintainer-plan work is complete**. In particular, the Stage 0A trusted injectable, native-neutral Effect binding service is still missing: the private connector seam remains Promise-based, and the maintained generic and Agent fixtures still replace `chromium.connectOverCDP`. Borrowed attachment accepts a durable reference, but the maintained native workflow has not yet proved the handoff from a separately started consumer process. Those are independent implementation/acceptance work, not hosted-only blockers.

H1–H7 also still need their complete runnable experiment harnesses. The existing hosted command is a guarded one-session smoke test, not those seven experiments. Their execution additionally requires explicit authorization for the disposable resources and per-experiment spending budget, approved artifact origins and the relevant operator, persistent-Context, extension/profile, upload/proxy/CA or BYOS/ZDR fixture controls. The earlier owner-authorized hosted runs below are retained as their actual limited evidence; this callback slice made no hosted calls and does not expand that authorization.

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

## Owner-authorized hosted acceptance, 21 September 2026

The repository owner supplied credentials and authorized paid execution. `tools/hosted-acceptance.sh` ran once, from a bootstrapped workspace whose `packages/browserbase` source matched `c694403` apart from README prose, and exited 0. One session was allocated, no model was invoked, and no second session was created. Account, project and session identifiers are deliberately omitted: they identify the owner's provider account rather than this source, and the run's own JSON record retains them privately.

It allocated, connected over CDP, navigated to `https://example.com/` and read 129 text bytes, captured a 29,810-byte screenshot, ran live capture to its duration limit with `nativeStop: "confirmed"`, `dropped: 0` and `duplicates: 0`, retrieved one Live View page at a 120-second requested TTL, and released with `releaseRequested: true`, `remote: "confirmed"`, `local: "closed"`, `observedStatus: "COMPLETED"` and no issues. It then requested the provider recording, observed one page go `PENDING` to `COMPLETED` with `delivery: "download"`, and streamed 1,629,128 bytes of it.

That download is what lifts the signed-URL blocker, because the bytes arrived through the `artifactOrigins` check rather than around it. The origin itself is not recorded here. It is an opaque CDN distribution rather than a branded endpoint, the specification promises only a "signed CDN URL", and the observation covers one project in one region, so it cannot be published as the host every consumer should trust — and a BYOS project returns no signed URL at all. What generalizes is the procedure: read `downloadUrl` from `GET /v1/sessions/{id}/recording/downloads` for a completed session and approve exactly that origin. Keeping it explicit means a host change surfaces as a refused transfer rather than as this client trusting whatever later answers at a name compiled into it.

This run does not establish operator takeover and release, persistent-context durability, keep-alive reconnection against the provider, extension load and storage identity, provider upload identity and routing, or replay and BYOS delivery. Retrieving a Live View URL is not authorization or handoff. Those remain separately authorized checks, and no probe for them was run.

## Historical material

`checkpoints/` is preserved byte-for-byte as provenance and is not needed to bootstrap current source. The old transfer handoff, canonical-input fetcher and transient development logs were retired from active paths. Their original bytes remain available at merge commit `e61e3d75c15cbd467e196170fce5c064c13d4bb0` in Git history:

```sh
git show e61e3d75c15cbd467e196170fce5c064c13d4bb0:docs/handoff.md
git show e61e3d75c15cbd467e196170fce5c064c13d4bb0:tools/fetch-inputs.py
git ls-tree -r e61e3d75c15cbd467e196170fce5c064c13d4bb0 results/
```

Do not follow historical transfer instructions as current contributor requirements. The maintained development entry point is [CONTRIBUTING.md](../CONTRIBUTING.md).
