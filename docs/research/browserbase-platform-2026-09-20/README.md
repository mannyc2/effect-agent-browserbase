# Browserbase platform, package architecture and engineering plan

**Research date:** 20 September 2026. **Repository baseline:** [`1b3e9b1916621d036f2568c821e83bed72400f9c`](https://github.com/mannyc2/effect-agent-browserbase/commit/1b3e9b1916621d036f2568c821e83bed72400f9c). **Delivery:** documentation-only research and structural follow-up in [draft PR #30](https://github.com/mannyc2/effect-agent-browserbase/pull/30). No proposed runtime/package/API change is implemented by this report.

## Recommendation

Build a **generic Effect-based Browserbase package plus a thin Effect Agent adapter**, preserving the existing scoped mutation owner, allocation identity, unknown-outcome fencing, exact-node actions and bounded target-pinned capture.

Proposed `@effect-agent/browserbase` owns Browserbase resources and managed browser operation. Existing `@effect-agent/platform-browserbase` owns framework policy, BrowserHandle/Tool/error translation and legacy compatibility. The proposed new name does not imply npm availability or publishing authorization. Do not initially split resources, Playwright, capture and artifacts into additional packages: independent lifetimes deserve clear modules/scopes, and Playwright is already optional and lazily loaded.

```text
Generic Browserbase consumer               Effect Agent consumer
             │                                     │
             │                       @effect-agent/platform-browserbase
             │                             framework/legacy adapter
             └─────────────────────┬───────────────┘
                         @effect-agent/browserbase
                      resources + one managed owner
                         │                    │
                       Effect         optional lazy Playwright
```

Within the generic package, keep the original resource/lifetime distinction:

```text
Persistent Context / uploaded extension / application environment recipe
                              ↓ launch
                      finite remote Session
                              ↓ attach
                    scoped local connection
                              ↓ initialize
                    pages / frames / documents
                              ↓ owned operation
                  observations / files / capture
                              ↓ independent retrieval
                      recording / replay artifacts
```

A Browserbase Context is not a Playwright BrowserContext or Effect Context. Local disconnection is not remote release; a terminal session is not a documented Context-flush receipt. Package separation must preserve those operational distinctions rather than hide them behind another forwarding layer.

## Report chapters

| Chapter | What it provides |
| --- | --- |
| [Platform research](platform.md) | Browserbase resources, SDK/API evolution, Contexts, sessions, settings, network/identity, extensions, files, observability and retention |
| [Capability map](capability-map.md) | Current support classifications with actual code/provider evidence; target package/module/stage for each gap |
| [Target architecture and API](architecture.md) | Generic session/page contract, explicit adapter composition, shared Client, launch recipe, ownership, Context coordination and document readiness |
| [Code organization and package decision](organization.md) | Concrete target directory tree, package dependency graph, alternatives/tradeoffs, current-module→owner mapping, state authority and export compatibility |
| [Effect implementation conventions](effect-conventions.md) | Exact rc.115 guidance/source, service/Layer composition, Schema/errors, Scope signatures, native callbacks, bounded concurrency, cancellation, observability and finalizer ordering |
| [Consumer workflows](workflows.md) | Current API plus proposed generic/resource/agent consumers, typed writer coordination, customized documents, borrowed attachment and multi-page capture |
| [Implementation plan](implementation-plan.md) | Ordered structural/capability stages, exact packaging changes, migration obligations, four emitted-consumer gates, change recipes and hosted H1–H7 |
| [Evidence ledger](evidence.md) | Immutable source revisions, inspected code/guidance, historical observations, environment failures and explicit no-typecheck/no-execution boundaries |

## Structural decisions

**The framework dependency is the justified package boundary.** The current manifest requires `effect-agent`, and the public session's BrowserHandle dependency is asserted by its type tests. Moving artifact modules behind more subpaths would not remove that dependency. The generic package needs its own browser policy/page/session contract; the adapter projects into the existing framework contract without allocating another owner or connection. [Package analysis](organization.md#1-decision-two-packages-not-a-package-for-every-lifetime).

**A shared Client is the first extraction.** Normalize strict account configuration once; resource services acquire it through Layers. They own their routes rather than each constructing another HTTP/provider wrapper. The existing interactive/artifact options mismatch is a concrete consumer failure, not merely a style concern. Keep API credentials and credential-free media access as separate authorities. [Capability assessment](capability-map.md), [Stage 0A](implementation-plan.md#stage-0a--dependency-boundaries-before-filepackage-movement).

**Give every mutable state one owner.** Owner keeps lifecycle/generation/admission/dispatch stamps and budget; Connection keeps the current/pending native connection under the owner-issued epoch; Targets keeps page/frame maps and selection values; Documents keeps document readiness; Observation keeps retained nodes; Capture.Manager keeps aggregate target reservations. Small helpers and per-session controllers do not all become singleton services. [Module/state mapping](organization.md).

**The adapter is a compatibility boundary, not a second engine.** Preserve current subpaths, legacy handle and result shapes, canonical Schema/service identities, privacy defaults and unknown-outcome semantics during an explicit prerelease window. Resource reexports must refer to the same service tags. Legacy capture/page-control facades delegate using the canonical generic session; copied wrappers do not mint authority. Removal of old contracts needs a separately announced breaking release. [Compatibility design](organization.md#5-export-and-compatibility-rules).

**Effect conventions are pinned and concrete.** The rc.115 publishing script copies root LLMS.md into package AGENTS.md; that source was read in full. Use Context.Service/Layer for dependencies, Schema for boundaries, traced fn for useful operations and fnUntraced for internal/hot paths. Helpers supplying Scope remove it from R, including Scope introduced by consumer/initialization work. Consumer callback services/errors remain typed, and failures after installation need live supervision rather than a misleading installation E channel. [Conventions and code](effect-conventions.md).

**Cleanup simplification must preserve native reality.** Mechanical extraction preserves current finalizer order. The target quiesce→local disconnect→remote reconciliation→writer settlement order is a deliberate later lifecycle change with failpoints and provider checks, not a consequence that follows automatically from moving files. Retain pre-POST identity journaling, cached close receipts, late-result disposal and immediate synchronous fencing. Interruption cannot undo a native command or preempt blocking/uninterruptible host code. [Cleanup contract](effect-conventions.md#6-cleanup-one-ordered-program-and-honest-receipts).

**A package split is incomplete until distribution proves it.** Bootstrap currently copies one package, release tooling allows one tarball and one workspace dependency, and the packed consumer always installs the framework/native peer. The plan changes those exact constraints, using an explicit two-package inventory, a versioned release-set receipt and four clean consumers. Repository maintenance/publishing scripts stay dependency-free. [Stage 0B](implementation-plan.md#stage-0b--two-package-distribution-and-compatibility).

## Revised implementation sequence

| Stage | Result |
| --- | --- |
| 0A | Shared strict Client and trusted injectable binding, preserving current runtime behavior |
| 0B | Generic Browserbase plus adapter distributions, compatibility facade and two-tarball/four-consumer acceptance |
| 1 | Provider-faithful launch compiler, provider-managed viewport, passive inspection and precise allocation errors |
| 2 | Context resources, typed consumer writer coordination and honest persistence evidence |
| 3 | Scoped extension/script/binding/permission customization with target/document/observation extraction |
| 4 | Borrowed cross-process attachment and separately verified cleanup/lifecycle organization |
| 5 | Complete files, artifacts and multi-page operational diagnosis |

Each stage names file moves/new modules, dependency/export implications, migration and independent acceptance. Three change recipes show the files/tests for a provider setting, a resource operation and a bootstrap capability. Keep the existing native reliability investigations separate; no retry-until-green or weakened capture assertions are part of the redesign.

## Original platform findings carried forward

Current launch coverage is much narrower than Browserbase: proxies/logging/CAPTCHA solving are fixed off, and region/extensions/Verified/broader settings are not publicly configurable. Context ID/persist/lease already exist, while resource provisioning and persistence visibility remain incomplete. Existing reconnect is same-owner/same-scope, not fresh-process recovery. Provider reconciliation requests release and is not passive inspection.

Native scripts, permissions, cookies and bindings are available underneath the driver but inaccessible through the owned public session. Scoped customization makes them usable without exposing a raw browser object or second unfenced CDP connection. Provider allowedDomains remains weaker than ExactHosts/PublicWeb. Live View presentation is not read-only authorization. Current SDK webhooks are Functions-only. Recordings, replay and live capture remain separate; audio, extension state, Context synchronization and cross-page identity need evidence. [Provider research](platform.md), [capability map](capability-map.md).

## API acceptance details

Initialization must not deadlock its own first navigation. Install registrations, then permit navigation to produce a new document and await that document's readiness. Origin-excluded documents need an explicit skipped/not-applicable state. A truthy page global alone is not trusted cross-process readiness: validate recipe version, current epoch and host registration state. Do not automatically reload a page that may contain an uncertain transaction.

The proposed per-acquisition `contextWriter` is a scoped permit from typed coordinator composition, not a serializable lease or provider-enforced lock. Consumer settlement errors/services remain visible; the helper records exact attempt/cleanup facts and quarantines unconfirmed writers. [Worked coordination contract](workflows.md#4-persistent-account-workflow-and-coordinator-types).

## Versions and validation boundary

Current pins remain Effect **4.0.0-rc.115**, TypeScript **7.0.2**, effect-agent/testing **0.1.0-beta.102**, Playwright **1.63.0**, Node **24.14.1**, Bun **1.4.2** and Vite+ **0.3.2**. Exact Effect source: `4a05d4914fa2327a42bd75fe77c22c188becf3b4`. Browserbase SDK contract reference: **2.20.0**, not an installed runtime dependency. [Evidence and primary references](evidence.md).

The sandbox could not resolve GitHub or the npm registry and had neither the pinned runtimes nor a checkout. **No new examples were typechecked; no package/native/hosted tests or canonical formatter ran.** Current examples are source-aligned; proposed examples remain explicitly proposed. Historical test/provider reports are attributed, not claimed as fresh observations. All changes are incrementally committed documentation on the same branch; runtime code, package names, dependencies, workflows, account permissions and publication remain unchanged.
