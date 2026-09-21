# Effect implementation conventions and representative code

**Design examples, not implemented exports or typechecked results.** The source-declared pins remain Effect **4.0.0-rc.115**, TypeScript **7.0.2**, Effect Agent/testing **0.1.0-beta.102**, Playwright **1.63.0**, Node **24.14.1**, Bun **1.4.2**. Keep the coordinated catalog/lockfile unchanged during extraction. [Current pins][pins], [integration patch][patch].

The exact Effect release tag resolves to [`4a05d4914fa2327a42bd75fe77c22c188becf3b4`][effect-revision]. Its [packaging script][copy-guide] copies root `LLMS.md` into each public package's `AGENTS.md` and `CLAUDE.md`. The complete [source guidance][guide] was read together with relevant pinned source. This identifies the installed guidance's source without pretending a local `node_modules/effect` existed. Git/npm publisher access failed DNS resolution, so **none of these sketches was compiled or executed**. They must not be accepted on an unpinned host compiler as a substitute.

## 1. A short, enforceable convention table

| Concern | Convention | Application here |
| --- | --- | --- |
| Services | `Context.Service` for meaningful shared dependencies; public operations return Effect/Stream | Client, resource services and browser binding. Per-session owners/registries/buffers remain factory-created values |
| Layers | `Layer.effect` acquires dependencies once; `Layer.succeed` supplies an existing test port; share Layer values through `provide`/`provideMerge` | [Pinned Layer example][layers]. No independent runtime/client construction per request |
| Configuration | Strict Schema decode of account configuration once, then launch/operation/callback admission at their own boundaries | Fix `httpOptions`/artifact asymmetry without weakening the credential schema |
| Data | Schema for transported/persisted/public structured data; live authority is not serialized | Qualified References and feature schemas, not casts through unknown replies |
| Errors | Expected failures in E; defects/interruption preserved as causes internally; public projection sanitized | No arbitrary native cause, parse error or `Schema.Defect` containing provider material in public records |
| Lifetime | Explicit acquisition retains Scope; scope-providing use helpers discharge it | Native registration/connection/capture resources have named owning scopes |
| Cancellation | Interrupt the waiter and separately classify/fence native dispatch | [Owner][owner] and [Session][session]; abort is not rollback |
| Concurrency | Nonwaiting busy admission for mutations; callback admission bounded before fiber creation | `withPermitsIfAvailable`, not unbounded waiters parked behind a Semaphore |
| Streams | Frame/byte/time bounds and scoped consumers | A count-bounded Queue alone cannot replace the byte-accounted capture buffer |
| Diagnostics | Static spans and explicitly allowed safe facts | Keep HTTP trace isolation; no default page data, signed URLs, script contents or native messages |

## 2. Readable Effect functions

Use `Effect.gen` for inline compositions and Layer construction. Use `Effect.fn("BrowserbaseContexts.retrieve")` for reusable operations whose span is useful. Use `Effect.fnUntraced` for private helpers, per-frame work and internal lifecycle transitions where another span is noise. Do not mechanically trace every helper or preserve wrappers whose only purpose is returning a generator when a suitable fn form expresses the intent. [Pinned guidance][guide].

Prefer short combinators for maps/projections and reusable policies. A validated recipe→DTO compiler can be a pure TypeScript function; image geometry and deadline arithmetic do not need service tags. Do not turn every local Map into an ambient Ref service. One private record under the owner permit often makes atomic transitions easier to read than several independently writable Refs.

Name spans statically, never with a URL, Context name, selector or user identity. Put only approved fields into annotations. Generic diagnostics use Effect's logging/tracing and a narrowly typed optional host sink; only the adapter may integrate a framework-specific ErrorReporter. Importing that reporter into the generic package would recreate the dependency being removed.

Use the pinned vocabulary: `Context.Service`, `Layer.effect`, `Effect.catch`/`catchTag`, `Effect.result`/`exit`, `Effect.callback`, scoped FiberSet and correctly owned `forkIn`/`forkChild`. Do not substitute Effect 3 service/callback recipes. The full official Effect ecosystem and required dependencies are permitted; each addition still needs a concrete use and coordinated version pins.

## 3. Service composition and configuration ownership

### Before and after: account construction

```ts
// BEFORE: inspected construction patterns, not four coordinated shared services.
makeHttp(httpOptions(interactiveOptions)); // interactive boundary projects fields
makeHttp(artifactOptions);                // artifact boundary rejects excess fields
// Each resource layer independently constructs its HTTP/provider wrapper.
```

After extraction, one strict Client owns account/fetch/request/media policies; resource services acquire that dependency and own their endpoints. The browser service consumes Sessions and the trusted native binding.

```ts
// AFTER: PROPOSED exports; no hosted request occurs while assembling these Layers.
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

`account` is a host-supplied strict account configuration, not a launch recipe. The application also provides the required approved Fetch service, as shown in workflows. Share the **same Layer value**; repeatedly constructing equal-looking Client Layers is not the intended sharing contract. Resource-only consumers use ResourcesLive and never install the framework or native peer.

Client still captures an approved fetch and uses official FetchHttpClient with its own RequestInit/tracing isolation. It does not accept an arbitrary ambient HttpClient transformer that can forward credentials. Environment loading belongs at the consumer entry point. (`BrowserbaseClient.layerConfig`, [#32](https://github.com/mannyc2/effect-agent-browserbase/issues/32), reads through the consumer's `ConfigProvider` when the Layer is built, so the consumer still chooses the source.) Sharing Client is not proof that current clients have rate schedulers; new shared admission requires its own implementation. Likewise, replace recording's global mutation gate with a bounded keyed gate only when supported by actual independent-session tests.

### Representative resource operation

The **proposed Contexts.ts** below uses the existing sanitized BrowserbaseError vocabulary during initial extraction. Client has projectId and a bounded `json(method,path,body?)` operation. Separate no-content/multipart methods are added when needed; a 204 delete is not parsed as JSON. No forwarding-only ContextProvider service is inserted.

```ts
import { Context, Effect, Layer, Schema } from "effect";
import { BrowserbaseClient } from "./Client.ts";
import { BrowserbaseError } from "./Errors.ts";
import { ContextReference, Identifier } from "./References.ts";

const Timestamp = Schema.String.check(Schema.isMaxLength(64));
const ContextMetadata = Schema.Struct({
  id: Identifier,
  projectId: Identifier,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  name: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1024))),
});
type ContextMetadata = typeof ContextMetadata.Type;

export class BrowserbaseContexts extends Context.Service<
  BrowserbaseContexts,
  { readonly retrieve: (reference: ContextReference) => Effect.Effect<ContextMetadata, BrowserbaseError> }
>()("@effect-agent/browserbase/Contexts") {
  static readonly layer: Layer.Layer<BrowserbaseContexts, never, BrowserbaseClient> = Layer.effect(
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
            return yield* BrowserbaseError.make({ operation: "context-retrieve", reason: "malformed" });
          }
          return result;
        },
      );
      return BrowserbaseContexts.of({ retrieve });
    }),
  );
}
```

The explicitly annotated Layer states that construction requires Client and does not perform/fail a resource request. It also prevents a public declaration from depending on the inferred shape of a private implementation closure. The illustrative name bound is a local defensive response bound, **not a claim of a provider's name limit**; production uses common field schemas justified by the chosen contract. Cross-resource identity comparison is a semantic check, not redundant string validation.

Input configuration rejects unknown/conflicting authority fields. Provider response decoding tolerates irrelevant new upstream fields while validating what the operation uses. Never serialize the raw response, Schema error or SDK exception into a public failure. Add create/delete in the same resource module. Context creation persists beyond a call; session scope finalizers never delete it. [Provider API][contexts-api].

### Error families without a class explosion

Stage 0 preserves the existing error/encoded shapes. Stage 1 introduces a small generic taxonomy: configuration/provider-request errors; allocation rejection versus uncertain allocation carrying attempt identity; browser operation failure with dispatch/target evidence; initialization/binding failure; and artifact/transfer failure. Discriminated reasons inside a coherent family are preferable to both one universal enum and one error class per method.

Private diagnostics retain only approved causal metadata and failure/defect/interruption classification. Adapter Errors projects into the pinned framework vocabulary and legacy BrowserbaseError; it does not guess dispatch state from native text. BYOS delivery, missing/disabled recording and partial page results are modeled outcomes where appropriate, not an undifferentiated transport exception. Callback-specific E is preserved on host supervision rather than serialized into the page's reply.

## 4. Scope signatures: remove the requirement actually supplied

The earlier report's helper signatures did not consistently remove Scope introduced by consumer code. The precise rule is:

```ts
// Self-contained combinator sketch; still uncompiled here.
import { Effect, type Scope } from "effect";

export const useScoped = <S, A, AcquireE, AcquireR, E, R>(
  acquire: Effect.Effect<S, AcquireE, AcquireR>,
  use: (resource: S) => Effect.Effect<A, E, R>,
): Effect.Effect<A, AcquireE | E, Exclude<AcquireR | R, Scope.Scope>> =>
  Effect.scoped(Effect.flatMap(acquire, use));
```

Explicit acquisition returns `Effect<Resource,E,R | Scope.Scope>`. A helper supplying/closing its own scope returns `Exclude<R,Scope.Scope>`, including Scope from **consumer work and initialization**, not just library acquisition. It cannot remove unrelated services. Scope.provide supplies without closing; Scope.use supplies an existing closeable scope and closes it. [Pinned Scope signatures][scope].

```ts
// PROPOSED browser API signatures; data contracts are in architecture/workflows.
declare const acquire: <InitE, InitR>(
  request: OpenRequest<InitE, InitR>,
) => Effect.Effect<
  OwnedBrowserAcquisition<InitE>, BrowserbaseError | InitE,
  BrowserbaseBrowser | InitR | Scope.Scope
>;

declare const withBrowser: <A, E, R, InitE, InitR>(
  request: OpenRequest<InitE, InitR>,
  use: (browser: BrowserSession<InitE>) => Effect.Effect<A, E, R>,
) => Effect.Effect<
  A, E | InitE | BrowserbaseError,
  BrowserbaseBrowser | Exclude<R | InitR, Scope.Scope>
>;
```

`withBrowser` additionally supervises fail-session bootstrap failures and applies its declared cleanup policy: normal success requires confirmed remote termination. Explicit acquisition exposes the receipt instead. Failure/interruption still runs fallback cleanup, retaining additional cleanup evidence without overwriting the primary cause.

A type parameter A cannot prove the consumer did not return a live session/Stream closing over it. Only durable data should escape; runtime generation/scope checks reject stale use. Scoped helper typechecking is not a proof against arbitrary object retention.

The per-acquisition `contextWriter?: ContextWriterPermit` is a scoped live capability, whose backend settlement E/R is preserved by the outer `withWriter` helper. That helper closes browser child scopes before coordinator settlement. Its explicit contract is in [the writer workflow](workflows.md#4-persistent-account-workflow-and-coordinator-types); account configuration never holds the coordinator closure.

### Representative lifecycle operation

A passive terminal wait is separate from release. Supporting retrieve/terminal/deadline functions are owned by this proposed Sessions module; `WaitOptions` is its bounded positive-duration Schema.

```ts
const waitForTerminal = Effect.fn("BrowserbaseSessions.waitForTerminal")(
  function* (reference: SessionReference, timeoutMillis: number) {
    const bounds = yield* Schema.decodeUnknownEffect(WaitOptions)({ timeoutMillis }).pipe(
      Effect.mapError(() => BrowserbaseError.make({
        operation: "session-wait", reason: "configuration", outcome: "undispatched",
      })),
    );
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

Every read shares one outer monotonic deadline. PENDING/RUNNING do not guarantee progress or a provider queue. Tests assert no POST, bounded reads and cancellation using TestClock. A timeout does not cause a release POST to be replayed.

## 5. Consumer callback E/R, including failures after installation

A callback plan is generic in consumer E/R. Do not demand flattening a consumer error into BrowserbaseError, a process-global runtime or consumer-owned runPromise plumbing.

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
// Required inference: Bootstrap.Plan<SettingsUnavailable, ShowSettings>.
```

Plans are values, not service tags. Bootstrap.combine must preserve the union of constituent E/R through a typed tuple/builder, not store public callbacks as `Effect<unknown,unknown,never>` or cast away requirements. Boundary codecs with service requirements need those R types accounted for too; an initial builder may explicitly accept environment-free codecs while preserving handler E/R.

An installation Effect that returned success cannot fail later. A registration/session exposes `failure: Effect<never,InitE | BootstrapError>` and bounded host-only typed events. `withBrowser` races consumer work against the failure signal for fail-session bindings and fences the connection. Explicit reject-call mode rejects one invocation and emits host evidence without silently killing unrelated work. Neither sends the full consumer error to the webpage.

The native callback runner captures consumer services in its registration scope. The pinned [FiberSet][fiberset] runtime is suitable for this bridge. This is a **private runner sketch**, not a public Promise API or a complete origin/schema/epoch adapter:

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
  yield* Scope.addFinalizer(scope, Effect.sync(() => { accepting = false; }));

  return (input: I): Promise<CallResult<A, E>> => {
    if (!accepting || inFlight >= maximum) {
      return Promise.resolve<CallResult<A, E>>({ _tag: "Rejected" });
    }
    inFlight++;
    return run(Effect.exit(Effect.suspend(() => handle(input)))).then(
      (exit): CallResult<A, E> => ({ _tag: "Settled", exit }),
    ).finally(() => { inFlight--; });
  };
});
```

The simple generic wrapper makes E/R explicit; a production fnUntraced refactor must preserve that inference. FiberSet.makeRuntimePromise requires `R | Scope.Scope`: ShowSettings is required when installing, not supplied by the webpage. Admission occurs before fiber creation. The admission finalizer is registered after FiberSet so sequential finalization closes admission before interrupting the set's fibers. Exit retains consumer causes **only on the host**; the native adapter also handles runtime-level rejected Promises and returns fixed page-safe rejection, never serializing this Exit.

Before runner invocation, bound input bytes, decode arguments, verify trusted native source origin and current connection/document epochs. Recheck epoch before executing/publishing results. Never trust a page-supplied origin claim. Installation owns native registration disposal, closure of admission, pending replies and runtime scope. Remove listeners/registrations and cancel owned fibers in the specified order; late native completions are ignored/disposed. Native promises that do not honor interruption remain separately tracked.

A binding called during a browser action must not request another action/observation behind the same held mutation permit: it deadlocks. Host-service work may proceed; browser follow-up is explicitly queued with bounded admission after the first action or rejected as reentrant. Alternative extension messaging/consumer HTTPS services do not justify raw Browser/CDP access.

## 6. Cleanup: one ordered program and honest receipts

The current [Session][session] installs the writer finalizer before terminate, so teardown precedes writer settlement. Its terminate order is fence → stop capture → request/reconcile remote release → disconnect local driver → report → writer finalization. **Preserve this order during mechanical extraction.** Moving finalizers between Layer constructors is not a license to alter it accidentally.

The target owned coordinator in `session/Cleanup.ts` is an explicit later change:

1. Fence immediately and retire connection epoch. Close preempts rather than queues behind a hung mutation.
2. Stop callback/page/interval admission; invalidate observations; stop captures and dispose registrations/child work while connection is available.
3. Disconnect locally, retaining confirmed/failed/pending evidence.
4. Independently request remote release and observe the exact known session even if local teardown failed. No known reference means unknown attempt evidence, not a fabricated release target.
5. Aggregate separate child/native, local, release-request, terminal and reporting facts.
6. Settle/quarantine the consumer writer/control lease; Context visibility remains independent evidence.
7. Close outer Client/application dependencies only after dependent cleanup.

Local-before-remote steps 3–4 are **a deliberate Stage 4 behavior change**, justified by nested local/remote ownership and requiring disconnect-triggered termination, keepAlive and partial-failure tests. Stage 0 retains current order. Both orders independently reconcile remote state; neither infers termination or flush from disconnection.

Borrowed attachment executes local steps 1–3 and its control-claim cleanup, not provider release or supervisor writer settlement. The remote supervisor owns those operations. Contexts/extensions are not session-finalized resources.

Use sequential scopes where ordering matters. Scope.fork can replace manual parent→child registration only when its LIFO position matches the contract. Scope closing is idempotent, but receipt computation is not automatically memoized: retain one cached close execution/result across explicit close, deadline and finalizer callers. Named owner transitions replace direct writable state without removing synchronous ticket/AbortController behavior.

Explicit close returns receipts; fallback finalizers convert expected cleanup failures to safe receipts/diagnostics because finalizers do not offer an ordinary typed E return channel to the caller. Preserve the primary workflow Exit. Capturing independent cleanup with Effect.exit lets subsequent steps run without converting an unconfirmed result into success. Do not replace every failure with Effect.ignore or serialize foreign causes in a receipt.

All library-owned waits are bounded. A timeout cannot preempt synchronous blocking JavaScript or a deliberately uninterruptible consumer Effect. Host callbacks/coordinators must cooperate with cancellation; hostile host code requires process isolation, not a stronger generic signature. Uncertain native resources remain quarantined until actual closure/stop evidence authorizes reuse.

## 7. Simplification without deleting guarantees

| Before | After | Must remain |
| --- | --- | --- |
| Four makeHttp/makeProvider sites | One Client dependency; resource modules own routes | Strict account decode, media separation, captured fetch/trace isolation |
| Session mutates owner.state.phase directly | `owner.commitConnected(epoch)` / named transitions | Atomic phase/generation/admission invariants and immediate native fencing |
| Manual scope plus parent finalizer | Sequential Scope.fork/use where equivalent | Cached close receipts and exact finalizer order |
| Promise callback task collection | Scoped FiberSet for Effect callbacks; native Disposables | Admission before fork; separate native late-completion tracking |
| Repeated transfer validation | Shared TransferPolicy + feature Schemas | Distinct limits and frame+byte accounting, not one count-only Queue |
| Repeated native/framework forwarding | Generic action implementation and one adapter projection | Installed framework request/error/handle compatibility |

Do not replace Owner.native with bare Effect.tryPromise and call interruption solved. Fetch can honor AbortSignal; a Playwright action can already have dispatched and complete after the fiber exits. Preserve before-dispatch checks, unknown classification after dispatch, both settlement handlers, late connection disposal and retired-epoch callbacks. Similarly, remote allocation needs a preinstalled attempt journal/finalizer even when its reply is lost; a shorter optimistic acquireRelease expression is not equivalent.

A provider setting changes Contract/Launch and wire tests, a resource operation changes its resource module/HTTP tests, and bootstrap changes registrations/readiness/callback tests. None should require adding another owner or an unrelated runtime package. [File-level change recipes](implementation-plan.md#three-ordinary-change-recipes).

## 8. Required verification before adopting the sketches

Retain [current public type assertions][type-tests] and add exact E/R tests: acquisition includes Scope; scoped helpers exclude Scope introduced by library, consumer and init; consumer service/error remain until provided/handled; heterogeneous plans preserve unions; explicit registration failure supervision retains InitE; adapter handles keep the installed framework type. Annotate public Layers/contracts so private implementation types cannot leak into emitted declarations. Check NodeNext with skipLibCheck:false in a consumer lacking framework/native peer.

Use TestClock/failpoints for allocation before/after identity capture, late connection after interruption, stale callback generation, callback/close races, saturated admissions, binding failure during navigation, each cleanup step and coordinator settlement failure. Assert no duplicate POST/close/settlement, no post-close admission, exact ordering and independent remote/local facts. Preserve real native replacement-node/capture/timestamp checks. Inspected code and mocked tests cannot prove hosted behavior.

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
