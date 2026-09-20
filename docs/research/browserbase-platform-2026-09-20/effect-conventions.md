# Effect implementation conventions and representative code

**Design examples, not newly implemented exports or typechecked results.** The follow-up verified the source-declared pins, not an installed local workspace: Effect **4.0.0-rc.115**, TypeScript **7.0.2**, Effect Agent/testing **0.1.0-beta.102**, Playwright **1.63.0**, Node **24.14.1**, Bun **1.4.2**. Keep the coordinated catalog/lockfile unchanged during structural extraction. [Current pins][pins], [integration patch][patch].

The exact Effect release tag resolves to [`4a05d4914fa2327a42bd75fe77c22c188becf3b4`][effect-revision]. Its [packaging script][copy-guide] copies root `LLMS.md` to each published package's `AGENTS.md`; the complete [source guidance][guide] was read, together with relevant source. This establishes the source of installed guidance without pretending `node_modules/effect` was installed here. GitHub cloning and npm publisher access failed DNS resolution, so **none of the new sketches below was compiled or executed**. Do not replace this evidence with a check against the host's different TypeScript/Node versions.

## 1. A short, enforceable convention table

| Concern | Convention in these packages | Source / repository application |
| --- | --- | --- |
| Services | `Context.Service` for meaningful shared dependencies; public methods return Effect/Stream | [Effect service guidance][guide]; current resource classes. Local owner/registry/buffer instances remain factories, not ambient singleton services |
| Layers | `Layer.effect` acquires dependencies once; `Layer.succeed` provides an already-built test port; compose shared Layer values with `provide`/`provideMerge` | [Layer composition example][layers]. Do not build four credential boundaries or a hidden runtime per request |
| Configuration | Strict Schema decode of account configuration once; resource/launch/callback configuration decoded at their own admission boundary | Existing `httpOptions`/`makeHttp` mismatch is the motivation, not permission to weaken credential validation |
| Domain data | Schema for transported/persisted/public structured data; runtime capabilities remain live interfaces | `References`, browser data and feature-owned schemas replace the mixed `Types.ts`; no casting through validation |
| Errors | Typed expected failures; preserve defects/interruption as causes; sanitize native/provider material before public errors or telemetry | Current `BrowserbaseError`, `Owner.native`, Tool projections. Do not expose `Schema.Defect` containing arbitrary SDK causes just because an upstream example does |
| Resource lifetime | Explicit acquisition retains `Scope.Scope`; scoped-use helpers discharge it; finalizers have a total/reporting boundary | [Scope source][scope], existing acquisition and capture types |
| Cancellation | Effect interruption cancels the waiter; native dispatch is separately classified and fenced | [Owner implementation][owner] and [connection settlement][session]; abort is not rollback |
| Concurrency | Preserve nonwaiting busy admission for browser mutations; bound callback admission before spawning fibers | Owner uses `withPermitsIfAvailable`, not a waiting work queue. A semaphore around already-created fibers does not bound fiber count |
| Streams | Explicit frame/byte/time limits; scoped consumers; no silent drain into unbounded arrays | Existing capture/transfer contracts; [Stream guidance][guide] |
| Observability | Static operation spans and sanitized facts; no default page data, headers, script source, native messages or signed URLs | Current HTTP tracing isolation is retained; add safe application-level spans above it |

## 2. Readable Effect functions

Use `Effect.gen` for inline compositions and Layer construction. Use `Effect.fn("BrowserbaseContexts.retrieve")` for a reusable operation that is a useful diagnostic span. Use `Effect.fnUntraced` for private helpers, per-frame work and low-level lifecycle transitions where another span is noise. Do not mechanically convert every helper to a traced function, and do not keep functions whose only job is wrapping `Effect.gen` when the `fn` forms express the intent more directly. [Pinned guidance][guide].

Combinators are preferable for a short map/projection, resource guarantee or reusable policy. For example, `stream.pipe(Stream.mapEffect(validateFrame))` is clearer than a manual generator-driven pull loop. A launch compiler that copies a small DTO can be an ordinary pure function after boundary validation. Neither generators nor services are a universal replacement for straightforward TypeScript.

Name traced functions statically. Do not use a URL, Context name, selector, page text or user identifier as the span name. Put only explicitly approved fields into annotations. The tracing boundary belongs above the credential-bearing HTTP/native boundary, whose ambient propagation remains disabled.

Use the installed vocabulary: `Effect.catch`/`Effect.catchTag`, `Effect.result`/`Effect.exit`, `Context.Service`, `Layer.effect`, `Effect.callback`, scoped `FiberSet`, `Effect.forkIn`/`forkChild` where their lifetime matches the work. Do not import Effect 3 recipes such as a different service constructor or assume an old callback API has the same signature. The full official Effect family and required dependencies are allowed; adding a package still requires a concrete need and coordinated pins.

## 3. Service composition and configuration ownership

The generic Client is the one authenticated transport dependency. Resource Layers consume it. The browser Layer consumes Sessions plus the trusted binding. A Layer value is shared within a composition by identity; repeatedly constructing equal-looking `Client.layer(account)` values is not the intended sharing contract.

```ts
// PROPOSED package exports. No hosted call occurs while assembling these Layers.
import { Layer } from "effect";
import { BrowserbaseClient } from "@effect-agent/browserbase/client";
import { BrowserbaseContexts } from "@effect-agent/browserbase/contexts";
import { BrowserbaseSessions } from "@effect-agent/browserbase/sessions";
import { BrowserbaseRecordings } from "@effect-agent/browserbase/recordings";
import { BrowserbaseBrowser } from "@effect-agent/browserbase/browser";
import { BrowserbaseBrowserBinding } from "@effect-agent/browserbase/browser-binding";

const ClientLive = BrowserbaseClient.layer(account);
const ResourcesLive = Layer.mergeAll(
  BrowserbaseContexts.layer,
  BrowserbaseSessions.layer,
  BrowserbaseRecordings.layer,
).pipe(Layer.provideMerge(ClientLive));
const BrowserLive = BrowserbaseBrowser.layer.pipe(
  Layer.provideMerge(ResourcesLive),
  Layer.provide(BrowserbaseBrowserBinding.layerPlaywright),
);
```

`account` is a host-supplied strict account configuration, not a launch recipe. Resource-only consumers use `ResourcesLive`, never `BrowserLive`. New services declare their actual Layer requirements; they do not secretly build a Client from process environment variables. Environment loading belongs in consumer entry points and can use Effect Config. Artifact origins and API credentials remain separately handled transport authorities.

The Client implementation continues to capture an approved fetch function and use official `FetchHttpClient`, with its own RequestInit/tracing isolation. Sharing the Client does not mean accepting an arbitrary ambient HttpClient transformer that can leak authorization. Use one shared rate-admission component only when implemented; the current four clients are **not** evidence of four existing rate schedulers. A shared client also does not make recording POST serialization automatically per-session: move that mutation gate to a keyed, bounded operation registry when justified rather than retaining one global semaphore that serializes unrelated sessions.

### Representative resource operation

The following is a **proposed `Contexts.ts` implementation sketch** using the existing error vocabulary for the first extraction. The Client port used here has `projectId` and `json(method, path, body?)`; it returns bounded unknown data or sanitized `BrowserbaseError`. The reference/error imports are the proposed canonical generic modules. There is no additional forwarding-only `ContextProvider` service.

```ts
import { Context, Effect, Layer, Schema } from "effect";
import { BrowserbaseClient } from "./Client.ts";
import { BrowserbaseError } from "./Errors.ts";
import { ContextReference, Identifier } from "./References.ts";

const ContextMetadata = Schema.Struct({
  id: Identifier,
  projectId: Identifier,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  name: Schema.optionalKey(Schema.String),
});
type ContextMetadata = typeof ContextMetadata.Type;

export class BrowserbaseContexts extends Context.Service<
  BrowserbaseContexts,
  {
    readonly retrieve: (
      reference: ContextReference,
    ) => Effect.Effect<ContextMetadata, BrowserbaseError>;
  }
>()("@effect-agent/browserbase/Contexts") {
  static readonly layer = Layer.effect(
    BrowserbaseContexts,
    Effect.gen(function* () {
      const client = yield* BrowserbaseClient;
      const retrieve = Effect.fn("BrowserbaseContexts.retrieve")(
        function* (reference: ContextReference) {
          const ref = yield* Schema.decodeUnknownEffect(ContextReference)(reference).pipe(
            Effect.mapError(() => BrowserbaseError.make({
              operation: "context-retrieve", reason: "configuration", outcome: "undispatched",
            })),
          );
          if (ref.projectId !== client.projectId) {
            return yield* BrowserbaseError.make({
              operation: "context-retrieve", reason: "authorization", outcome: "undispatched",
            });
          }
          const raw = yield* client.json("GET", `/v1/contexts/${encodeURIComponent(ref.contextId)}`);
          const result = yield* Schema.decodeUnknownEffect(ContextMetadata)(raw).pipe(
            Effect.mapError(() => BrowserbaseError.make({
              operation: "context-retrieve", reason: "malformed",
            })),
          );
          if (result.id !== ref.contextId || result.projectId !== ref.projectId) {
            return yield* BrowserbaseError.make({
              operation: "context-retrieve", reason: "malformed",
            });
          }
          return result;
        },
      );
      return BrowserbaseContexts.of({ retrieve });
    }),
  );
}
```

Production schemas reuse bounded timestamp/name rules and project checks rather than expanding this illustration into several copies. The two decodes have different purposes: caller reference admission and untrusted provider reply. Cross-resource identity comparison is a semantic invariant, not redundant string validation. Response decoding should tolerate irrelevant upstream fields; input configuration should reject conflicting/unknown authority fields. Never serialize the raw response, parse error or foreign exception into a public error.

Adding create/delete belongs in this same service. Creation persists beyond the call and is not automatically deleted by a scope. The managed browser allocator, not this resource service, owns session cleanup. [Provider Context API][contexts-api].

## 4. Scope signatures: remove the requirement actually supplied

The earlier report's helpers were inconsistent about returning `R` versus discharging a callback's own Scope requirement. The exact rule is:

```ts
// Self-contained Effect combinator sketch; not a new package export.
import { Effect, type Scope } from "effect";

export const useScoped = <S, A, AcquireE, AcquireR, E, R>(
  acquire: Effect.Effect<S, AcquireE, AcquireR>,
  use: (resource: S) => Effect.Effect<A, E, R>,
): Effect.Effect<A, AcquireE | E, Exclude<AcquireR | R, Scope.Scope>> =>
  Effect.scoped(Effect.flatMap(acquire, use));
```

Explicit acquisition returns `Effect<Resource, E, R | Scope.Scope>`. A helper that supplies the scope returns `Exclude<R, Scope.Scope>`, including Scope introduced by **consumer code or initialization**, not only Scope introduced by acquisition. The helper cannot discharge unrelated services. `Scope.provide` supplies a scope without closing it; `Scope.use` supplies an already-created closeable scope and closes it. [Pinned Scope signatures][scope].

For the proposed browser API:

```ts
// SIGNATURE CONTRACTS; supporting browser types are proposed in architecture.md.
declare const acquire: <InitE, InitR>(
  request: OpenRequest<InitE, InitR>,
) => Effect.Effect<
  OwnedBrowserAcquisition<InitE>,
  BrowserbaseError | InitE,
  BrowserbaseBrowser | InitR | Scope.Scope
>;

declare const withBrowser: <A, E, R, InitE, InitR>(
  request: OpenRequest<InitE, InitR>,
  use: (browser: BrowserSession<InitE>) => Effect.Effect<A, E, R>,
) => Effect.Effect<
  A,
  E | InitE | BrowserbaseError,
  BrowserbaseBrowser | Exclude<R | InitR, Scope.Scope>
>;
```

`withBrowser` is more than the simple combinator above: it supervises fail-session bootstrap errors and applies its declared owned-cleanup success policy. Its normal completion requires terminal release confirmation; unconfirmed cleanup becomes a typed error. Explicit acquisition callers can instead inspect the structured release receipt. A failure/interruption still runs fallback cleanup and records additional cleanup evidence without replacing the primary cause with a fabricated success.

A type parameter `A` cannot prove that a consumer did not return a live session or a Stream closing over it. Document that only durable data should escape; runtime generation/scope checks reject use after closure. The helper must consume callback-created capture/registration resources inside its lifetime. Do not describe `Exclude` as preventing arbitrary object leakage.

### Representative lifecycle operation

Separate a passive terminal wait from release. This sketch uses the existing monotonic deadline helpers and does not replay a release POST:

```ts
// Proposed Sessions helper; retrieve, terminal and deadline helpers are injected/owned here.
const waitForTerminal = Effect.fn("BrowserbaseSessions.waitForTerminal")(
  function* (reference: SessionReference, timeoutMillis: number) {
    const bounds = yield* Schema.decodeUnknownEffect(WaitOptions)({ timeoutMillis });
    const deadline = yield* deadlineAfter(bounds.timeoutMillis);
    for (;;) {
      const state = yield* within(retrieve(reference), deadline, "session-wait");
      if (terminal(state.status)) return state;
      const remaining = deadline - (yield* nowMillis);
      if (remaining <= 0) {
        return yield* BrowserbaseError.make({ operation: "session-wait", reason: "timeout" });
      }
      yield* Effect.sleep(Math.min(250, remaining));
    }
  },
);
```

`WaitOptions` is a bounded positive duration Schema; production maps its schema failure into the service's configuration error. Every request uses the same outer deadline. `PENDING` and `RUNNING` are observations, not guarantees of future progress. Tests assert a bounded number of reads and no POST, and use TestClock rather than sleeping in real time.

## 5. Consumer callback E/R, including failures after installation

A callback plan is generic in its consumer error and environment. Do not require consumers to flatten `SettingsUnavailable` into `BrowserbaseError`, call `Effect.runPromise` themselves, or capture a process-global runtime just to install a binding.

```ts
// Consumer composition using PROPOSED Bootstrap builders.
import { Context, Effect, Schema } from "effect";
import * as Bootstrap from "@effect-agent/browserbase/bootstrap";

class SettingsUnavailable extends Schema.TaggedError<SettingsUnavailable>()(
  "SettingsUnavailable", { retryable: Schema.Boolean },
) {}
const PublicSettings = Schema.Struct({ label: Schema.String, revision: Schema.Int });
class ShowSettings extends Context.Service<ShowSettings, {
  readonly read: Effect.Effect<typeof PublicSettings.Type, SettingsUnavailable>;
}>()("consumer/ShowSettings") {}

const settingsBootstrap = Bootstrap.binding({
  name: "getShowSettings",
  origins: ["https://portal.example.com"],
  input: Schema.Struct({ version: Schema.Literal(3) }),
  output: PublicSettings,
  maxConcurrent: 2,
  maxInputBytes: 256,
  maxOutputBytes: 4096,
  timeoutMillis: 3000,
  failureMode: "fail-session",
  handle: Effect.fn("consumer.getShowSettings")(function* () {
    return yield* (yield* ShowSettings).read;
  }),
});
// Required inferred shape: Bootstrap.Plan<SettingsUnavailable, ShowSettings>.
```

A plan is not a service and does not erase generic types by storing callbacks as `Effect<unknown, unknown, never>`. `Bootstrap.combine` must infer the union of each plan's E/R using variadic tuples or an equivalent typed builder; runtime lists may hold already-captured executors, but public inference cannot be replaced with `any`. Schema input/output environments must also be accounted for when a codec uses services; an initial API may deliberately accept environment-free boundary codecs and retain the handler's E/R.

**Temporal distinction:** an installation Effect that has already succeeded cannot fail later. `acquire/connect` report errors while they are executing. An installed registration exposes a supervised `failure: Effect<never, InitE | BootstrapError>` and a bounded, host-only event surface. `withBrowser` races the user's scoped work against the failure signal for `fail-session` bindings. The registration/connection is fenced on such a failure. For an explicit `reject-call` policy, a failed invocation rejects that call and emits typed host evidence without automatically ending unrelated work. Neither mode sends the consumer's full error to the webpage.

The native callback bridge captures consumer services **inside the owning connection scope**, then runs Effects from foreign callbacks through a scoped runtime. [FiberSet source][fiberset] provides this mechanism. The following illustrates environment capture and bounded admission; it is a **private host-side runner sketch**, not a public Promise API or a complete origin/schema/security adapter:

```ts
import { Effect, Exit, FiberSet, Scope } from "effect";

type CallResult<A, E> =
  | { readonly _tag: "Rejected" }
  | { readonly _tag: "Settled"; readonly exit: Exit.Exit<A, E> };

const makeCallRunner = <I, A, E, R>(
  maximum: number, // already decoded positive bound
  handle: (input: I) => Effect.Effect<A, E, R>,
) => Effect.gen(function* () {
  const run = yield* FiberSet.makeRuntimePromise<R, Exit.Exit<A, E>, never>();
  const scope = yield* Scope.Scope;
  let accepting = true;
  let inFlight = 0;
  // Registered after FiberSet: stop new admission before its finalizer interrupts fibers.
  yield* Scope.addFinalizer(scope, Effect.sync(() => { accepting = false; }));

  return (input: I): Promise<CallResult<A, E>> => {
    if (!accepting || inFlight >= maximum) return Promise.resolve({ _tag: "Rejected" });
    inFlight++;
    return run(Effect.exit(Effect.suspend(() => handle(input)))).then(
      (exit): CallResult<A, E> => ({ _tag: "Settled", exit }),
    ).finally(() => { inFlight--; });
  };
});
```

For this reusable generic function, a production implementation may use `fnUntraced` after verifying retained generic inference; the simple wrapper above emphasizes the exact E/R contract. `FiberSet.makeRuntimePromise` requires `R | Scope.Scope`, so building the runner requires `ShowSettings`, but later invocation need not fetch a new ambient service environment. The resulting Exit retains the consumer error/cause on the **host side**. A production native adapter must also catch a runtime-level rejected Promise and return a fixed page-safe rejection; it must not serialize an Exit to the webpage.

Before calling the runner: validate byte bounds, arguments, trusted native source identity, origin, connection epoch and current document epoch. Recheck epoch at execution and before publishing a result. Do not trust an origin field supplied by page JavaScript. Installation owns the native registration Disposable, unregistration and runtime scope. Stop admission, remove listeners/registration, fail pending replies, then interrupt fibers; late native completions are ignored or disposed. The bound is on admitted work, not only on how many handlers are currently inside a semaphore.

A binding may execute host-service work while the triggering browser action waits for it. It must not synchronously acquire the same browser mutation permit to navigate/click/observe: that is a reentrancy deadlock. Use an explicit post-action command queue with a finite admission bound for browser follow-up, or reject reentrant mutation. Consumer-owned HTTPS services and extension messaging remain alternative mechanisms, not reasons to expose raw browser objects.

## 6. Cleanup: one ordered program and honest receipts

The current [Session implementation][session] installs the writer lease finalizer before `terminate`, so teardown precedes lease settlement. Its terminate order is: fence; stop capture; request/reconcile remote release; disconnect local driver; report cleanup; then finalize writer lease. It separately tracks local and remote outcomes. Preserve this behavior during mechanical extraction; do not accidentally reorder it by moving finalizers into several Layer constructors.

The target owned-run cleanup has one coordinator in `session/Cleanup.ts`:

1. Atomically fence the owner and retire the connection epoch. Close is allowed to preempt the mutation permit; it must not wait behind a hung browser action.
2. Stop new callback/page/interval admission, invalidate retained observations, stop captures, dispose initialization registrations and settle/cancel child work while the connection is available.
3. Disconnect the local connection, retaining confirmed/failed/pending local evidence.
4. Independently request provider release and observe terminal status for the exact known session, even if local teardown failed. No reference means retain the allocation attempt as unknown, not invent a release target.
5. Produce a receipt separating child/native cleanup, local disconnect, provider release acceptance, terminal observation and reporting outcomes.
6. Settle or quarantine the Context writer/control lease using that receipt. Persistent data readiness remains a separate unconfirmed/readback fact.
7. Allow the outer account/client/application scope to close after its dependent cleanup work.

**Step 3 before 4 is a deliberate target-order change**, not a rename. It matches local-connection-inside-remote-lease ownership and reverse-acquisition finalization, but must land separately with disconnect-triggered termination, keep-alive and partial-failure tests. Stage 0 preserves the existing order; the lifecycle stage adopts the target order only after those checks. Both orders must independently attempt remote reconciliation and must not treat local closure as proof of termination or flush.

Borrowed attachment runs steps 1–3 and releases its local control claim according to the supervisor contract. It does not execute provider release, settle a supervisor-owned Context writer as committed, or delete Contexts/extensions. A durable supervisor owns the remote lifecycle outside that borrowed scope.

Use sequential scopes where order matters. `Scope.fork` can replace manual parent→child registration **only** when its automatic LIFO close position is the intended order. Do not fork a native connection scope after a remote finalizer and then claim remote-first cleanup. Child scope closing is idempotent, but an Effect that computes cleanup receipts is not automatically memoized; retain one `Effect.cached` close execution/result shared by explicit close, timeout and finalizer paths.

Explicit close returns structured evidence; fallback finalizers convert expected cleanup failures into receipts and safe diagnostics because a finalizer does not offer the caller a normal typed E channel. Preserve the primary workflow Exit. Never convert an unconfirmed cleanup into a successful remote receipt, and do not replace all cleanup errors with `Effect.ignore`. Capturing `Effect.exit` around an independent cleanup step allows later steps to run while retaining its failure/defect/interruption evidence; public projection strips foreign contents.

All owned library waits must be bounded. **A timeout cannot preempt synchronous blocking JavaScript or a deliberately uninterruptible consumer Effect.** Callback/lease contracts require cooperative cancellation and bounded settlement; adversarial host code needs process isolation, not a stronger type signature. This qualification matters when promising cleanup latency. Keep uncertain native resources quarantined until actual stop/closure evidence permits reuse.

## 7. What Effect can simplify, and what it cannot

| Current mechanism | Recommended simplification | Preserve explicitly |
| --- | --- | --- |
| Manual resource scope plus parent finalizer | Sequential `Scope.fork/use` where close order permits | One cached close coordinator and exact Exit/receipt handling |
| Promise/event callback collections | Scoped FiberSet for Effect tasks and native Disposables for registrations | Admission before fork; foreign Promise completion/late disposal still needs native tracking |
| `makeHttp` at four call sites | One Client Layer dependency and feature Layers | Strict account decode, separate media authority, captured fetch and trace isolation |
| Repeated numeric transfer checks | Feature Schemas and common TransferPolicy | Different limits remain different contracts; frame+byte bounds cannot be replaced by one item-count Queue |
| `owner.state` writes from Session | Named transition methods with one state record | Immediate synchronous generation fencing and ticket AbortController for late native dispatch |
| Ad hoc lifecycle polling | Reusable bounded wait with the same monotonic deadline | No retries of uncertain create/action POSTs; status read is not a mutation replay |
| Repeated public/native/framework forwarding | Generic operation implementation plus one adapter projection | Framework request/error contracts and legacy handle semantics |

Do not replace `Owner.native` with a bare `Effect.tryPromise` and declare cancellation solved. HTTP fetch can honor an AbortSignal; Playwright actions may already have dispatched and continue after the fiber exits. Retain checks immediately before dispatch, post-dispatch unknown classification, both Promise settlement handlers, late connection disposal and retired-epoch filtering. `Effect.acquireRelease` normally protects acquisition/finalizer registration; a remote create that might succeed with a lost reply additionally needs the **preinstalled allocation journal/finalizer** already present in this repository. A shorter acquireRelease call is not equivalent.

## 8. Verification required before adopting these sketches

Add exact type assertions modeled on [the current public type tests][type-tests]: explicit acquisition includes Scope; scoped helper excludes Scope introduced by both consumer/initialization; `ShowSettings` survives in R until provided; `SettingsUnavailable` survives in the supervised E/failure contract; heterogeneous Bootstrap plans preserve unions; adapter handle still has the installed framework type. Compile emitted NodeNext declarations with `skipLibCheck:false` and no framework/native peer in the generic resource consumer.

Use TestClock and failpoints for allocation before/after identity capture, late successful connection after interruption, stale callbacks, callbacks racing closure, permit saturation, binding failure during navigation, interruption during each cleanup step and settlement failure. Assert no duplicate POST/close/settlement, no post-close callback acceptance, exact cleanup ordering and independent remote/local evidence. Preserve real native tests for late discovery, observed-node replacement and capture timestamps. A mocked unit pass cannot prove Chromium or hosted behavior.

[effect-revision]: https://github.com/Effect-TS/effect/tree/4a05d4914fa2327a42bd75fe77c22c188becf3b4
[guide]: https://github.com/Effect-TS/effect/blob/4a05d4914fa2327a42bd75fe77c22c188becf3b4/LLMS.md
[copy-guide]: https://github.com/Effect-TS/effect/blob/4a05d4914fa2327a42bd75fe77c22c188becf3b4/scripts/copy-ai-docs.mjs
[scope]: https://github.com/Effect-TS/effect/blob/4a05d4914fa2327a42bd75fe77c22c188becf3b4/packages/effect/src/Scope.ts
[fiberset]: https://github.com/Effect-TS/effect/blob/4a05d4914fa2327a42bd75fe77c22c188becf3b4/packages/effect/src/FiberSet.ts
[layers]: https://github.com/Effect-TS/effect/blob/4a05d4914fa2327a42bd75fe77c22c188becf3b4/ai-docs/src/01_effect/03_services/20_layer-composition.ts
[pins]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/CONTRIBUTING.md
[patch]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/upstream.patch
[owner]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/src/internal/Owner.ts
[session]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/src/internal/Session.ts
[type-tests]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/test/public-types.test.ts
[contexts-api]: https://github.com/browserbase/sdk-node/blob/v2.20.0/src/resources/contexts.ts
