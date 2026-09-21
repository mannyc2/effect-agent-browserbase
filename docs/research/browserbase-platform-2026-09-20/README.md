# Browserbase platform, package architecture and engineering plan

**Research dates:** 20–21 September 2026. **Delivery:** documentation-only research in [PR #30](https://github.com/mannyc2/effect-agent-browserbase/pull/30). Runtime implementation is tracked separately in [PR #31](https://github.com/mannyc2/effect-agent-browserbase/pull/31). Proposed APIs and experiments in this report are not implemented or validated merely by merging documentation.

## Read this first: current decisions and historical proposals

The maintainer explicitly superseded the original compatibility-window proposal. The active contract is a **hard cutover**: remove compatibility facades, legacy constructors, aliases, reexports and error projections; migrate every maintained consumer; do not add `internal/Legacy.ts`, a migration window or a fourth legacy consumer. References to those mechanisms in the original chapters are historical proposals, not implementation instructions. The required distribution is **two candidate packages and three clean consumers**, with raw-zero declaration checks and `skipLibCheck:false`.

The original research inspected source [`1b3e9b1916621d036f2568c821e83bed72400f9c`](https://github.com/mannyc2/effect-agent-browserbase/commit/1b3e9b1916621d036f2568c821e83bed72400f9c). Its descriptions of absent capabilities are baseline findings, not the current implementation status. The [21 September recorded-workflow chapter](recorded-workflows.md) reviews #31 at [`5ce468e7fec5f6dd37b336c80a4da2fcd69969cb`](https://github.com/mannyc2/effect-agent-browserbase/commit/5ce468e7fec5f6dd37b336c80a4da2fcd69969cb) and the updated [issue #34](https://github.com/mannyc2/effect-agent-browserbase/issues/34). It does not backport that runtime onto this documentation branch.

[PR #33](https://github.com/mannyc2/effect-agent-browserbase/pull/33) owns the hosted-check registry and its separately authorized, narrowed provider claims. The original H1–H7 research questions are not all established by those narrower checks; equally, the registry must not be described as missing or rebuilt here. Check each entry's claim and retained evidence. This research adds no hosted run or spending authorization.

## Recommendation

Keep **`@effect-agent/browserbase`** as the generic Effect integration owning Browserbase resources and managed browser operations. Keep **`@effect-agent/platform-browserbase`** as the actual Effect Agent adapter and Toolkit, borrowing that exact generic owner. Only the adapter imports the framework. No second connection, action budget, capture reservation or cleanup owner is introduced by adaptation.

```text
Generic Browserbase consumer               Effect Agent consumer
             │                                     │
             │                       @effect-agent/platform-browserbase
             │                              framework adapter
             └─────────────────────┬───────────────┘
                         @effect-agent/browserbase
                      resources + one managed owner
                         │                    │
                       Effect         optional lazy Playwright
```

Keep resources, native operations, capture and artifacts as deliberate modules/subpaths rather than creating a package for every lifetime. Generic declarations must not pull in Effect Agent or Playwright types; resources-only consumers must not install either. No package publication is authorized by the proposed names.

The resource/lifetime distinctions remain essential: a persistent provider Context is not a Playwright BrowserContext or an Effect Context; a durable SessionReference is not a live browser capability; local disconnect is not remote release; terminal session status is not proof of Context synchronization. Extension provisioning, browser connection, document initialization and post-session artifact retrieval have different owners and cleanup consequences.

## Recorded-workflow follow-on: issue #34

**Own faithful execution and trustworthy evidence; leave presentation choices to the application.** Owning less presentation requires a better public API, not private-native escape hatches or consumer guesses.

The [new chapter](recorded-workflows.md) covers the entire request, not only cursor styling:

- Scoped in-flight navigation, short owner transitions plus conflict reservations, intermediate checkpoints, explicit stop/cancellation semantics and independent-page progress.
- Capture continuity across document changes, ambiguous transition attribution, bounded metadata/loss, actual geometry and separate browser-presentation, host-monotonic and output-media clocks.
- Viewport evidence, clipped/occluded text, bounded control facts and checked host admission without default field-value or HTML disclosure.
- Native move/hover/wheel and a conditional finite gesture executor: caller-selected easing, library-owned target validation, per-event budgets and late-native accounting.
- **Passive recording snapshots versus actionable observations:** a checkpoint must not replace the node map used by agent tools; exact-node retention or checked revalidation across a hold must never retarget by selector or label or revive stale authority.
- Request admission as a separate, coverage-qualified security capability, not a route callback marketed as whole-browser containment.

Pinned Playwright source adds important constraints: action decorations can display fill values and delay input; capture acknowledgements and cached first frames do not prove suspension or freshness; ordinary screenshots are not proven non-waking held-page readers; and the pinned route implementation does not expose redirects as ordinary user routes. These are source findings, not newly executed tests.

The library should supply the page/document/input/timing facts that a maintained public-API example uses to record and present a workflow. The application still owns cursor artwork, browser-window graphics, captions, narration, encoding, storage and playback. Do not create another recording owner, agent runtime, natural-language planner or generic event-sourcing system.

## Report chapters

| Chapter | Scope and applicability |
| --- | --- |
| [Recorded workflows and evidence](recorded-workflows.md) | 21 September source-backed #34 research, ownership decisions, modelling, implementation increments and unexecuted acceptance experiments |
| [Platform research](platform.md) | Original provider/resource/API findings at the declared baseline; later scope decisions and hosted claims are tracked by #31–#33 |
| [Capability map](capability-map.md) | Original support classifications, proposed owners and stages; not a current implementation inventory |
| [Target architecture and API](architecture.md) | Generic session/page composition, shared Client, launch and ownership; compatibility passages are superseded by the hard cutover above |
| [Code organization and package decision](organization.md) | Module/state ownership, package tradeoffs, source/export/fixture organization; legacy facade paths are historical, not required |
| [Effect implementation conventions](effect-conventions.md) | Pinned services/Layers, Schema, E/R, Scope, bounded supervision and cleanup; historical compatibility/error examples are not active public contracts |
| [Consumer workflows](workflows.md) | Resource, browser, Agent, writer, bootstrap and borrowed-attachment rationale; use canonical maintained APIs rather than legacy examples |
| [Implementation plan](implementation-plan.md) | Original Stage 0A–5 dependencies and proof obligations; apply the hard-cutover override and three-consumer requirement |
| [Evidence ledger](evidence.md) | Original revisions, inspected guidance and execution limitations; follow-on source links and limitations are in the recorded-workflow chapter |

The original chapters remain available for provenance. This index and the maintainer's explicit decisions take precedence over their superseded compatibility recommendations; the new research is a follow-on, not permission to widen #31's production scope silently.

## Structural and Effect rules retained

**One strict Client.** Capture immutable account/fetch/media policy once; resource services acquire that dependency and own their endpoints. Provider credentials and approved media origins are distinct authorities. Input Schema validation remains strict; native/provider diagnostics stay sanitized.

**One authority for each mutable fact.** The owner retains lifecycle, admission, dispatch and budgets. Connection and page/document registries, observations, callbacks and aggregate capture reservations stay subordinate to it. Small helpers and per-session resources are factories, not mandatory ambient singleton services. Share identity facts rather than maintaining contradictory document epochs in each feature.

**Preserve E/R and Scope.** Public asynchronous operations return Effect or Stream. Explicit acquisition retains Scope; a helper supplying Scope removes that requirement from both library and consumer work without erasing other services. Callback errors remain typed on host supervision; an installation Effect cannot retroactively fail. Admission must be finite before callback fibers or native work begin.

**Interruption is not rollback.** Preserve pre-POST allocation identity, exact resource validation, synchronous fencing, late-native disposal and uncertain-outcome quarantine. Never replay an unresolved mutation. Page, connection, allocation, writer and artifact namespaces are distinct, even when URLs happen to match.

**Cleanup and adaptation do not mint authority.** Quiesce admission before managed callback finalizers, dispose owned registrations, disconnect locally and independently reconcile remote release. A borrowed attachment never acquires release authority. The adapter translates the installed framework contract once and shares the generic owner's action/capture accounting.

## Implementation and acceptance boundaries

The hard-cutover prerequisites remain Stage 0A's shared native-neutral injectable Effect binding and fixture migration, canonical two-package distribution, provider-faithful launch/resources, typed writer coordination, scoped bootstrap, fresh-process borrowed attachment, ordered cleanup, and files/artifact diagnostics. #31 owns their current implementation and exact-head acceptance record.

For #34, first establish shared identities and bounded evidence, viewport/control facts and real input, with a maintained public-API recorded-workflow example. Implement navigation operations, checkpoints and capture continuity together against incremental HTML. Treat request-admission coverage as a separate security increment. A finite gesture executor is conditional on demonstrated latency need, not a new mandatory choreography runtime.

Each production increment must verify the same two unmodified candidate tarballs in the three canonical profiles: resources-only without framework/native peers, generic real-native browser/capture, and actual AgentRuntime sharing the generic owner. Keep `skipLibCheck:false`; a raw compiler failure in a dependency is still a failure. Update bootstrap, manifests/builds/exports, inventory and every receipt consumer when an implemented public boundary changes. No source inspection, design sketch, previously green head or documentation CI run proves those new behaviors.

## Versions and validation

The reviewed pins remain Effect **4.0.0-rc.115**, TypeScript **7.0.2**, effect-agent/testing **0.1.0-beta.102**, Playwright **1.63.0**, Node **24.14.1**, Bun **1.4.2** and Vite+ **0.3.2**. Exact original Effect source: `4a05d4914fa2327a42bd75fe77c22c188becf3b4`. Browserbase SDK **2.20.0** was a contract reference, not an added runtime dependency.

The original 20 September environment limitations and no-execution statement remain in the evidence ledger. The 21 September follow-on is also source-backed research: no proposed API was typechecked and no package/native/hosted experiment was executed for it. Incorporation changes documentation only; structural checks and any exact-commit CI result must be reported separately. Runtime source, dependency pins, workflows, permissions and publication settings are unchanged.
