# Evidence ledger and review limits

## 1. Revisions and what was actually verified

**Research and structural follow-up date:** 20 September 2026. **Repository source baseline:** [`1b3e9b1916621d036f2568c821e83bed72400f9c`][baseline]. `main` still pointed to this commit when the structural follow-up began. The earlier completed report head was `e3bd70754bb1cfd8604a53aa6aba9d76e5b213ff`; subsequent commits extend that same research branch and draft PR #30. No runtime source, manifests, lockfiles or workflow files are changed by this documentation task.

The official Browserbase SDK's inspected main and latest published GitHub release resolved to **`fe805b86cd860436eae63a2551b12cf02d708ce1`**, [v2.20.0, published 9 September 2026][sdk-release]. There is no Browserbase SDK dependency in the current package: comparisons concern its owned Effect HTTP implementation versus upstream contract/source, not an installed SDK upgrade.

Repository pins were verified from current source and tooling: Effect **4.0.0-rc.115**, TypeScript **7.0.2**, effect-agent/testing **0.1.0-beta.102**, Playwright **1.63.0**, Vite+ **0.3.2**, Node **24.14.1**, Bun **1.4.2**, pinned upstream **`ea53ea6671a94eb44b8019e942cc2c9468786723`**. These are supported acceptance inputs, not a statement that every version admitted by a peer/engine range is tested. [Manifest][manifest], [CONTRIBUTING][contributing], [upstream integration patch][patch], [packed-consumer dependency pins][packed-consumer].

### Exact Effect guidance, rather than a current-version tutorial

The `effect@4.0.0-rc.115` release ref resolves to **`4a05d4914fa2327a42bd75fe77c22c188becf3b4`** in `Effect-TS/effect`. The published package's `AGENTS.md` is generated: the [pinned copy-ai-docs script][effect-copy] copies the repository's root [LLMS.md][effect-guide] into each published package as `AGENTS.md` and `CLAUDE.md`. The entire guide was read through its final cluster section. This is the source of the installed guidance, not a claim that a nonexistent local `node_modules/effect/AGENTS.md` was read.

The follow-up also inspected the pinned [Scope source][effect-scope], [FiberSet source][effect-fiberset], [Layer composition example][effect-layers] and Layer API while developing conventions. Scope-providing helpers remove Scope from their environment; a scoped FiberSet runtime captures required services and owns child fibers; neither mechanism makes native browser mutations transactional. The default framework conventions were checked in [the pinned upstream AGENTS.md][upstream-agents], not inferred from a newer upstream release.

### Execution boundary

The sandbox's Git transport could not resolve `github.com`; a fresh `git ls-remote` attempt in the follow-up failed with **`Could not resolve host: github.com`**. Publisher access also failed with **`Could not resolve host: registry.npmjs.org`**. The host reported **Node v22.16.0**, no Bun executable, and no checkout/dependencies under `/mnt/data`. The earlier review had likewise failed to clone. No alternate unpinned compiler/runtime was substituted for the required workspace.

Consequently this task ran **no pinned formatter, TypeScript check, Effect/package tests, native Chromium suite, packed consumer or hosted Browserbase experiment**. New code blocks are proposed, source-reviewed sketches and explicitly uncompiled; current-API blocks are source-aligned, not fresh execution evidence. An interface snippet with declared collaborators is not a compiled implementation. Type assertions and executable consumer programs are stage acceptance requirements, not results claimed by this PR.

GitHub connector reads/writes remained available. Incremental documentation commits were therefore made through that connector after ordinary Git access failed. This is a constrained documentation fallback, not a recommendation to replace normal source maintenance with full-file API writes. Each changed file used its current blob SHA, and PR/branch metadata provides the durable remote commit record. No temporary CI scratchpad workflow, publishing, hosted credential, paid session or model call was used.

## 2. Evidence categories

| Category | What it supports | What it does not support |
| --- | --- | --- |
| Official provider/API/SDK source | Browserbase terminology, current resource fields, documented behavior/constraints | Unspecified overlap/flush ordering, an account's entitlement, new hosted observations |
| Exact pinned Effect/Playwright source | Signatures and intended native/resource semantics relevant to the design | Compilation of proposed package APIs or proof of hosted Chromium behavior |
| Current repository implementation | Dependency direction, actual request projection, owner/cleanup paths and inaccessible public capabilities | A provider behavior occurring in this review |
| Inspected test assertions | Existing intended type/lifecycle/dispatch/capture contracts | A fresh pass or a root-cause diagnosis of an intermittent failure |
| Maintainer issue/PR reports | Attributed historical observations and decisions | Independently downloaded/rerun artifacts in this task |
| Proposed design and acceptance criteria | Specific package/module/API/compatibility decisions and falsifiable checks | A new installed package, implemented export or verified experiment |

No example is labeled typechecked. No historical test count is carried forward as a current result. Ordinary CI running against documentation does not typecheck fenced Markdown proposals or establish new package boundaries that do not yet exist.

## 3. Primary provider research trail retained from the original review

Start with the [official documentation index][docs-index], [session creation API][create-session], [SDK resources][sdk-resources] and [SDK changelog][sdk-changelog]. Provider-specific claims remain cited where they occur in [platform.md](platform.md) and [capability-map.md](capability-map.md), rather than resting only on this bibliography.

| Area | Primary references / inspected mechanisms |
| --- | --- |
| Contexts | [Context guide][context-doc], [SDK create/retrieve/delete, naming and deprecated upload fields][context-sdk] |
| Session lifetime/settings | [SDK sessions][sessions-sdk], [keep-alive][keepalive], [timeouts][timeouts] |
| Identity/network | [Verified][verified], [proxies][proxies], [authentication][authentication], [CAPTCHA][captcha]; exact SDK allowedDomains/CA/settings definitions |
| Geography/admission | [regions][regions], [concurrency][concurrency] |
| Customization | [Browserbase extensions][extensions], [pinned native context scripts/bindings/permissions][pw-context], [Chrome content scripts][chrome-scripts], [MV3 worker lifecycle][chrome-workers] |
| Files and media | [uploads][uploads], [downloads][downloads], [Live View][live-view], [replay][replay], [MP4 downloads][mp4] |
| Privacy/storage | [BYOS][byos], [ZDR][zdr] |
| Evolution and scope | [product changelog][changelog], [SDK webhook event union][webhooks] |

The original review checked publication dates and event scope: September webhooks concern Functions, not invented session/Context events; Context naming, BYOS logs and recording downloads are relevant browser changes. Search, model inference/routing, hosted autonomous agents and Functions deployment were not made package requirements. Some documentation destinations were unavailable; exact SDK definitions were used where appropriate without pretending every index destination had been read.

## 4. Implementation and tooling trace ledger

Repository instructions, root/package READMEs, CONTRIBUTING, exports and neighboring tests were read before design changes. The structural follow-up revisited the actual ownership and distribution constraints rather than treating the previous report as source truth.

| Concern | Inspected source | Consequence for proposal |
| --- | --- | --- |
| Mandatory framework dependency | [manifest][manifest], [InteractiveBrowser][host], [public type tests][type-tests] | Generic G package removes framework dependency; A preserves BrowserHandle/legacy signatures. Optional/lazy Playwright already exists and does not justify another split |
| Shared account configuration | [HTTP][http], [host][host], [Recordings][recordings], [Replays][replays], [Downloads][download-source] | One Client Layer; strict credentials; feature services own routes. No invented claim of existing per-client rate schedulers |
| Allocation and remote cleanup | [Provider][provider], [Session][session], [ownership assertions][ownership-tests] | Pre-POST attempt journal, known identity before URL validation, independent release/terminal/local facts, writer quarantine |
| Mutation/late continuation authority | [Owner][owner], [Session][session] | Retain nonwaiting permit, tickets and immediate fencing. New service/module boundaries do not cancel dispatched native work |
| Native monolith and data ownership | [Playwright][playwright], [Driver][driver], [Types][types] | Separate Targets/Documents/Observation/Actions and native primitives; feature-owned schemas; no raw SDK declaration escape |
| Capture and page holds | [Capture][capture-source], [PageControl][page-control], [PageExecution][page-execution] | Single canonical generic session association and aggregate budgets; no duplicate adapter capture registry; preserve hold restrictions |
| Real framework composition | [agent example][agent-example], Tools and public type tests | Adapter keeps actual AgentRuntime/Tool/Toolkit usage. New generic browser example does not import the framework |
| One-package bootstrap | [bootstrap.sh][bootstrap] | Explicit two-root tracked-file inventory and fresh/frozen workspace gate required before split is accepted |
| Lock/catalog and compatibility harness | [upstream.patch][patch], [upstream AGENTS][upstream-agents] | Coordinated workspace entries, dependency/build/exports/purity inventories and changesets; no accidental unrelated upstream refactor |
| Single tarball publication | [package-release.mjs][package-release] | Current hard-coded name/export allowlist and allowed workspace dependency need explicit two-package version map/release-set schema |
| External consumer limitations | [packed-consumer.sh][packed-consumer] | Current consumer always installs framework/native dependencies; add resources-only/generic-browser/agent/legacy consumers, candidate tarballs and declaration closure checks |

This is an architectural/source review, not a claim that every line of every fixture or historical CI artifact was independently analyzed. Exact paths and inspected symbols support each consequential design choice. New file trees and module names are proposals; current support rows are not relabeled implemented simply because a target owner has been assigned.

## 5. Historical observations and accepted boundaries

[#6's hosted report][composition-issue] supplies a concrete runtime failure from shared options and a successful bounded hosted flow after the example fix. The current source independently explains the mismatch. That historical session covered allocation/observation/screenshot/capture/Live View/terminal cleanup/recording download. It did not verify Context synchronization, Verified setup, extension persistence, arbitrary bootstrap or fresh-process recovery.

[PR #27][pr27] recorded the private-native/no-general-CDP and adapter-specific vocabulary boundary. The [latest #4 disposition][issue4] recognizes implemented target-pinned capture/sizing/page control, accepts local Tool divergence and moves binding composition into #6. The proposal adds a trusted native-neutral binding and generic framework-independent package; it does not assert upstream approval, revive parked #7 or permit unguarded second-client automation.

[#9][issue9], [#19][issue19] and [#28][issue28] record distinct native failures. Their artifacts were not downloaded or rerun here. Source-based explanations remain hypotheses until tested. Their continued investigation is separate from extraction; a later green run does not diagnose or fix them. [#13][issue13] remains an audio question; MP4 MIME/container metadata is not proof of an audio track.

## 6. Verification gates added by the structural follow-up

The proposal's acceptance is intentionally stronger than repository-local import checks:

- A resources-only installed consumer must resolve generic emitted exports/declarations with no framework, testing package, Playwright or dev-only SDK. Check `skipLibCheck:false` and inspect the dependency/declaration graph.
- A generic real-browser consumer must run the local native workflow without Effect Agent; the agent and legacy consumers must prove both packages use the same owner and retain the old signatures/behavior.
- Two unmodified candidate tarballs must be installed together; release-set receipts, exact dependency versions, source revisions and byte hashes must agree. Consumer-only local overrides must not alter production manifests or fetch a different registry build silently.
- E/R assertions must cover callback-specific services/errors, post-install failure supervision, heterogeneous bootstrap plans, explicit Scope acquisition and Scope discharge from both library and consumer work.
- Failpoints must preserve allocation identity, late connection disposal, pre/post-dispatch classification, callback bounds, close coalescing, explicit ordering and independent local/remote/writer outcomes.

These are **future stage gates**, not completed tests. Full canonical acceptance remains required for implementation: exact pins, fresh bootstrap, canonical Vite+ commands, emitted examples, local native tests and read-only CI.

## 7. Provider uncertainties remain unresolved

[H1–H7](implementation-plan.md#hosted-experiments-and-unresolved-questions) retain the original bounded hosted questions: per-store Context visibility and abnormal endings; overlap/deletion; extension identity/storage; reconnect registration/cleanup; multi-page artifact correspondence/audio; files/network/certificates; retention/observability. The structural follow-up adds cleanup-order and callback-registration checks to the relevant groups, not new guarantees.

A local cleanup receipt can report a terminal session without proving a Context flush. A consumer readback is narrower evidence, not a transaction across every store. A successful generic-package typecheck would not prove Browserbase enforces a consumer's distributed lease. Keep those distinctions explicit until actual provider evidence supports a stronger contract.

[baseline]: https://github.com/mannyc2/effect-agent-browserbase/commit/1b3e9b1916621d036f2568c821e83bed72400f9c
[sdk-release]: https://github.com/browserbase/sdk-node/releases/tag/v2.20.0
[manifest]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/package.json
[contributing]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/CONTRIBUTING.md
[patch]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/upstream.patch
[effect-copy]: https://github.com/Effect-TS/effect/blob/4a05d4914fa2327a42bd75fe77c22c188becf3b4/scripts/copy-ai-docs.mjs
[effect-guide]: https://github.com/Effect-TS/effect/blob/4a05d4914fa2327a42bd75fe77c22c188becf3b4/LLMS.md
[effect-scope]: https://github.com/Effect-TS/effect/blob/4a05d4914fa2327a42bd75fe77c22c188becf3b4/packages/effect/src/Scope.ts
[effect-fiberset]: https://github.com/Effect-TS/effect/blob/4a05d4914fa2327a42bd75fe77c22c188becf3b4/packages/effect/src/FiberSet.ts
[effect-layers]: https://github.com/Effect-TS/effect/blob/4a05d4914fa2327a42bd75fe77c22c188becf3b4/ai-docs/src/01_effect/03_services/20_layer-composition.ts
[upstream-agents]: https://github.com/danieljvdm/effect-agent/blob/ea53ea6671a94eb44b8019e942cc2c9468786723/AGENTS.md
[bootstrap]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/tools/bootstrap.sh
[package-release]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/tools/package-release.mjs
[packed-consumer]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/tools/packed-consumer.sh
[host]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/src/InteractiveBrowser.ts
[type-tests]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/test/public-types.test.ts
[http]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/src/internal/Http.ts
[provider]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/src/internal/Provider.ts
[session]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/src/internal/Session.ts
[owner]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/src/internal/Owner.ts
[ownership-tests]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/test/fixtures/OwnershipCases.ts
[playwright]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/src/internal/Playwright.ts
[driver]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/src/internal/Driver.ts
[types]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/src/Types.ts
[recordings]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/src/Recordings.ts
[replays]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/src/Replays.ts
[download-source]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/src/Downloads.ts
[capture-source]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/src/Capture.ts
[page-control]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/src/PageControl.ts
[page-execution]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/src/internal/PageExecution.ts
[agent-example]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/examples/agent.ts
[docs-index]: https://docs.browserbase.com/llms.txt
[create-session]: https://docs.browserbase.com/reference/api/create-a-session
[sdk-resources]: https://github.com/browserbase/sdk-node/tree/v2.20.0/src/resources
[sdk-changelog]: https://github.com/browserbase/sdk-node/blob/v2.20.0/CHANGELOG.md
[context-doc]: https://docs.browserbase.com/platform/browser/core-features/contexts
[context-sdk]: https://github.com/browserbase/sdk-node/blob/v2.20.0/src/resources/contexts.ts
[sessions-sdk]: https://github.com/browserbase/sdk-node/blob/v2.20.0/src/resources/sessions/sessions.ts
[keepalive]: https://docs.browserbase.com/platform/browser/long-sessions/keep-alive
[timeouts]: https://docs.browserbase.com/platform/browser/long-sessions/timeouts
[verified]: https://docs.browserbase.com/platform/identity/verified-customization
[proxies]: https://docs.browserbase.com/platform/identity/proxies
[authentication]: https://docs.browserbase.com/platform/identity/authentication
[captcha]: https://docs.browserbase.com/platform/identity/captcha-solving
[regions]: https://docs.browserbase.com/optimizations/latency/multi-region
[concurrency]: https://docs.browserbase.com/optimizations/concurrency/overview
[extensions]: https://docs.browserbase.com/platform/browser/core-features/browser-extensions
[pw-context]: https://github.com/microsoft/playwright/blob/v1.63.0/docs/src/api/class-browsercontext.md
[chrome-scripts]: https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts
[chrome-workers]: https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
[uploads]: https://docs.browserbase.com/platform/browser/files/uploads
[downloads]: https://docs.browserbase.com/platform/browser/files/downloads
[live-view]: https://docs.browserbase.com/platform/browser/observability/session-live-view
[replay]: https://docs.browserbase.com/platform/browser/observability/session-replay
[mp4]: https://docs.browserbase.com/platform/browser/observability/recording-downloads
[byos]: https://docs.browserbase.com/account/enterprise/byos-setup-guide
[zdr]: https://docs.browserbase.com/account/enterprise/zero-data-retention
[changelog]: https://www.browserbase.com/changelog
[webhooks]: https://github.com/browserbase/sdk-node/blob/v2.20.0/src/resources/webhooks.ts
[composition-issue]: https://github.com/mannyc2/effect-agent-browserbase/issues/6#issuecomment-5751167681
[pr27]: https://github.com/mannyc2/effect-agent-browserbase/pull/27
[issue4]: https://github.com/mannyc2/effect-agent-browserbase/issues/4#issuecomment-5751302698
[issue9]: https://github.com/mannyc2/effect-agent-browserbase/issues/9
[issue13]: https://github.com/mannyc2/effect-agent-browserbase/issues/13
[issue19]: https://github.com/mannyc2/effect-agent-browserbase/issues/19
[issue28]: https://github.com/mannyc2/effect-agent-browserbase/issues/28
