# Evidence ledger and review limits

## Revisions and execution boundary

Research date: **20 September 2026**. Repository baseline: [`1b3e9b1916621d036f2568c821e83bed72400f9c`](https://github.com/mannyc2/effect-agent-browserbase/commit/1b3e9b1916621d036f2568c821e83bed72400f9c). Source citations inside this report use that baseline or relative paths on this documentation branch, whose implementation is unchanged from it.

The official SDK's latest published GitHub release and inspected main both resolve to **`fe805b86cd860436eae63a2551b12cf02d708ce1`**, [v2.20.0](https://github.com/browserbase/sdk-node/releases/tag/v2.20.0), published **9 September 2026**. The SDK's current main was checked against the release target, so source findings are not accidentally based on unreleased newer fields. Native automation references use [Playwright v1.63.0](https://github.com/microsoft/playwright/tree/v1.63.0), matching the repository's declared optional peer.

Repository pins are source-declared and documented, not an installed workspace from this review: Node 24.14.1, Bun 1.4.2, Effect 4.0.0-rc.115, effect-agent/testing 0.1.0-beta.102, TypeScript 7.0.2, Vite+ 0.3.2 and upstream `ea53ea6671a94eb44b8019e942cc2c9468786723`. [Manifest](../../../packages/platform-browserbase/package.json), [contributor procedure](../../../CONTRIBUTING.md).

A sandbox clone attempt failed with `Could not resolve host: github.com`. A subsequent independent environment check still produced no GitHub DNS result; the local runtime reported Node **v22.16.0** and `/mnt/data` contained no repository checkout or dependencies. Therefore this review did **not** run the pinned formatter, TypeScript, Effect tests, native Chromium, packed consumers or hosted Browserbase. It did not replace those checks with an unpinned approximation. The GitHub connector remained functional, enabling actual remote source inspection and incremental documentation commits.

The current-API example is source-aligned but uncompiled here. Proposed examples are deliberately marked design fixtures. New API names are not claimed to exist. The implementation plan makes compiling/running those examples part of acceptance rather than describing documentation as a finished implementation.

## Evidence categories used

| Category | What it supports | What it does not support |
| --- | --- | --- |
| Current official documentation/API/SDK | Provider terminology, accepted resource fields, documented constraints and lifecycle behavior | Undocumented overlap/flush ordering or account-specific entitlements |
| Repository source tracing | Public field admission, wire projection, private/native boundaries, cleanup and ownership paths | Proof that a hosted platform behavior occurred |
| Inspected test source | What a deterministic or native test asserts at the retained revision | A fresh pass of that test in this session |
| Maintainer issue/PR reports | Attributed historical observations and open failure hypotheses | Independently rerun/verified artifacts in this review |
| Proposed design / experiment | Explicit decisions, testable acceptance conditions and unknowns | A guarantee or a currently exported capability |

No credentials, paid sessions, private site data, runtime changes, dependency changes, deployments, publishing or upstream issue filings were used. All remote writes in this task belong to the dedicated documentation branch and its draft PR.

## Primary provider research trail

Start with the [official documentation index](https://docs.browserbase.com/llms.txt), [API session creation](https://docs.browserbase.com/reference/api/create-a-session), [SDK resource source](https://github.com/browserbase/sdk-node/tree/v2.20.0/src/resources) and [SDK changelog](https://github.com/browserbase/sdk-node/blob/v2.20.0/CHANGELOG.md). Specific consequential findings are cited where used in the report, rather than resting solely on this bibliography.

| Area | Primary sources / inspected mechanism |
| --- | --- |
| Context resources and deprecations | [Context guide](https://docs.browserbase.com/platform/browser/core-features/contexts), [SDK Context create/get/delete and deprecated upload fields](https://github.com/browserbase/sdk-node/blob/v2.20.0/src/resources/contexts.ts) |
| Session states, settings, timeout mapping, listing and debug access | [SDK Sessions resource](https://github.com/browserbase/sdk-node/blob/v2.20.0/src/resources/sessions/sessions.ts), [keep-alive](https://docs.browserbase.com/platform/browser/long-sessions/keep-alive), [timeouts](https://docs.browserbase.com/platform/browser/long-sessions/timeouts) |
| Identity/network | [Verified](https://docs.browserbase.com/platform/identity/verified-customization), [proxies](https://docs.browserbase.com/platform/identity/proxies), [authentication](https://docs.browserbase.com/platform/identity/authentication), [CAPTCHA](https://docs.browserbase.com/platform/identity/captcha-solving), current SDK allowedDomains/CA/settings definitions |
| Geography/admission | [regions](https://docs.browserbase.com/optimizations/latency/multi-region), [concurrency](https://docs.browserbase.com/optimizations/concurrency/overview) |
| Browser customization | [extensions](https://docs.browserbase.com/platform/browser/core-features/browser-extensions), [pinned native context scripts/bindings/permissions](https://github.com/microsoft/playwright/blob/v1.63.0/docs/src/api/class-browsercontext.md), [Chrome content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts), [MV3 worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle) |
| Files and evidence | [uploads](https://docs.browserbase.com/platform/browser/files/uploads), [downloads](https://docs.browserbase.com/platform/browser/files/downloads), [Live View](https://docs.browserbase.com/platform/browser/observability/session-live-view), [replay](https://docs.browserbase.com/platform/browser/observability/session-replay), [MP4 recording downloads](https://docs.browserbase.com/platform/browser/observability/recording-downloads) |
| Storage and privacy | [BYOS](https://docs.browserbase.com/account/enterprise/byos-setup-guide), [ZDR](https://docs.browserbase.com/account/enterprise/zero-data-retention) |
| Evolution and scope | [public product changelog](https://www.browserbase.com/changelog), [SDK 2.20 webhook events](https://github.com/browserbase/sdk-node/blob/v2.20.0/src/resources/webhooks.ts) |

The product changelog was checked by publication date as well as title: 9 September's webhooks are **Functions** events; 19 August adds Context naming/dashboard management; 17 August adds BYOS CDP logs; 15 July adds MP4 recording downloads. These browser-relevant developments inform coverage. Unrelated Search, model routing/inference, hosted agents and Functions execution were not turned into integration requirements. Some individual index destinations were not retrievable; current SDK source was used for exact allowedDomains/TLS/webhook contracts rather than pretending an unavailable page had been read.

## Repository trace ledger

Read the repository instructions, root/package README, CONTRIBUTING, package manifest and export index before proposing changes. The most consequential paths inspected are:

| Boundary | Inspected files / representative symbols |
| --- | --- |
| Public configuration and host | `InteractiveBrowser.ts`: `InteractiveOptions`, validation/projection, host acquire/open/reconcile and session operations |
| Remote allocation and cleanup | `internal/Provider.ts`: create body, metadata, release, reconciliation, Live View; `internal/Session.ts`: leases, acquisition, owner cleanup, detach/reconnect, handoff and callbacks |
| HTTP security and error mapping | `internal/Http.ts`: account schema, `httpOptions`, JSON request/status mapping, bounded credential-bearing transport |
| Native ownership/targets | `internal/Driver.ts` and `internal/Playwright.ts`: private interfaces, connector, default context, page/frame registration, exact-node observations, target IDs, capture source, viewport setup and disconnect |
| Public data/Tools | `Types.ts`, `Tools.ts`, `Capture.ts`, `index.ts`: resource references, error/outcome vocabulary, non-forgeable live capture association and model authority |
| Artifacts | Complete public `Recordings.ts`, `Replays.ts`, `Downloads.ts`: actual requests, terminal checks, polling, partial results, URL/playlist/transfer limits and independent lifetimes |
| Examples/tests | `examples/hosted.ts`; representative ownership fixture assertions, native/source paths referenced by reviewed issue discussions, test tree and public type-test contract |

This is a focused architectural audit, not a claim that every line of every fixture or CI artifact was independently executed or reviewed. The linked modules make each recommendation traceable to an actual public→provider/native path. Whole-package acceptance remains a stage requirement.

## Historical observations and their limits

[#6's 20 September hosted report](https://github.com/mannyc2/effect-agent-browserbase/issues/6#issuecomment-5751167681) supplies a concrete runtime failure of shared-option composition and a successful bounded hosted flow after fixing the example. The source independently explains the mismatch: interactive construction calls `httpOptions`, while the three artifact layers pass options directly into strict `makeHttp`. The reported hosted flow includes allocation, observation, screenshot, capture, Live View, terminal cleanup and recording download. It does **not** validate Context synchronization, Verified, extension persistence, all initialization lifecycles or fresh-process ownership.

The actual [PR #27 diff](https://github.com/mannyc2/effect-agent-browserbase/pull/27/files) is a documentation boundary decision: no public CDP seam, private internals, adapter-specific host vocabulary. The proposal keeps that constraint. [#4's latest closure decision](https://github.com/mannyc2/effect-agent-browserbase/issues/4#issuecomment-5751302698) recognizes implemented capture/page controls, accepts local Tools divergence and moves binding composition into #6. Older issue bodies must not be read as the current implementation.

[#9](https://github.com/mannyc2/effect-agent-browserbase/issues/9), [#19](https://github.com/mannyc2/effect-agent-browserbase/issues/19) and [#28](https://github.com/mannyc2/effect-agent-browserbase/issues/28) document distinct native failures. The report preserves their uncertainty and does not relabel hypotheses as diagnoses. Their artifacts were not downloaded or rerun here. [#13](https://github.com/mannyc2/effect-agent-browserbase/issues/13) records the separate audio question; an MP4 MIME type is not evidence of an audio track.

## What still needs empirical proof

The [H1–H7 experiment matrix](implementation-plan.md#hosted-experiments-and-unresolved-questions) identifies exact hosted questions. The highest-value unknowns are Context visibility after normal and abnormal endings; overlapping sessions and extension storage; native registration/disposal over reconnect; Verified plus wrapper setup; and native-target versus provider-page correlation. The proposal intentionally exposes unconfirmed/partial states until evidence exists instead of filling these gaps with a convenient promise.

A follow-up implementation should record exact request settings, provider session/resource references in a private evidence store, versioned fixtures, sanitized status/timing observations and cleanup outcomes. Public reports should redact credentials, signed URLs and page data. Verification should make failures more explainable, not make tests easier to pass by weakening the contract.
