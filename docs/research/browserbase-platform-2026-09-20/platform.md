# Browserbase platform: resources, boundaries, and consequential constraints

Research date: **20 September 2026**. Repository baseline: [`1b3e9b1`](https://github.com/mannyc2/effect-agent-browserbase/commit/1b3e9b1916621d036f2568c821e83bed72400f9c). This chapter records provider and automation contracts; recommendations are explicitly identified. The capability map and proposed architecture are separate chapters.

## 1. Begin with the platform, not the adapter's options

The [official documentation index](https://docs.browserbase.com/llms.txt) distinguishes browser sessions, reusable Contexts, uploaded extensions/certificates, session artifacts, and project administration. These are not interchangeable forms of a single browser configuration. The appropriate resource graph is:

```text
Project / API credential
  ├─ Context ──────────────┐  reusable persisted browser data
  ├─ Extension upload ────┤  referenced when launching
  ├─ CA certificate ─────┤  referenced when launching
  └─ Session ◄───────────┘  finite remote browser execution
       ├─ native default BrowserContext
       │    └─ pages → frames → individual documents
       ├─ zero or more remote automation / viewing connections
       ├─ debug URLs / logs / session metadata
       └─ uploads, downloads, replay pages, MP4 renditions
```

The REST API owns resource allocation, metadata, release requests and artifact retrieval. Playwright owns connected-browser operations. The consumer owns application identities, coordination, authorization, secrets, retention policy and business success conditions. Neither a Browserbase API success nor a successful click proves that an application workflow completed. [Sources: API resource declarations](https://github.com/browserbase/sdk-node/tree/v2.20.0/src/resources), [native context semantics](https://github.com/microsoft/playwright/blob/v1.63.0/docs/src/api/class-browsercontext.md).

## 2. Versions and evolution actually relevant here

There is **no installed Browserbase SDK to upgrade** in this package. The [package manifest](https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/package.json) declares an owned HTTP implementation and optional-peer `playwright-core@1.63.0`. The coordinated workspace is Effect `4.0.0-rc.115`, effect-agent `0.1.0-beta.102`, TypeScript `7.0.2`; see [CONTRIBUTING](https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/CONTRIBUTING.md). A sandbox installation was not available; these are source-declared/acceptance pins, not a claim that dependencies were installed during this review.

The official Node SDK's latest published GitHub release at inspection was [2.20.0, published 9 September 2026](https://github.com/browserbase/sdk-node/releases/tag/v2.20.0). Its [changelog](https://github.com/browserbase/sdk-node/blob/v2.20.0/CHANGELOG.md) records browser-relevant changes the adapter must evaluate regardless of whether it adopts the runtime SDK:

| Release | Browser-relevant change | Design consequence |
| --- | --- | --- |
| 2.10 / 2.11 | Verified; `PENDING` session state; replay resources | Do not reduce identity to viewport or assume allocation always means connection-ready. |
| 2.13 / 2.14 | Certificate CRUD and `proxySettings.caCertificates` | Corporate proxy trust is a resource reference, not a blanket TLS bypass. |
| 2.15 | `allowedDomains` documented and ungated | Useful navigation restriction; not an exact-host network sandbox. |
| 2.17 | Context names; Context upload deprecation; SDK timeout parameter naming | Avoid obsolete upload examples and distinguish SDK arguments from wire fields. |
| 2.19 | Debug URL `expiresIn` | Existing adapter TTL forwarding already covers this. |
| 2.20 | Webhooks | Current event union is **Functions-only**, not browser-session or Context-flush events. |

The SDK's [`Sessions.create`](https://github.com/browserbase/sdk-node/blob/v2.20.0/src/resources/sessions/sessions.ts) accepts `api_timeout` and maps it to REST `timeout`. `RequestOptions.timeout` is a client request deadline. The adapter already sends the correct REST field; replacing it with `api_timeout` on the wire would introduce a defect. Many guide snippets still use `timeout` in SDK calls: verify generated source, not snippets alone.

The [public product changelog](https://www.browserbase.com/changelog), documentation index and SDK changelog are complementary discovery inputs, not a complete compatibility specification. Independently offered inference, agents, search/fetch and hosted Functions are not proposed as dependencies. (Update, [#32](https://github.com/mannyc2/effect-agent-browserbase/issues/32): they are now wrapped as separate host-only services on the existing Client, still without an SDK or other new dependency.) In particular, the current [webhook event types](https://github.com/browserbase/sdk-node/blob/v2.20.0/src/resources/webhooks.ts) do not justify replacing session polling with an imagined `session.completed` or `context.persisted` webhook.

## 3. Contexts are durable data, not a running browser

Browserbase [Contexts](https://docs.browserbase.com/platform/browser/core-features/contexts) persist Chromium user-data-directory state. The guide expressly includes cookies (including session cookies), local storage, IndexedDB, **Session Storage**, service workers, Web Data and preferences. Session Storage is also described as tab-scoped: that is not a guarantee that a new tab restores a former tab's identity. Contexts should not be represented as snapshots of DOM, JavaScript heap, active connections, open pages or timers.

A session selects `browserSettings.context = { id, persist }`. `persist: false` prevents saving changes back; it does not make the running website read-only. With `persist: true`, saving happens after the session closes, and the guide recommends allowing synchronization time. Avoid concurrent reuse of the same Context. The guide does **not** specify transactional commits, merge behavior, a last-writer-wins algorithm, or crash-safe flush guarantees. These distinctions matter more than a convenience `save()` method.

[Context API source](https://github.com/browserbase/sdk-node/blob/v2.20.0/src/resources/contexts.ts) provides create, retrieve and delete. Names are trimmed and unique case-insensitively within a project's active Contexts. Retrieval returns timestamps, not a revision/flush acknowledgement. There is no current listing method in that resource. Application lookup by customer/account therefore needs a consumer-owned database mapping; a name is not a documented lookup API.

Legacy `update` and `uploadUrl` remain in SDK types, but the latter is explicitly a non-functional sentinel: **API Context uploads are no longer supported**. Do not build profile-import/export promises from residual encryption metadata. Deletion is an explicit destructive operation, not the finalizer of a session that happens to use the Context. [Sources: SDK Context resource above; create/get/delete references linked from the documentation index.]

**Recommended interpretation:** treat remote termination and persistence visibility as separate facts. `COMPLETED`, `ERROR` or `TIMED_OUT` can prove that a writer is no longer running, but none is a documented flush receipt. Hold a consumer-owned exclusive writer lease through termination and the chosen persistence-reuse policy. Quarantine an unknown writer. A fixed delay or `updatedAt` change may be useful operational evidence, but must never be labeled a provider guarantee. Test cookies, IndexedDB, Session Storage and extension storage independently; do not infer one from another.

A Browserbase Context is distinct from **Effect `Context`** (service environment) and **Playwright `BrowserContext`** (live browser isolation/page container). Creating `browser.newContext()` is not attaching a Browserbase Context. Use the provider's default native context for the integration's supported recording/persistence path; additional native contexts need separate hosted verification rather than being silently treated as equivalent. [Playwright reference](https://github.com/microsoft/playwright/blob/v1.63.0/docs/src/api/class-browsercontext.md), [Browserbase authentication example using the default context](https://docs.browserbase.com/platform/identity/authentication).

## 4. Session and connection lifecycles

The [Sessions SDK resource](https://github.com/browserbase/sdk-node/blob/v2.20.0/src/resources/sessions/sessions.ts) distinguishes creation, retrieval, listing, release requests and debug URLs. Session states are `PENDING`, `RUNNING`, `ERROR`, `TIMED_OUT`, `COMPLETED`; `REQUEST_RELEASE` is an update command, not a terminal state. A successful release request must not be reported as confirmed shutdown without a subsequent observation.

[Keep-alive](https://docs.browserbase.com/platform/browser/long-sessions/keep-alive) keeps a remote session alive after disconnection on eligible paid plans. The session continues consuming time and remains subject to its timeout. It is neither persistent Context storage nor a suspension of page execution. Reconnect while that session is still running; create a new session with a Context when the old session has ended. These are different recovery strategies with different guarantees.

The [timeout](https://docs.browserbase.com/platform/browser/long-sessions/timeouts) is a provider lifetime, with [REST bounds of 60–21,600 seconds](https://docs.browserbase.com/reference/api/create-a-session). HTTP request timeout, native connection timeout, action timeout, human-handoff timeout and execution budget should be independent, named settings. The present adapter derives remote lifetime from `maxElapsedMillis`, which is convenient for bounded jobs but constrains durable-session supervision.

Connect URLs and Selenium signing credentials are authority-bearing values, not durable user-facing identifiers. Retrieve them server-side for the exact project/session, validate endpoints, redact them, and keep them out of journals and agent tools. Multiple connections being possible on the platform does not make concurrent automation safe. The adapter should maintain one mutation authority; a Live View operator must explicitly hand control back. Remote permission to connect is not proof that no other client is still mutating the browser.

## 5. Launch settings, identity and network configuration

Use [the current session create types](https://github.com/browserbase/sdk-node/blob/v2.20.0/src/resources/sessions/sessions.ts) as the naming authority: `region`, `proxies`, `proxySettings`, `extensionId`, `keepAlive`, `userMetadata`, and `browserSettings` with Context, viewport, recording/logging, CAPTCHA, ad blocking, Verified/OS, allowed domains and certificate-error settings. Do not invent provider-native launch arguments, locale, timezone, permissions or initialization-script fields that are absent from this contract.

[Verified](https://docs.browserbase.com/platform/identity/verified-customization) supplies a coherent fingerprint/OS profile. Its viewport is not customizable; Browserbase explicitly advises against overriding viewport or user agent. OS selection without Verified is invalid. **Recommendation:** model viewport as `ProviderManaged` versus `Fixed`, reject incompatible configurations before allocating, and prevent native setup/resizing from undoing Verified. Do not hard-code the guide's approximate profile dimensions.

[Proxies](https://docs.browserbase.com/platform/identity/proxies) support managed residential routing, external HTTP/HTTPS proxies and ordered domain rules including `none`. First matching rule wins. Geography is best effort, not a guaranteed IP or GPS fix. Proxy location, browser region, browser geolocation and timezone are separate. Preserve rule order and protect proxy credentials. Target-site/provider restrictions mean proxy failures should remain distinguishable from browser-action failures. Prefer referenced project CA certificates for trusted interception instead of disabling all certificate validation.

Four documented [browser regions](https://docs.browserbase.com/optimizations/latency/multi-region) are currently `us-west-2`, `us-east-1`, `eu-central-1`, `ap-southeast-1`. Region is a launch choice, not an assurance about every artifact's storage location. Consistency of identity settings belongs in the consumer's versioned environment recipe; do not persist secrets in that recipe.

`allowedDomains` restricts **main-frame navigation**, includes subdomains, and does not constrain iframe or subresource traffic. Empty means unrestricted. Therefore it cannot implement the framework's `ExactHosts` or `PublicWeb` guarantees. Preserve the adapter's refusal of those policies; expose the provider setting under its actual semantics. Request interception is likewise not a complete sandbox: [Playwright documents service-worker interception gaps](https://github.com/microsoft/playwright/blob/v1.63.0/docs/src/api/class-browsercontext.md). A consumer requiring comprehensive network containment needs an independently enforced egress boundary, not a renamed navigation filter.

[Concurrency documentation](https://docs.browserbase.com/optimizations/concurrency/overview) separates simultaneous-session limits from create-rate limits and describes rejected `429` requests and retry headers. Do not bake plan tables into schemas. Add admission/backoff hooks, retain rate-limit diagnostics, and distinguish a known rejection from a lost POST response. Retrying the latter can allocate duplicate billable browsers. A `PENDING` state is not evidence of a durable provider queue available to consumers.

## 6. Browser customization has several owners

[Extensions](https://docs.browserbase.com/platform/browser/core-features/browser-extensions) are uploaded ZIP resources with `manifest.json` at the root, currently capped at 100 MB. A session references an extension at creation; browser restart/loading adds startup work. The API exposes singular `extensionId` rather than an extension array. Upload, launch and delete are distinct operations. Prefer the top-level field; the SDK also has a nested alias, whose precedence should not be guessed when both are present.

Chrome owns [content-script matching, execution worlds and injection timing](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts), and [Manifest V3 service-worker lifetime](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle). Extension background code is not a permanently running daemon; persistent application state cannot live only in its heap. Extension permissions are not interchangeable with website permission grants. Extension storage persistence with Browserbase Contexts, identity stability and reconnect behavior need explicit hosted checks.

Playwright owns cookie APIs, permission overrides, routing, scripts, page evaluation and bindings. Its pinned [1.63 context documentation](https://github.com/microsoft/playwright/blob/v1.63.0/docs/src/api/class-browsercontext.md) is especially relevant: context initialization covers new documents and frames; multiple init-script ordering is unspecified; `exposeBinding` carries caller frame/page information. Version 1.62 added function exposure through init scripts. These existing mechanisms should underpin a small owned initialization/ready-state layer, not a parallel injection engine. Reinstallation must be tested across connection replacement; installing a script after a page ran cannot retroactively precede that page's application code.

[Authentication guidance](https://docs.browserbase.com/platform/identity/authentication) recommends human login through Live View followed by Context reuse. Website sessions can still expire or be revoked. Keep MFA and credential retrieval consumer-owned; this review does not recommend disabling MFA, even where a provider example suggests it. CAPTCHA solving is a provider launch feature, not a universal success guarantee or a substitute for a bounded workflow readiness check. [CAPTCHA guide](https://docs.browserbase.com/platform/identity/captcha-solving).

## 7. Files, viewing and observability are different products of a session

Small [uploads](https://docs.browserbase.com/platform/browser/files/uploads) can use native in-memory file selection. Larger uploads use the Session Uploads API and a remote-file attachment path. The upload and attachment must compose; exposing only the upload endpoint leaves the workflow incomplete. The remote browser cannot open a file picker on the consumer's machine. Manual upload in Live View needs a host UI and explicit file-chooser coordination. Never allow a model to turn an arbitrary server pathname into a file upload.

[Live View](https://docs.browserbase.com/platform/browser/observability/session-live-view) offers session- and tab-specific URLs. Its documented read-only example disables pointer events in CSS; that is presentation behavior, **not a read-only authorization token**. A copied URL may still carry control authority. Secure issuance and audience authorization on the host, bound TTLs, and validate both origin and source when accepting iframe messages.

[Replay](https://docs.browserbase.com/platform/browser/observability/session-replay) exposes per-page HLS playback. [Recording downloads](https://docs.browserbase.com/platform/browser/observability/recording-downloads) asynchronously assemble per-page MP4s after termination, with separate per-page statuses. Recording supports up to ten concurrently open tabs; this is not equivalent to the adapter's configurable live page limit. Re-POSTing requests re-enqueues pages, so do not hide it inside polling. Refresh signed URLs rather than persisting them. A replay page ID, native CDP target ID and adapter `page-N` are not established as the same identifier.

[BYOS](https://docs.browserbase.com/account/enterprise/byos-setup-guide) can route Contexts, extensions, files, logs and final MP4s to consumer storage, with separate configuration per artifact type. Raw recording material remains in Browserbase storage temporarily even with BYOS. [ZDR](https://docs.browserbase.com/account/enterprise/zero-data-retention) is a separate policy; do not equate `recordSession: false` or `logSession: false` with comprehensive zero retention. Retention, BYOS readiness and absence of URLs must be represented explicitly. None of these modes removes the consumer's responsibility for locally captured frames, logs or downloaded files.

**Recommendation:** retain separate live-capture, replay, recording and download APIs. Add session inspection and logs without loading Playwright. Build a bounded diagnostic journal correlating provider session, connection generation, page/frame, operation and artifact identity. A recorded tab is evidence of rendered activity, not confirmation of a business operation, an audio guarantee or a synchronized multi-page broadcast.
