# Code organization and package decision

**Proposed target, not moved source.** Follow-up to the resource architecture in PR #30. Rechecked `main` at `1b3e9b1916621d036f2568c821e83bed72400f9c`; the research branch initially ended at `e3bd70754bb1cfd8604a53aa6aba9d76e5b213ff`. All paths in the tree below are proposed unless identified as current. See [the implementation sequence](implementation-plan.md) and [evidence limits](evidence.md).

## 1. Decision: two packages, not a package for every lifetime

Create **`@effect-agent/browserbase`** for generic Effect-based Browserbase resources and managed browser operations. Retain **`@effect-agent/platform-browserbase`** as the Effect Agent adapter and compatibility facade. The first name is a proposed name under the existing naming family, not a claim of npm availability, scope ownership, or permission to publish. The dependency boundary matters independently of the final reserved name.

Do **not** initially split HTTP resources, Playwright, capture, or artifacts into further packages. Their independent lifetimes should remain visible in modules, services, subpaths and scopes. They do not by themselves justify independent release artifacts.

```text
application using Browserbase directly
  └── @effect-agent/browserbase
        ├── effect (peer; tested at 4.0.0-rc.115)
        └── playwright-core (optional peer 1.63.0; lazy interactive use only)

application using Effect Agent
  └── @effect-agent/platform-browserbase
        ├── @effect-agent/browserbase (exact regular dependency when packed)
        ├── effect-agent (exact coordinated regular dependency when packed)
        └── effect (same peer window and tested pin as generic package)

Forbidden edges:
  browserbase ─X→ effect-agent / platform-browserbase / @effect-agent/testing
  either runtime package ─X→ repository tools / examples / test fixtures
  provider/resource modules ─X→ Playwright implementation
```

This is a **framework split**, not an attempt to make the browser provider-neutral. The generic package still models Browserbase sessions, Contexts, persistence limits and provider-specific operations. No Cloudflare dependency or upstream core proposal is required.

### Alternatives considered

| Design | Benefits | Costs / decisive limitation | Decision |
| --- | --- | --- | --- |
| One existing package with deliberate subpaths | One tarball, lowest migration/release work; current artifacts already work without a live browser | Mandatory `effect-agent` installation remains. A generic public session cannot expose its `BrowserHandle`; moving that type out of a subpath does not remove a regular manifest dependency | Good interim extraction home, not preferred final dependency boundary |
| One package, optional Effect Agent peer and adapter subpath | Can avoid installing the framework for some consumers | Converts the current coordinated regular dependency into optional peer compatibility work; root/adapter declaration graphs become conditional; changes existing installation contract and hides two audiences under one dependency manifest | Viable, but inferior to a small explicit adapter package here |
| Generic Browserbase package + existing adapter | Generic users install no framework; adapter alone owns core policy/error/Tool translation; both retain straightforward declarations | Two tarballs, explicit cross-package references and release tooling changes; compatibility wrappers must preserve live identity | **Preferred** |
| Resources + native runtime + adapter | Could isolate different runtime engines or release schedules later | Playwright is already optional and lazy. Adds a third tarball and contracts across the session/capture boundary without removing today's required native engine from interactive consumers | Defer until another supported binding/runtime or measured declaration/install problem justifies it |
| Separate Context/capture/artifact packages | Very granular dependency choices | Fragmented shared identity/error contracts, repetitive manifests and artificial cross-package coordination | Reject |

The source basis is concrete: [manifest][manifest] makes `effect-agent` mandatory; [InteractiveBrowser][interactive] publishes `BrowserHandle` and framework policy/error types; [Recordings][recordings], [Downloads][downloads] and [Replays][replays] already use Effect/HTTP without importing the framework; [Playwright connector][playwright] loads the optional peer only when connecting. The argument for two packages is removal of framework coupling, not a claim that artifacts currently allocate browsers or that optional loading is missing.

### Package contracts

| Package | Purpose and public surface | Runtime/dependencies | Version/release policy |
| --- | --- | --- | --- |
| `@effect-agent/browserbase` | `client`, `references`, `errors`, `sessions`, `contexts`, `extensions`, `browser`, `browser-binding`, `bootstrap`, `observations`, `capture`, `page-control`, `recordings`, `replays`, `downloads`, `uploads`, `logs`; add administration subpaths only with implemented operations | Effect peer; optional exact Playwright peer; no framework, model, encoder, database, S3 or scheduler dependency. Supported execution hosts initially remain the existing Node/Bun pins; HTTP-only modules do not automatically become a promise of browser/Worker support | Same initial release train as adapter, with an exact adapter→generic dependency. Independent versioning can wait for an actual need |
| `@effect-agent/platform-browserbase` | Existing `interactive-browser`, `tools`, `types`, artifact/capture/page-control subpaths and root namespaces. Add a deliberate `adapter` entry for composing an already-owned generic session | Regular generic + framework dependencies; Effect peer. Preserve any legacy Playwright peer declaration during migration only if needed for existing installation behavior; default native implementation belongs solely to generic package | Preserve existing exports during the compatibility window. Coordinated dependency/pin changes only; no implicit framework upgrade |

Keep the current Effect peer range unless a separately reviewed compatibility decision changes it; the tested pin is still rc.115, not every version permitted by that range. The generic package's major/minor number need not semantically track Effect Agent forever. Coordinated prereleases initially avoid a second version matrix while the split stabilizes.

Public `.d.mts` files must not mention `playwright-core`, `effect-agent`, undeclared SDK packages or framework testing utilities on **any generic subpath**, including `browser-binding` and the root. Binding contracts are native-neutral Effect interfaces, not exported Playwright `Page`/`Browser` types. Development may install Playwright for compiling its private implementation. Test consumer declarations with that peer absent and `skipLibCheck:false`; lazy JavaScript imports alone do not prove declaration isolation.

## 2. Concrete target tree

Keep public modules flat and discoverable, matching the repository's current export convention. Use a small number of internal responsibility directories. A public resource module can contain its service, schemas and private endpoint helpers; do not introduce a second `ContextsRepository` or a forwarding-only `Provider` service for each route.

```text
.
├── AGENTS.md / CONTRIBUTING.md / SECURITY.md
├── package.json                         # private repository wrapper
├── upstream.patch                       # pinned compatibility workspace integration
├── packages/
│   ├── browserbase/                     # NEW generic package
│   │   ├── package.json / README.md / LICENSE
│   │   ├── tsconfig.json
│   │   ├── vite.config.ts / vite.native.config.ts
│   │   ├── src/
│   │   │   ├── index.ts                 # deliberate namespace exports; no allocation
│   │   │   ├── Client.ts                # account service + layer; transport dependency
│   │   │   ├── References.ts            # qualified resource IDs and allocation identity
│   │   │   ├── Errors.ts                # sanitized public failure families
│   │   │   ├── Sessions.ts              # passive metadata/list; explicit provider release
│   │   │   ├── Contexts.ts              # Context data + create/retrieve/delete
│   │   │   ├── Extensions.ts            # extension data + bounded provisioning
│   │   │   ├── Browser.ts               # generic managed acquisition/session API
│   │   │   ├── BrowserBinding.ts        # trusted injectable Effect port; no SDK objects
│   │   │   ├── BrowserData.ts           # page/frame/document identity; action request data
│   │   │   ├── Bootstrap.ts             # typed registration plans and supervision contract
│   │   │   ├── Observations.ts          # bounded observation / element-reference schemas
│   │   │   ├── Capture.ts               # frame/options/summary schemas + scoped entry
│   │   │   ├── PageControl.ts           # explicit hold receipts; existing restrictions
│   │   │   ├── Recordings.ts / Replays.ts
│   │   │   ├── Downloads.ts / Uploads.ts
│   │   │   ├── Logs.ts                  # provider log access, not an automatic exporter
│   │   │   └── internal/
│   │   │       ├── http/
│   │   │       │   ├── Config.ts        # strict account decoding and owned copies
│   │   │       │   ├── Transport.ts     # authenticated JSON/no-content/multipart requests
│   │   │       │   └── Media.ts         # credential-free allowlisted byte/playlist access
│   │   │       ├── provider/
│   │   │       │   ├── Launch.ts        # one recipe→wire compiler; reserved fields
│   │   │       │   └── Contract.ts      # pinned browser DTOs; source-diff provenance
│   │   │       ├── session/
│   │   │       │   ├── Acquisition.ts   # pre-POST journal, remote lease, Context coordination
│   │   │       │   ├── Connection.ts    # connection attempts/epochs; late-result disposal
│   │   │       │   ├── Owner.ts         # ONE admission permit, tickets, fencing, budgets
│   │   │       │   ├── Cleanup.ts       # ordered teardown and typed receipt aggregation
│   │   │       │   └── Handoff.ts       # cooperative operator token/state transitions
│   │   │       ├── browser/
│   │   │       │   ├── Targets.ts       # pages/frames, selection, native-ID lookup
│   │   │       │   ├── Documents.ts     # document epochs and readiness state
│   │   │       │   ├── Initialization.ts# native registration scope + bounded callbacks
│   │   │       │   ├── Observation.ts   # retained-node store and observation invalidation
│   │   │       │   └── Actions.ts       # exact-node dispatch and compound waits
│   │   │       ├── playwright/
│   │   │       │   ├── Connect.ts       # strict endpoint checks and lazy peer import
│   │   │       │   ├── Driver.ts        # assemble native ports; no remote ownership
│   │   │       │   ├── Pages.ts         # native page/frame/DOM primitives
│   │   │       │   ├── Registrations.ts # scripts, bindings, permissions, native Disposables
│   │   │       │   ├── Screencast.ts    # maintained callback API; honest source timestamps
│   │   │       │   └── PageExecution.ts # existing Chromium hold/resume mechanism
│   │   │       ├── capture/
│   │   │       │   ├── Manager.ts       # per-session target leases and aggregate budget
│   │   │       │   ├── Interval.ts      # interval lifecycle, stop/quarantine, summary
│   │   │       │   ├── FrameBuffer.ts  # frame AND byte bounds, eviction accounting
│   │   │       │   └── Images.ts        # small bounded geometry checks
│   │   │       ├── Deadline.ts          # monotonic deadline arithmetic shared by owners
│   │   │       ├── TransferPolicy.ts    # shared transfer boundary validation
│   │   │       └── Failure.ts           # safe diagnostics; no foreign cause serialization
│   │   ├── test/
│   │   │   ├── unit/                   # owner/targets/bootstrap/capture pure state + TestClock
│   │   │   ├── contract/               # HTTP wire/defaults/redaction/response fixtures
│   │   │   ├── native/                 # real CDP/Chromium; no framework
│   │   │   ├── public-types.test.ts     # exact E/R and public result types
│   │   │   └── fixtures/               # ScriptedProvider, TestBinding, LocalChromium, origins
│   │   └── examples/                   # contexts, customized browser, artifacts, record-video
│   └── platform-browserbase/           # existing package becomes small adapter
│       ├── package.json / README.md / LICENSE / tsconfig.json / vite.config.ts
│       ├── src/
│       │   ├── index.ts
│       │   ├── Adapter.ts              # generic session→framework handle/InteractiveBrowser
│       │   ├── InteractiveBrowser.ts   # legacy host/options/session facade
│       │   ├── Tools.ts                # actual Effect AI Tool/Toolkit + generic session actions
│       │   ├── Types.ts                # compatibility reexports, not duplicate schemas
│       │   ├── Capture.ts / PageControl.ts # unwrap legacy session; delegate once
│       │   ├── Recordings.ts / Replays.ts / Downloads.ts # service identity reexports
│       │   └── internal/
│       │       ├── Policy.ts           # framework policy→generic budgets; deny unsupported modes
│       │       ├── Errors.ts           # framework and Tool projections
│       │       └── Legacy.ts           # old options/handle shape; no second lifecycle owner
│       ├── test/
│       │   ├── adapter.test.ts / legacy.test.ts / public-types.test.ts
│       │   ├── native/agent.test.ts     # real AgentRuntime + scripted model
│       │   └── fixtures/               # framework-only model and runtime helpers
│       └── examples/agent.ts
├── test/consumers/                      # NEW tracked, emitted-package-only acceptance programs
│   ├── resources-only/                 # generic + Effect, no framework or Playwright
│   ├── generic-browser/                # generic + exact Playwright
│   ├── agent/                          # both tarballs + exact framework/testing versions
│   └── legacy/                         # existing public import paths and behavior
├── tools/                              # dependency-free wrapper/packaging ownership
│   ├── bootstrap.sh / pinned-toolchain.sh / run-acceptance.sh
│   ├── packages.mjs                    # NEW explicit owned-package inventory
│   ├── package-release.mjs / packed-consumer.sh
│   ├── check-contract-drift.mjs         # NEW offline comparison, not a runtime generator
│   └── test/                           # Node maintenance-script tests; no Effect dependency
├── docs/                               # design, operating/releasing/hosted procedures
└── checkpoints/                        # unchanged immutable historical provenance
```

This is the **end-state ownership map**, not an instruction to create all empty files in Stage 0. Keep native registration code with its feature until bootstrap lands. Split capture's manager/interval only when separating aggregate admission from per-interval work materially reduces coupling. `Images`, `Deadline`, DTO compilation and validators remain ordinary modules; they are not services just because they have names.

Test fixtures may share source through the wrapper's explicit fixture-copy step in external consumers; production packages must never publish test helpers or depend on sibling test paths. A generic native test should not install the framework just to borrow a fixture. Do not introduce a published testing package for this initial split.

## 3. Current modules → target owners

| Current module / responsibilities | Proposed owner and dependency change | Why an ordinary change becomes easier |
| --- | --- | --- |
| `InteractiveBrowser.ts`: HTTP construction, options, provider setup, policy translation, public handle forwarding | Generic `Client`, `provider/Launch`, `Browser`; framework `Adapter`, `internal/Policy`, `internal/Legacy` | Adding a region/Context option no longer edits a framework handle implementation. Core policy validation stays in one adapter location |
| `internal/Provider.ts`: session HTTP routes + allocation body + terminal loop + debug | `Sessions` owns HTTP operations; `provider/Launch` owns request construction; `session/Acquisition` owns attempt authority and release workflow | Passive retrieval and release cannot share a misleading `reconcile` name; no second generic `Provider` wrapper between Client and resource services |
| `internal/Http.ts`: strict configuration + API transport + media transfer + deadlines | `Client`, `http/Config`, `http/Transport`, `http/Media`; retain `Deadline` and `TransferPolicy` helpers | Credentials and API transport are constructed once. Adding DELETE/204 or multipart does not touch credential-free media redirect policy |
| `internal/Session.ts`: resourceScope, lease, create/close, driver, connection callbacks, handoff, handle binding, capture map | `Acquisition`, `Connection`, `Cleanup`, `Handoff`, existing `Owner`, browser controllers and capture manager | Reconnection can be tested without replaying provider allocation; cleanup order becomes one named program; artifact work cannot acquire an interactive owner |
| `internal/Owner.ts`: permit, tickets, budgets, dispatch evidence; also native Promise bridge | Keep owner semantics in `session/Owner`; place native settlement bridge with `Connection`/driver boundary | Changing concurrency admission cannot accidentally change native promise completion. **Keep nonwaiting busy admission**, not an unbounded semaphore wait |
| `internal/Playwright.ts`: endpoint validation/import, default context, target registry, DOM observations, input, dialogs, native capture, teardown | `playwright/Connect`, `Driver`, native primitive modules; browser `Targets`, `Observation`, `Actions` own policy state | A popup-readiness change no longer edits screencast delivery. Native primitive implementations do not decide who releases a remote session |
| `Types.ts`: provider IDs, owner outcomes, browser data, media data, failure enum | `References`, `Errors`, `BrowserData`, `Observations`, feature-owned artifact/capture schemas; legacy `Types` explicitly reexports | A download schema change does not expand every browser operation's error vocabulary or pull native declarations into resource-only consumers |
| `Capture.ts`, `internal/Capture.ts`, `CaptureTypes`, `FrameBuffer`, `Association` | Generic `Capture`, `capture/Manager`, `Interval`, buffer; one generic live-session association | Adapter wraps/unwraps the canonical generic session; copied wrappers do not mint capture authority; aggregate limits remain enforceable across all entry points |
| `PageControl`, `PageExecution`, association | Generic `PageControl` and native `PageExecution`, same owner and target registry | Holds and actions share authority. No second selection or page-control owner is created by adapter composition |
| `Recordings`, `Replays`, `Downloads` | Generic resource modules; adapter compatibility reexports | Their existing independent lifetime survives. Each consumes the shared Client rather than constructing four unrelated configuration boundaries |
| `Tools.ts` | Adapter only; uses real Effect AI Tool/Toolkit and framework projection | Agent integration evolves with its installed framework; generic browser consumers do not inherit model-oriented contracts |
| `CallbackTasks.ts` | Retain bounded native-Promise task tracking where necessary; use scoped FiberSet for new Effect callback work | Do not pretend interrupting a fiber cancels a foreign Promise. Admission occurs before spawning callback work |
| `tools/*`, wrapper acceptance, immutable checkpoints | Stay in repository tooling/provenance, outside runtime packages | Publishing stays dependency-free and cannot accidentally execute imported runtime/development code |

These are extractions of responsibilities, not one-for-one renames or a demand for a separate file per method. Public schemas are defined once. Compatibility modules reexport the same constructors/service tags rather than duplicating them under new paths.

## 4. State authority and dependency rules

| State | Single authority | Other modules receive |
| --- | --- | --- |
| Account credential/project/request limits | immutable Client service instance | methods plus safe account identity; never a mutable options object |
| Allocation attempt, known reference, release facts | remote acquisition journal/lease | read-only receipts and explicit administrative operations |
| Phase, connection generation, operation/selection stamps, action count, active dispatch | one `Owner` per managed browser session | tickets and transition methods, not writable `.state` |
| Active native connection / connecting promise and retired-attempt cleanup | `Connection` | owner-issued epoch token; never a separately incremented generation |
| Page/frame maps, selected IDs, native target mapping | `Targets` | opaque live references and snapshots; owner owns selection stamp, Targets owns the selected value |
| Current document epoch/readiness | `Documents` per target/frame | immutable epoch key, await/readiness status and invalidation events |
| Retained native nodes and observation disposal | `Observation` store | bounded element references tied to owner/selection/document stamps |
| Capture target reservations and aggregate bytes | `Capture.Manager` | interval leases; interval owns its own buffer and summary |
| Binding admissions, pending call IDs and registration disposal | initialization registration scope | supervised typed failures and bounded safe events |
| Cross-process Context writer/control lease | consumer's coordinator/supervisor | settlement evidence; no claim Browserbase enforces the consumer token |

A target callback is accepted only if its connection epoch is still current. A new document at the same URL is a different epoch. A node can detach within an otherwise unchanged document; retaining document identity never removes exact-node validation. Observation revisions are fencing evidence, not DOM snapshot versions.

Do not replace small synchronous state transitions with many unrelated Refs. A single private state record under the owner permit is often clearer. Native event callbacks need immediate fencing, including aborting an admitted operation outside its current fiber; retain the synchronous abort/ticket bridge. Move direct writes such as `owner.state.phase = "open"` behind `owner.commitConnected(epoch)` so invariants have one writable location. `Targets` and `Documents` may keep Maps; a Map does not need a service tag when it is a per-session instance.

Services should own meaningful dependencies: Client captures strict transport configuration; resource services capture Client; browser service captures Sessions and the binding; an optional telemetry service captures a caller-provided sink. Per-session controllers are factory-created values so two browsers cannot accidentally resolve the same ambient `Owner` service. Cross-module calls use injected narrow functions/ports. Avoid a generic event bus when typed direct invalidation callbacks express the actual ownership relationship.

## 5. Export and compatibility rules

The generic `BrowserSession` has generic operations, not an Effect Agent `BrowserHandle`. The adapter builds that handle **from** a session and explicit close authority; it never allocates another browser, adds another mutex, or copies live authority into a second registry. See the [API sketches](architecture.md#generic-consumer-and-adapter-contracts).

Keep existing adapter subpaths for at least one documented prerelease migration window. `Types` reexports the canonical generic constructors. Resource service aliases preserve the same `Context.Service` identities. Legacy capture/page-control wrappers unwrap a session's canonical generic capability before delegating; calling a generic function on an arbitrary copied legacy object remains invalid.

Preserve old shapes and consequences during extraction: two-phase `acquire/connect`, same-scope `detach/reconnect`, explicit handoff acknowledgement, cached close results, returned handle invalidation, privacy defaults, byte bounds, unknown dispatch outcomes and unsupported network modes. The old `reconcile` name remains a deprecated **release-oriented** compatibility method; new `Sessions.retrieve` is passive. Do not silently change the old method to a GET.

A useful generic session must support direct navigation, exact observed-element actions, page/frame selection, observations, capture and explicit local disconnection. It must not require constructing a framework policy object. New borrowed attachments cannot be converted into an owned legacy handle without deliberate close semantics supplied by their actual supervisor.

## 6. What the split does not buy automatically

It does not solve provider persistence visibility, make Playwright cancellation transactional, prove a raw binding safe, or make arbitrary framework versions compatible. It also does not eliminate explicit resource finalizers. It gives those concerns a home that is independent of framework translation.

Success is measured by three installed consumers: resources without framework/native peer; a generic browser without framework; and an Effect Agent application using the same generic owner through the adapter. Emitted declarations and runtime behavior, not repository import grep alone, establish the boundary. The [packaging stage](implementation-plan.md#stage-0b--two-package-distribution-and-compatibility) specifies bootstrap, two-tarball installation and dependency-free release changes.

[manifest]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/package.json
[interactive]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/src/InteractiveBrowser.ts
[playwright]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/src/internal/Playwright.ts
[recordings]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/src/Recordings.ts
[downloads]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/src/Downloads.ts
[replays]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/src/Replays.ts
