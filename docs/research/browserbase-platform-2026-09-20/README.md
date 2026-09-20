# Browserbase platform and integration architecture review

**Research date:** 20 September 2026. **Repository baseline:** [`1b3e9b1916621d036f2568c821e83bed72400f9c`](https://github.com/mannyc2/effect-agent-browserbase/commit/1b3e9b1916621d036f2568c821e83bed72400f9c). **Scope:** browser infrastructure and browser operation; documentation-only research, design and implementation plan requested by the maintainer.

## Recommendation

Evolve this package into a **resource-oriented Browserbase integration with an owned browser-operation layer**. Preserve its scoped mutation owner, uncertain-outcome fencing, durable session references and explicit-target capture. Broaden the provider configuration and resource model around that foundation rather than replacing it with an unguarded SDK wrapper or a second CDP connection.

The key conceptual separation is:

```text
Persistent Context / extension / environment recipe
                  ↓ launch configuration
            finite remote Session
                  ↓ attachment
          scoped local browser connection
                  ↓ initialization
       ready pages / frames / documents
                  ↓ owned operations
       observations / files / capture / artifacts
```

A persistent Context is not a Playwright BrowserContext or an Effect service Context. A disconnected connection is not a deleted remote session. A terminal session is not a documented Context-flush receipt. The proposed API makes these distinctions operational rather than leaving consumers to infer them.

## Report chapters

| Chapter | Contents |
| --- | --- |
| [Platform research](platform.md) | Current resources, SDK/API evolution, Contexts, sessions, settings, identity/network, extensions, files, observability and retention |
| [Capability map and assessment](capability-map.md) | Complete/partial/inaccessible/absent/outside-scope classifications; public configuration→provider/native traces; consumer consequences and omission value |
| [Target architecture and API](architecture.md) | Shared client/binding, resource references, upstream-faithful launch, ownership, Context coordination, bootstrap/readiness, Effect/error/resource design |
| [Worked consumer workflows](workflows.md) | Current-API example; proposed Context reuse, customized browser/service bridge, new documents, process reconnection and multipage inspection/capture |
| [Implementation plan and experiments](implementation-plan.md) | Six independently verifiable stages, modules/dependencies/migration/acceptance, native reliability work and seven bounded hosted experiments |
| [Evidence ledger](evidence.md) | Exact revisions, primary sources, inspected paths, historical observations, source-only versus executed evidence and remaining validation limits |

## Main findings

**Provider coverage is much narrower than the current browser platform.** `Provider.create` forwards a small subset and fixes proxies, logging and CAPTCHA solving off. Regions, extensions, Verified and broader settings are not publicly expressible. Verified additionally conflicts with unconditional viewport setup: configuration pass-through alone cannot support it correctly. [Source trace and recommendations](capability-map.md#1-provider-resources-and-session-configuration).

**Contexts are already partly modeled, but their complete workflow is not.** Context ID/persist and consumer writer leasing exist. Context creation/naming/retrieval/deletion, durable identity mapping and explicit persistence visibility remain missing. The current SDK's legacy Context upload URL is non-functional; do not implement obsolete profile-upload recipes. New sessions should use stored Context references plus a versioned environment recipe, not a serialized browser connection. [Platform semantics](platform.md#3-contexts-are-durable-data-not-a-running-browser), [write coordination](architecture.md#5-context-write-semantics).

**Reconnect has a narrower lifetime than its name suggests.** Current reconnect belongs to the same live owner scope after an intentional detach. Fresh-process attachment requires its own control lease, target validation, initialization and disconnect-only ownership contract. Public reconciliation requests release; it is not passive session inspection. [Lifecycle proposal](architecture.md#4-ownership-and-lifecycle).

**Customization needs initialization readiness, not just hooks.** Scripts, bindings, cookies and permission operations exist in the pinned native layer but are inaccessible through the current public owned session. Use maintained native registrations plus a bounded document-readiness registry. Extensions have distinct execution worlds and worker lifecycles. Do not treat extension globals as page globals or let browser callbacks inherit unrestricted host-service authority. [Bootstrap design](architecture.md#6-bootstrap-and-readiness), [customization matrix](workflows.md#4-customization-lifetime-matrix).

**Shared configuration is an immediate, concrete repair.** Interactive construction projects HTTP options, while artifact layers decode their input strictly. Existing examples compose incompatible shapes; the source and [maintainer's hosted report](https://github.com/mannyc2/effect-agent-browserbase/issues/6#issuecomment-5751167681) agree. Normalize account construction once and keep credential-boundary validation strict. [Stage 0](implementation-plan.md#stage-0--one-accountclient-boundary-and-a-testable-browser-binding).

**Several tempting shortcuts would be misleading.** Provider `allowedDomains` does not prove the framework's ExactHosts/PublicWeb guarantees. Live View “read-only” presentation is not read-only authorization. Current webhooks are Functions-only, not Context/session lifecycle receipts. Provider recordings, replay and live capture are different products; audio and cross-page identity joins need empirical evidence. Existing capture sizing, target selection and page control should not be re-proposed as missing. [Capability assessment](capability-map.md).

## Recommended implementation order

Start with shared client/binding composition and the example regression. Then add faithful launch configuration/passive inspection, followed by Context resources and persistence coordination. Add scoped bootstrap/extension provisioning, then borrowed cross-process attachment. Complete file workflows and operational diagnostics on those foundations. Keep the independently tracked native failures separate rather than masking them inside the redesign. [Detailed stages and acceptance](implementation-plan.md).

No cross-provider framework standardization or upstream filing is required. The current no-general-CDP boundary remains in force. A trusted injectable binding is proposed as a deliberate local composition change, not permission for a consumer to open a second debugger connection.

## API acceptance clarifications

Bootstrap registration readiness and document readiness must not deadlock one another. `connect` may return an initializing connection after registrations are installed; the initial navigation is allowed to create the document whose readiness is then awaited. Dependent inspect/input/capture operations wait for the relevant document epoch. A navigation's postcondition may include the new document's readiness; it must not wait for that future document before dispatching navigation. Origin-excluded initial documents require an explicit skipped/not-applicable state rather than waiting on an absent global.

A truthy browser global alone is not cross-process readiness evidence. Reconnect must validate bootstrap version/generation and its host-side registration state, with explicit handling of an existing unresolved promise or retired binding. The native/user promise does not become a security guarantee against the page itself.

The TypeScript blocks are interface sketches, not finalized declarations. Production scoped helpers must discharge `Scope.Scope` from the returned environment (for example, `Exclude<R | InitR, Scope.Scope>` plus their actual service requirements), while explicit acquisition retains Scope. Stage acceptance includes compiling real examples and preserving generic callback errors/services in emitted packed declarations.

## Versions and evidence limits

There is **no `@browserbasehq/sdk` dependency in the repository package**. The review compared its owned Effect HTTP implementation with official SDK **2.20.0**, whose inspected main and release target are `fe805b86cd860436eae63a2551b12cf02d708ce1`. Repository acceptance pins are Effect **4.0.0-rc.115**, effect-agent/testing **0.1.0-beta.102**, Playwright **1.63.0**, TypeScript **7.0.2**, Node **24.14.1** and Bun **1.4.2**. [Manifest](../../../packages/platform-browserbase/package.json), [toolchain](../../../CONTRIBUTING.md), [SDK release](https://github.com/browserbase/sdk-node/releases/tag/v2.20.0).

The sandbox could not resolve GitHub for cloning; no pinned local checkout, native acceptance or paid hosted experiment ran in this review. Repository source and current primary provider material were inspected through the working GitHub/web connections. Historical hosted success and native failures are attributed, not claimed as new test results. The report distinguishes documented guarantees, source findings, reported observations and proposed behavior throughout. All documentation was incrementally committed on the dedicated branch. No runtime source, dependencies, workflow files, credentials, deployments or publishing were changed.
