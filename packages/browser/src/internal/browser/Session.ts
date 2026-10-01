import {
  Cause,
  Clock,
  Crypto,
  Deferred,
  Duration,
  Effect,
  Exit,
  Option,
  Redacted,
  Schema,
  Scope,
} from "effect";

import type { OperationOptions, PageStatus } from "../../Browser.ts";
import {
  type FillFormRequest,
  type FormField,
  type FrameInfo,
  InputReceipt,
  ActionResult,
  NavigationResult,
  FillFormResult,
  Checkpoint,
  Inventory,
  type KeyModifier,
  Observation,
  type ObservedElement,
  type PageInfo,
  type PageSuspension,
  Target,
  type Viewport,
  type WaitForElementRequest,
} from "../../BrowserData.ts";
import type { Lifetime, Source } from "../../BrowserRuntime.ts";
import { BrowserError, Reasons, type BrowserOperation } from "../../Errors.ts";
import type {
  ActionTarget,
  ValueSource,
  Descriptor,
  ResolveGuard,
  SettledOptions,
  SettledEvidence,
  RunPhase,
  RunReceipt,
  InputBindings,
  Step,
} from "../../PlanData.ts";
import {
  TimelineDefaults,
  type Retention,
  type Terminal,
  type TerminalReason,
} from "../../TimelineData.ts";
import {
  cachedTarget,
  captureMetadata,
  observeTickets,
  planPublisher,
  publish,
} from "../timeline/Producers.ts";
import { makeRetirement } from "../timeline/Retirement.ts";
import { makeJournal } from "../timeline/SessionJournal.ts";
import { makeStore } from "../timeline/Store.ts";
import type { AdmissionLane } from "./Admission.ts";
import { type CaptureMetadata, type CaptureParent } from "./Association.ts";
import type { BindingImplementation, ConnectionIdentity } from "./Binding.ts";
import type { ConnectionBindings } from "./Bindings.ts";
import { cleanupStep, type ConnectionCleanup, type ConnectionState } from "./ConnectionCleanup.ts";
import type {
  Driver,
  NativeCachedPage,
  DriverEvents,
  DriverFault,
  DriverOptions,
  DriverTarget,
  ElementTarget,
  NativeSelectOptions,
  NativeFormField,
  InputCapture,
  NativeFileSelection,
  NavigationControl,
} from "./Driver.ts";
import { publicError } from "./NativeCalls.ts";
import type { AdmissionPolicy, ResolvedElement, ResolvedGroup } from "./Observation.ts";
import {
  makeOwner,
  native,
  within,
  type Limits,
  type ObservationScope,
  type OwnedWait,
  type ExecutionEvidence,
  type Ticket,
  type WaitTicket,
} from "./Owner.ts";
import { actionTargets, makePlanExecution, type StepExecution } from "./PlanExecution.ts";
import type { NativeInput, NativePoint } from "./Pointer.ts";
import { randomUuid } from "./Random.ts";

export type SessionLease = Lifetime;
export type RemoteSource<L extends SessionLease, E, R = never> = Source<L, E, R>;

/** Bounds a reading of the selected document. Already validated at the public boundary. */
export interface Reading {
  readonly scope: "document" | "viewport";
  readonly match?: string;
  readonly maxTextBytes?: number;
  readonly maxControls?: number;
}

/** How a form proceeds. Already validated and defaulted at the public boundary. */
export interface FormSettings {
  readonly verify: boolean;
  readonly settleMillis: number;
}

/** Private composite bounds and evidence cannot enter through decoded public options. */
export interface ExecutionOptions extends OperationOptions {
  readonly operationDeadline?: number;
  readonly queueDeadline?: number;
  readonly evidence?: ExecutionEvidence;
  readonly beforeNative?: (driver: Driver, ticket: Ticket) => Promise<void>;
  readonly phase?: (phase: RunPhase, fieldIndex?: number) => void;
}

type DeferredElementTarget = ElementTarget | (() => ElementTarget);

const codePointCount = (text: string): number => {
  let count = 0;

  for (const _point of text) count++;

  return count;
};

const elementTarget = (value: DeferredElementTarget): ElementTarget =>
  typeof value === "function" ? value() : value;

const effectiveTarget = (value: ElementTarget | undefined, fallback: DriverTarget): DriverTarget =>
  typeof value === "object" && "_tag" in value && value._tag === "ResolvedElement"
    ? value.target
    : fallback;

export interface FormBindings {
  readonly reference: (id: string) => ObservedElement | ResolvedElement;
  readonly field: (field: FormField) => NativeFormField;
}

/** What a form did; the public boundary decodes it. */
export interface FormOutcome {
  readonly fields: ReadonlyArray<{
    readonly elementId: string;
    readonly status: "set" | "unchanged";
    readonly input?: InputReceipt;
  }>;
  readonly submitted: boolean;
  readonly url: string;
  readonly submitInput?: InputReceipt;
  readonly stopped?: {
    readonly stage: "field" | "verify" | "submit";
    readonly elementId?: string;
    readonly error: BrowserError;
  };
}

interface NavigationStopAttempt<E> {
  readonly result: Deferred.Deferred<void, E>;
  readonly retired: Deferred.Deferred<void>;
  running: boolean;
  committed: boolean;
  setupPending: boolean;
}

/**
 * Callers share the active attempt. Its owner may cancel it, but a committed Exit is permanent.
 * Before commitment, retry waits for actual native setup and port retirement, not the waiter.
 */
const makeNavigationStopCoordinator = <E, R>(
  done: () => boolean,
  attempt: (
    onDispatch: () => void,
    retainSetup: () => () => void,
    deadline?: number,
  ) => Effect.Effect<"dispatched" | "settled", E, R>,
  confirmed: () => void,
) =>
  Effect.sync(() => {
    let current: NavigationStopAttempt<E | BrowserError> | undefined;

    const request = (deadline?: number): Effect.Effect<void, E | BrowserError, R> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.suspend(() => {
          // Fencing may complete the navigation while a committed stop is still failing.
          if (current !== undefined && (current.running || current.committed)) {
            const joined = current;

            if (deadline === undefined || joined.committed)
              return restore(Deferred.await(joined.result));

            return restore(Effect.exit(Deferred.await(joined.result))).pipe(
              Effect.flatMap((exit) =>
                Exit.isSuccess(exit) || joined.committed
                  ? exit
                  : restore(Deferred.await(joined.retired)).pipe(Effect.andThen(request(deadline))),
              ),
            );
          }
          if (done()) return Effect.void;
          if (current !== undefined) {
            if (deadline !== undefined)
              return restore(Deferred.await(current.retired)).pipe(
                Effect.andThen(request(deadline)),
              );

            return Effect.fail(
              BrowserError.make({
                operation: "navigate-stop",
                reason: Reasons.Busy.make({}),
                outcome: "undispatched",
              }),
            );
          }

          const active: NavigationStopAttempt<E | BrowserError> = {
            result: Deferred.makeUnsafe(),
            retired: Deferred.makeUnsafe(),
            running: true,
            committed: false,
            setupPending: false,
          };

          current = active;

          const retire = () => {
            active.setupPending = false;
            if (!active.running) {
              if (!active.committed && current === active) current = undefined;
              Deferred.doneUnsafe(active.retired, Effect.void);
            }
          };

          return restore(
            Effect.suspend(() =>
              attempt(
                () => {
                  active.committed = true;
                },
                () => {
                  active.setupPending = true;

                  return retire;
                },
                deadline,
              ),
            ),
          ).pipe(
            Effect.tap((result) =>
              result === "dispatched" ? Effect.sync(confirmed) : Effect.void,
            ),
            Effect.asVoid,
            Effect.onExit((exit) =>
              Effect.sync(() => {
                active.running = false;
                if (!active.committed && !active.setupPending) current = undefined;
                if (!active.setupPending) Deferred.doneUnsafe(active.retired, Effect.void);
                Deferred.doneUnsafe(active.result, exit);
              }),
            ),
          );
        }),
      );

    return {
      stop: request(),
      recover: (deadline: number) =>
        within(request(deadline), deadline, () =>
          BrowserError.make({
            operation: "navigate-stop",
            reason: Reasons.Timeout.make({}),
            outcome: current?.committed === true ? "unknown" : "undispatched",
          }),
        ),
    };
  });

/** Explicit callers retain the original cancellation and fail-fast admission contract. */
export const makeNavigationStop = <E, R>(
  done: () => boolean,
  attempt: (
    onDispatch: () => void,
    retainSetup: () => () => void,
  ) => Effect.Effect<"dispatched" | "settled", E, R>,
  confirmed: () => void,
) =>
  makeNavigationStopCoordinator(done, attempt, confirmed).pipe(
    Effect.map((coordinator) => coordinator.stop),
  );

export interface SessionOptions<L extends SessionLease, E, R = never> {
  readonly implementation: string;
  readonly remote: RemoteSource<L, E, R>;
  /** The constructor resolves an issued binding before acquiring the lifetime. */
  readonly engine: BindingImplementation;
  /** Only a keep-alive session may detach and reattach inside this owner. */
  readonly keepAlive: boolean;
  readonly driver: DriverOptions;
  readonly maxReturnedBytes: number;
  /** Consumer E/R stays with the typed public supervisor; this installs its captured runtime. */
  readonly connectBindings?: (
    onFault: (event: DriverFault) => void,
    isActive: () => boolean,
    isCurrent: () => boolean,
  ) => Effect.Effect<ConnectionBindings, never, Scope.Scope>;
}

/**
 * One owner for page operations, bootstrap, capture and connection cleanup. The lifetime source
 * decides whether release also terminates a browser and how that termination is observed.
 */
export const acquireSession = Effect.fnUntraced(function* <L extends SessionLease, E, R>(
  limits: Limits & { readonly timelineLimits?: Retention },
  options: SessionOptions<L, E, R>,
) {
  // The engine is resolved before anything is allocated, so an unissued binding costs nothing.
  const engine = options.engine;

  if (engine === undefined)
    return yield* BrowserError.make({
      operation: "connect",
      reason: Reasons.Configuration.make({}),
      outcome: "undispatched",
    });
  const parentScope = yield* Scope.Scope;
  // Register the binding lifetime BEFORE the remote cleanup finalizer. On natural Scope
  // shutdown that finalizer must fence the owner before any callback finalizer can reenter it.
  const bindingLifetime = yield* Scope.fork(parentScope, "sequential");
  const ended = yield* Deferred.make<void>();
  const owner = yield* makeOwner(limits);
  const clock = owner.clock;
  let activeRuns = 0;
  const pageRuns = new Map<string, number>();
  const uuid = randomUuid(yield* Crypto.Crypto);
  const clockId = yield* uuid;
  const originNanos = clock.monotonicTimeNanosUnsafe();

  const makeDomain = (storeId: string) => {
    const store = makeStore({
      clock,
      originNanos,
      identity: { storeId, clockId },
      limits: limits.timelineLimits ?? TimelineDefaults,
    });

    return {
      store,
      retirement: makeRetirement((reason) => {
        store.finish(reason);
      }),
    };
  };

  let domain = makeDomain(yield* uuid);
  let hasConnectedStore = false;

  let driver: Driver | undefined;
  let connectPending = false;
  // Native listeners can outlive disconnect. Authority belongs to this connection
  // lease, not merely to the current session phase or selected browser target.
  let activeConnection: object | undefined;
  let handoffToken: string | undefined;
  let reconnectTarget: string | undefined;
  let activeBindings: ConnectionBindings | undefined;

  const pages = new Map<
    string,
    {
      readonly identity: Target;
      readonly admission: AdmissionLane;
      readonly info: PageInfo;
      readonly frames: Map<string, { detached: boolean }>;
      phase: "open" | "paused" | "closing" | "closed";
      containment: PageStatus["containment"];
      readonly store: ReturnType<typeof makeStore>;
      readonly terminal: Terminal | null;
      readonly retirement: ReturnType<typeof makeRetirement>;
      attempt?: Deferred.Deferred<boolean>;
    }
  >();

  const journal = makeJournal({
    store: () => domain.store,
    cachedPages: () => driver?.cachedPages() ?? [],
    pageStatus: (pageId) => {
      const record = pages.get(pageId);

      return record === undefined
        ? owner.state.phase === "open" || owner.state.phase === "acquiring"
          ? undefined
          : {
              phase:
                owner.state.phase === "closing"
                  ? "closing"
                  : owner.state.phase === "closed"
                    ? "closed"
                    : owner.state.phase === "paused"
                      ? "paused"
                      : "stale",
              containment:
                owner.state.phase === "uncertain"
                  ? { _tag: "SessionFenced", generation: owner.state.generation }
                  : { _tag: "NotRequired" },
            }
        : {
            phase: record.identity.generation === owner.state.generation ? record.phase : "stale",
            containment: record.containment,
          };
    },
    generation: () => owner.state.generation,
  });

  owner.observePhase((phase) => {
    publish(domain.store, { target: null, correlation: null, event: { _tag: "Lifecycle", phase } });
  });

  owner.observeTickets(
    observeTickets({
      store: () => domain.store,
      clock,
      originNanos,
      cachedPages: () => driver?.cachedPages() ?? [],
      retain: (pageId) => {
        const releaseDomain = domain.retirement.retain();

        const releasePage =
          pageId === undefined ? undefined : pages.get(pageId)?.retirement.retain();

        return () => {
          releasePage?.();
          releaseDomain();
        };
      },
    }),
  );

  const retirePageTimeline = (
    record: typeof pages extends Map<string, infer P> ? P : never,
    reason: TerminalReason,
  ) => {
    record.retirement.request(reason);
  };

  const endTimeline = (reason: TerminalReason) => {
    for (const record of pages.values()) retirePageTimeline(record, reason);
    domain.retirement.request(reason);
  };

  let initialTarget: DriverTarget | undefined;
  let initialInfo: PageInfo | undefined;
  let initialAuthority: ReturnType<typeof registerPage> | undefined;
  const pausedPages = new Set<string>();

  const pageClosed = (pageId: string, cached?: NativeCachedPage, store = domain.store) => {
    pausedPages.delete(pageId);
    driver?.retireInitializationPage?.(pageId);
    activeBindings?.retirePage(pageId);
    const page = pages.get(pageId);

    // A native callback supplies the cached fact; its later owner confirmation is idempotent.
    if (page !== undefined || cached !== undefined)
      publish(store, {
        target:
          cached === undefined
            ? {
                generation: page?.identity.generation ?? owner.state.generation,
                pageId,
                frameId: null,
                document: null,
              }
            : cachedTarget(cached, owner.state.generation),
        correlation: null,
        event: { _tag: "PageClosed" },
      });
    if (page !== undefined) retirePageTimeline(page, "closed");

    if (page !== undefined && page.phase !== "closing") owner.revokePage(pageId);
    owner.retirePage(pageId);
    if (page !== undefined) {
      page.phase = "closed";
      if (page.attempt !== undefined) Deferred.doneUnsafe(page.attempt, Effect.succeed(true));
      pages.delete(pageId);
    }
  };

  const pendingPageFaults = new Map<
    string,
    {
      readonly generation: number;
      readonly authority: typeof pages extends Map<string, infer A> ? A | undefined : never;
    }
  >();

  let pageFaultWake = Deferred.makeUnsafe<void>();

  const revokePage = (pageId: string, except?: AbortSignal) => {
    const page = pages.get(pageId);

    if (page !== undefined && page.phase !== "closed") page.phase = "closing";
    owner.revokePage(pageId, except);
    activeBindings?.fencePage(pageId);
    driver?.fenceInitializationPage?.(pageId);
    owner.invalidate("closed", { pageId });
  };

  const restorePageAuthority = (pageId: string) => {
    pausedPages.delete(pageId);
    owner.restorePageAdmission(pageId);
    driver?.restoreInitializationPage?.(pageId);
    activeBindings?.resumePage(pageId);
  };

  const fenceBindings = () => {
    activeBindings?.close();
    driver?.fenceInitialization?.();
  };

  const disposeBindings = Effect.gen(function* () {
    const connection = activeBindings;

    activeBindings = undefined;
    const callbacks = yield* Effect.exit(connection?.dispose ?? Effect.void);

    const registrations = yield* Effect.tryPromise({
      try: () => driver?.disposeInitialization?.() ?? Promise.resolve(),
      catch: () =>
        BrowserError.make({
          operation: "close",
          reason: Reasons.Provider.make({}),
          outcome: "unknown",
        }),
    }).pipe(Effect.exit);

    if (Exit.isFailure(callbacks)) return yield* Effect.failCause(callbacks.cause);
    if (Exit.isFailure(registrations)) return yield* Effect.failCause(registrations.cause);
  });

  const capture: CaptureParent = {
    owner,
    newCaptureId: uuid,
    selectedPage: () => {
      const page = pages.get(getDriver().selected().pageId);

      if (page === undefined || page.phase !== "open")
        throw BrowserError.make({
          operation: "capture-start",
          reason: Reasons.Stale.make({}),
          outcome: "undispatched",
        });

      return page.info;
    },
    target: () => {
      if (driver === undefined)
        throw BrowserError.make({
          operation: "target",
          reason: Reasons.Closed.make({}),
          outcome: "undispatched",
        });

      return Target.make({ generation: owner.state.generation, ...driver.selected() });
    },
    resolve: (ticket, requested) => {
      const admittedDomain = domain;

      return native("capture-start", ticket, async () => {
        if (driver === undefined)
          throw BrowserError.make({
            operation: "capture",
            reason: Reasons.Closed.make({}),
            outcome: "undispatched",
          });
        const binding = await driver.capture(requested);

        ticket.check();
        const generation = ticket.generation;

        const target = Target.make({
          generation,
          pageId: binding.pageId,
          frameId: binding.frameId,
        });

        const authority =
          pages.get(binding.pageId) ??
          registerPage(
            requested ?? {
              pageId: binding.pageId,
              targetId: binding.targetId,
              url: "",
              title: "",
              selected: true,
            },
            target,
            generation,
          ).record;

        const publishMetadata = captureMetadata(admittedDomain.store, originNanos);
        let releaseCapture: (() => void) | undefined;

        return {
          key: binding.targetId,
          target,
          metadata: (event: CaptureMetadata) => {
            if (
              releaseCapture === undefined &&
              event._tag === "Capture" &&
              event.phase === "Reserved"
            ) {
              const releaseDomain = admittedDomain.retirement.retain();
              const releasePage = authority.retirement.retain();

              releaseCapture = () => {
                releasePage();
                releaseDomain();
              };
            }
            publishMetadata(event);
            if (event._tag === "Capture" && event.phase === "Stopped") releaseCapture?.();
          },
          status: () => ({
            phase:
              authority.phase === "closed"
                ? "closed"
                : generation !== owner.state.generation
                  ? "stale"
                  : authority.phase,
            containment: authority.containment,
          }),
          source: binding.source,
        };
      });
    },
    captureLeases: new Map(),
    captureReservedBytes: 0,
  };

  owner.onInvalidate((reason, scope, origin) => {
    driver?.invalidateObservation(scope, reason === "observation" ? origin : undefined);
    if (scope !== "all" && scope !== "none" && (reason === "paused" || reason === "closed")) {
      const record = pages.get(scope.pageId);

      if (record !== undefined && record.phase !== "open")
        publish(record.store, {
          target: { ...record.identity, document: null },
          correlation: null,
          event: { _tag: "Lifecycle", phase: record.phase },
        });
    }
    if (reason === "uncertain" && scope === "all")
      for (const page of pages.values())
        page.containment = { _tag: "SessionFenced", generation: owner.state.generation };
    if (scope === "all" && ["paused", "disconnected", "uncertain", "closed"].includes(reason)) {
      if (reason === "paused") for (const page of pages.values()) retirePageTimeline(page, "stale");
      else
        endTimeline(
          owner.reason === "expired"
            ? "expired"
            : owner.reason === "detached"
              ? "detached"
              : owner.state.phase === "faulted"
                ? "faulted"
                : reason === "uncertain"
                  ? "uncertain"
                  : reason === "disconnected"
                    ? "disconnected"
                    : "closed",
        );
      pages.clear();
    }
    if (["disconnected", "uncertain", "closed"].includes(reason) && scope === "all") {
      pausedPages.clear();
      fenceBindings();
    }
    if (["paused", "disconnected", "uncertain", "closed"].includes(reason)) {
      if (reason !== "paused" && scope !== "all" && scope !== "none")
        activeBindings?.fencePage(scope.pageId);
      for (const lease of capture.captureLeases.values())
        if (scope === "all" || (scope !== "none" && lease.pageId === scope.pageId))
          lease.invalidate(reason);
    }
  });

  /**
   * The local half of cleanup. Each step is an independent fact for the canonical
   * coordinator, which owns the release request and the terminal status observation.
   */
  let releaseTimelineCleanup: (() => void) | undefined;

  const local: ConnectionCleanup = {
    fence: Effect.sync(() => {
      releaseTimelineCleanup ??= domain.retirement.retain();
      owner.fence("closing", "closed");
      handoffToken = undefined;
      activeConnection = undefined;
      Deferred.doneUnsafe(ended, Effect.void);
    }),
    capture: Effect.suspend(() =>
      Effect.forEach([...capture.captureLeases.values()], (lease) => lease.stop, {
        discard: true,
      }),
    ),
    initialization: disposeBindings,
    disconnect: Effect.suspend(() => {
      const acquired = driver;

      driver = undefined;
      if (acquired === undefined)
        return Effect.succeed<ConnectionState>(connectPending ? "pending" : "not-connected");

      return Effect.tryPromise({
        try: () => acquired.disconnect(),
        catch: () =>
          BrowserError.make({
            operation: "disconnect",
            reason: Reasons.Provider.make({}),
            outcome: "unknown",
          }),
      }).pipe(Effect.as<ConnectionState>("closed"));
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          owner.transition("closed");
          releaseTimelineCleanup?.();
        }),
      ),
    ),
  };

  // Registered before the source so natural scope closure observes its completed release first.
  let retireControl: Effect.Effect<void> = Effect.void;

  yield* Effect.addFinalizer(() => Effect.suspend(() => retireControl));

  const acquired = yield* options.remote(local, owner.lifetimeDeadline);

  retireControl = cleanupStep(
    Effect.suspend(() => acquired.controlRetired ?? Effect.succeed(false)),
    2000,
  ).pipe(
    Effect.tap((result) =>
      result._tag === "Success" && result.value ? Effect.sync(owner.retireControl) : Effect.void,
    ),
    Effect.asVoid,
    Effect.ignoreCause,
    Effect.provideService(Clock.Clock, clock),
  );

  const ref: L["reference"] = acquired.reference;
  // Effect.tap preserves the exact supplying lifetime's success; the generic constraint alone
  // would infer unknown here. No receipt value is decoded, constructed or coerced by this owner.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- restates L's own release type
  const release = acquired.release as Effect.Effect<Effect.Success<L["release"]>>;
  const cleanupResult: L["cleanupResult"] = acquired.cleanupResult;

  const closeScope = acquired.release.pipe(
    Effect.tap(() => retireControl),
    Effect.ensuring(Deferred.succeed(ended, undefined)),
    Effect.asVoid,
    Effect.provideService(Clock.Clock, clock),
  );

  const connectionEvents = (connectionLease: object, generation: number): DriverEvents => {
    const connectionDomain = domain;

    return {
      pageLifecycle: (event) => {
        if (activeConnection !== connectionLease) return;

        const target =
          event._tag === "Navigated"
            ? {
                generation: owner.state.generation,
                pageId: event.page.pageId,
                frameId: event.frameId,
                document: event.documentEpoch,
              }
            : cachedTarget(event.page, owner.state.generation);

        publish(connectionDomain.store, {
          target,
          correlation: null,
          event:
            event._tag === "Opened"
              ? { _tag: "PageOpened" }
              : event._tag === "Navigated"
                ? {
                    _tag: "Navigated",
                    sameDocument: event.sameDocument,
                    url: event.url !== null && event.url.length <= 8192 ? event.url : null,
                    urlQualification:
                      event.url !== null && event.url.length > 8192
                        ? "Omitted"
                        : event.urlQualification,
                  }
                : event._tag === "Display"
                  ? {
                      _tag: "DisplayChanged",
                      selected: event.page.selected,
                      displayState:
                        event.page.displayState === "suspended" ? "held" : event.page.displayState,
                    }
                  : { _tag: "MetadataChanged" },
        });
      },
      pageFault: (pageId) => {
        if (activeConnection !== connectionLease) return;
        if (pendingPageFaults.has(pageId)) return;
        if (owner.state.phase !== "open" || pendingPageFaults.size >= options.driver.maxPages) {
          owner.terminate("native-failure", "unknown", owner.state.generation);

          return;
        }
        pendingPageFaults.set(pageId, {
          generation: owner.state.generation,
          authority: pages.get(pageId),
        });
        revokePage(pageId);
        Deferred.doneUnsafe(pageFaultWake, Effect.void);
      },
      frameClosed: (pageId, frameId) => {
        if (activeConnection !== connectionLease) return;
        const page = pages.get(pageId);
        const frame = page?.frames.get(frameId);

        if (frame !== undefined) frame.detached = true;
        page?.frames.delete(frameId);
      },
      pageClosed: (pageId, cached) => {
        if (activeConnection === connectionLease)
          pageClosed(pageId, cached, connectionDomain.store);
      },
      retired: () => owner.retireWait(connectionLease),
      invalidate: (reason, scope) => {
        if (activeConnection === connectionLease) owner.invalidate(reason, scope);
      },
      disconnected: () => {
        owner.retireWait(connectionLease);
        if (activeConnection !== connectionLease) return;
        if (
          owner.state.phase !== "closing" &&
          owner.state.phase !== "closed" &&
          owner.state.phase !== "detached"
        ) {
          owner.terminate("disconnected", "unknown", generation);
        }
      },
      pause: (reason = "dialog", pageId) => {
        if (activeConnection !== connectionLease) return;
        const trigger = reason === "popup" ? "popup-policy" : "dialog-policy";

        owner.record(trigger, "confirmed", generation);
        if (pageId !== undefined && owner.state.phase === "open") {
          if (!pausedPages.has(pageId) && pausedPages.size >= options.driver.maxPages) {
            owner.terminate(trigger, "unknown", generation);

            return;
          }
          pausedPages.add(pageId);
          const page = pages.get(pageId);

          if (page !== undefined && page.phase === "open") page.phase = "paused";
          activeBindings?.fencePage(pageId);
          driver?.fenceInitializationPage?.(pageId);
          owner.revokePage(pageId);
          owner.invalidate("paused", { pageId });

          return;
        }
        if (owner.state.phase === "open") owner.fence("paused", "paused", trigger);
        // An unsolicited popup/dialog during setup cannot be silently admitted by
        // the later connect commit. No usable handle has been exposed: fail closed.
        else if (owner.state.phase === "acquiring") owner.terminate(trigger, "known", generation);
      },
      fault: (event) => {
        if (activeConnection !== connectionLease) return;
        if (event.source === "policy") {
          owner.policy(event, generation);

          return;
        }
        if (owner.state.phase === "closing" || owner.state.phase === "closed") return;
        owner.terminate(
          event.source === "binding"
            ? "callback-failure"
            : event.disposition === "not-dispatched"
              ? "cleanup-capacity"
              : event.reason === "registration"
                ? "registration-failure"
                : event.reason === "connection"
                  ? "disconnected"
                  : "native-failure",
          event.disposition,
          generation,
        );
      },
    };
  };

  const connectNative = (url: Redacted.Redacted<unknown>, nativeOptions: DriverOptions) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        // Drawn before this attempt claims the connection, so a failed draw leaves nothing to undo.
        const identity: ConnectionIdentity = { namespace: yield* uuid, bindings: yield* uuid };

        if (hasConnectedStore) {
          endTimeline("detached");
          domain = makeDomain(yield* uuid);
        }
        hasConnectedStore = true;
        publish(domain.store, {
          target: null,
          correlation: null,
          event: { _tag: "Lifecycle", phase: "acquiring" },
        });
        const connectionLease = {};

        activeConnection = connectionLease;
        owner.setConnection(connectionLease);
        connectPending = true;
        const events = connectionEvents(connectionLease, owner.state.generation);

        const bindings =
          options.connectBindings === undefined
            ? undefined
            : yield* options
                .connectBindings(
                  events.fault,
                  () =>
                    activeConnection === connectionLease &&
                    (owner.state.phase === "acquiring" || owner.state.phase === "open"),
                  () =>
                    activeConnection === connectionLease &&
                    ["acquiring", "open", "paused"].includes(owner.state.phase),
                )
                .pipe(Scope.provide(bindingLifetime));

        activeBindings = bindings;

        const retired = () =>
          activeConnection !== connectionLease ||
          ["closing", "closed", "uncertain", "faulted"].includes(owner.state.phase);

        if (retired()) {
          bindings?.close();
          yield* bindings?.dispose ?? Effect.void;

          return yield* BrowserError.make({
            operation: "connect",
            reason: Reasons.Closed.make({}),
            outcome: "undispatched",
          });
        }

        const acquired = yield* restore(
          engine.connect({
            connection: Redacted.value(url),
            identity,
            options: {
              ...nativeOptions,
              ...(bindings === undefined
                ? {}
                : {
                    bindings: bindings.bindings,
                    onBindingFault: bindings.reportFailure,
                  }),
            },
            events,
            onAbandoned: () => bindings?.close(),
            onSettled: () => {
              if (activeConnection === connectionLease) connectPending = false;
            },
          }),
        );

        driver = acquired;
        if (
          activeConnection !== connectionLease ||
          owner.state.phase === "closed" ||
          owner.state.phase === "closing" ||
          owner.state.phase === "uncertain" ||
          owner.state.phase === "faulted"
        ) {
          yield* Effect.tryPromise({
            try: () => acquired.disconnect(),
            catch: () =>
              BrowserError.make({
                operation: "connect",
                reason: Reasons.Provider.make({}),
                outcome: "unknown",
              }),
          }).pipe(Effect.ignore);
          driver = undefined;

          return yield* BrowserError.make({
            operation: "connect",
            reason: Reasons.Closed.make({}),
            outcome: "unknown",
          });
        }

        return acquired;
      }),
    );

  const getDriver = () => {
    if (driver === undefined)
      throw BrowserError.make({
        operation: "target",
        reason: Reasons.Closed.make({}),
        outcome: "undispatched",
      });

    return driver;
  };

  /**
   * Work that depends on an initialized document waits for the current document's readiness.
   * Navigation, selection and page management deliberately do not: initialization must never
   * deadlock the navigation that produces the document it is waiting for.
   */
  const dependent = [
    "read-text",
    "checkpoint",
    "control-facts",
    "revalidate",
    "click",
    "fill",
    "fill-form",
    "scroll",
    "pointer-move",
    "hover",
    "wheel",
    "press",
    "type",
    "screenshot",
    "observe",
    "wait",
    "click-and-wait",
    "download-action",
    "select-files",
    "file-chooser",
  ];

  const requireReady = async (
    operation: BrowserOperation,
    ticket: Ticket,
    target?: DriverTarget,
  ) => {
    if (!dependent.includes(operation)) return;
    const state = await getDriver().documentReadiness(ticket, target);

    if (state._tag === "Ready" || state._tag === "NotApplicable") return;
    throw BrowserError.make({
      operation,
      reason:
        state._tag === "RequiresNavigation" || state.reason === "stale"
          ? Reasons.Stale.make({})
          : state.reason === "timeout"
            ? Reasons.Timeout.make({})
            : Reasons.Failed.make({}),
      outcome: "undispatched",
    });
  };

  /**
   * `dependent` is false for lifecycle observations, which report what is actually on the
   * reattached page. Readiness governs work that depends on initialization, not the reading
   * that tells a caller whether this document was initialized at all.
   */
  const observeInside = (
    ticket: Ticket,
    maximumBytes = Math.min(options.maxReturnedBytes, 16384),
    controls = 32,
    dependent = true,
    scope: "document" | "viewport" = "document",
    match?: string,
    target?: DriverTarget,
  ) =>
    Effect.suspend(() => {
      const resolved = target ?? getDriver().selected();
      const revision = owner.revision(resolved.pageId);

      return native("observe", ticket, async () => {
        await getDriver().pageControl?.checkTarget(resolved, ticket);
        if (dependent) await requireReady("observe", ticket, resolved);

        return getDriver().observe(scope, maximumBytes, controls, ticket, match, resolved);
      }).pipe(
        Effect.flatMap((raw) =>
          Effect.gen(function* () {
            if (owner.revision(resolved.pageId) !== revision)
              return yield* BrowserError.make({
                operation: "observe",
                reason: Reasons.Stale.make({}),
                outcome: "undispatched",
              });

            const result = yield* Effect.try({
              try: () =>
                Observation.make({
                  ...raw,
                  target: Target.make({ generation: ticket.generation, ...resolved }),
                  revision,
                }),
              catch: (error) =>
                publicError(error, "observe", {
                  reason: Reasons.Malformed.make({}),
                  outcome: "undispatched",
                }),
            });

            const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Observation))(
              result,
            ).pipe(
              Effect.mapError(() =>
                BrowserError.make({
                  operation: "observe",
                  reason: Reasons.Malformed.make({}),
                  outcome: "undispatched",
                }),
              ),
            );

            const bytes = new TextEncoder().encode(encoded).length;

            if (bytes > options.maxReturnedBytes) {
              return yield* BrowserError.make({
                operation: "observe",
                reason: Reasons.Limit.make({
                  dimension: "returned-bytes",
                  maximum: options.maxReturnedBytes,
                  observed: bytes,
                }),
                outcome: "undispatched",
              });
            }

            return result;
          }),
        ),
      );
    });

  /** A requested text bound may narrow the policy's bound, never widen it. */
  const textBudget = (
    operation: BrowserOperation,
    requested: number | undefined,
  ): Effect.Effect<number, BrowserError> => {
    const bytes = requested ?? Math.min(options.maxReturnedBytes, 16384);

    return bytes > options.maxReturnedBytes
      ? Effect.fail(
          BrowserError.make({
            operation,
            reason: Reasons.Configuration.make({ path: "maxTextBytes" }),
            outcome: "undispatched",
          }),
        )
      : Effect.succeed(bytes);
  };

  // Reading a target is an ownership operation too. A native mutation that times out
  // after dispatch fences the owner as uncertain; retaining the last native target
  // must not manufacture a fresh usable handle in that state.
  const readSelected = (operationOptions?: ExecutionOptions) =>
    Effect.try({
      try: capture.target,
      catch: (cause) =>
        publicError(cause, "target", {
          reason: Reasons.Closed.make({}),
          outcome: "undispatched",
        }),
    }).pipe(
      Effect.flatMap((selected) =>
        owner.guard(
          "target",
          (ticket) =>
            pages.has(selected.pageId)
              ? Effect.succeed(selected)
              : native("target", ticket, async () => {
                  const current = getDriver();

                  const info = (await current.listPages(ticket)).find(
                    (info) => info.pageId === selected.pageId,
                  );

                  if (info === undefined)
                    throw BrowserError.make({
                      operation: "target",
                      reason: Reasons.Stale.make({}),
                      outcome: "undispatched",
                    });
                  const target = await current.resolvePage(info, ticket);

                  ticket.check();
                  registerPage(info, target, ticket.generation);

                  return selected;
                }),
          {
            ...operationOptions,
            charge: false,
            targetScope: () => ({ pageId: selected.pageId }),
            preflight: checkTarget(selected, selected.generation),
          },
        ),
      ),
    );

  /**
   * While a navigation is in flight on the selected page, nothing else may change that page.
   * Reads, checkpoints, holds and every other page proceed.
   */
  const unreserved = (operation: BrowserOperation, target?: DriverTarget) =>
    Effect.suspend(() => {
      let pageId = target?.pageId;

      if (pageId === undefined)
        try {
          pageId = driver?.selected().pageId;
        } catch {
          // No selected target: the operation itself reports that, with its own reason.
        }

      return pageId !== undefined && (owner.reserved(pageId) || owner.waitPending(pageId))
        ? Effect.fail(
            BrowserError.make({
              operation,
              reason: Reasons.Busy.make({}),
              outcome: "undispatched",
            }),
          )
        : Effect.void;
    });

  /** Closing the exact affected page contains unknown input without retiring healthy peers. */
  const containment = (pageId: string, authority = pages.get(pageId)) => {
    const current = driver;

    if (current === undefined) return undefined;

    return {
      pageId,
      close: Effect.suspend(() => {
        const page = authority;
        const generation = page?.identity.generation ?? owner.state.generation;

        const confirmed = () => {
          if (page !== undefined && page.containment._tag === "NotRequired")
            page.containment = { _tag: "PageClosed", pageId, generation };

          return true;
        };

        if (page?.phase === "closed") return Effect.sync(confirmed);
        if (page?.attempt !== undefined)
          return Deferred.await(page.attempt).pipe(
            Effect.timeoutOrElse({ duration: 3000, orElse: () => Effect.succeed(false) }),
            Effect.tap((closed) =>
              Effect.sync(() => {
                if (closed) confirmed();
                else page.containment = { _tag: "SessionFenced", generation };
              }),
            ),
          );
        const attempt = Deferred.makeUnsafe<boolean>();

        if (page !== undefined) page.attempt = attempt;
        revokePage(pageId);

        return Effect.promise(async () => {
          try {
            await current.containPage(pageId);
            confirmed();
            pageClosed(pageId);

            return true;
          } catch {
            return false;
          }
        }).pipe(
          Effect.timeoutOrElse({ duration: 3000, orElse: () => Effect.succeed(false) }),
          Effect.tap((closed) =>
            Effect.sync(() => {
              if (!closed && page !== undefined)
                page.containment = { _tag: "SessionFenced", generation };
            }),
          ),
          Effect.tap((closed) => Deferred.succeed(attempt, closed)),
        );
      }),
    };
  };

  const waitFree = (operation: BrowserOperation, pageId?: string) =>
    Effect.suspend(() =>
      owner.waitPending(pageId)
        ? Effect.fail(
            BrowserError.make({
              operation,
              reason: Reasons.Busy.make({}),
              outcome: "undispatched",
            }),
          )
        : Effect.void,
    );

  const checkTarget = (target?: DriverTarget, generation?: number) =>
    Effect.suspend(() =>
      (generation !== undefined && generation !== owner.state.generation) ||
      (target !== undefined && pages.get(target.pageId)?.phase === "closing")
        ? Effect.fail(
            BrowserError.make({
              operation: "target",
              reason: Reasons.Stale.make({}),
              outcome: "undispatched",
            }),
          )
        : Effect.void,
    );

  const nativeOperation = <A>(
    operation: BrowserOperation,
    action: (driver: Driver, ticket: Ticket) => Promise<A>,
    options: {
      readonly mutation?: boolean;
      readonly charge?: boolean | "host-read";
      /** Opening or closing a tab is independent of the selected page's document. */
      readonly anyPage?: boolean;
      readonly admission?: OperationOptions["admission"];
      readonly recovery?: boolean;
      readonly mutationScope?: () => ObservationScope;
      readonly targetScope?: () => ObservationScope;
      readonly preflight?: Effect.Effect<void, BrowserError>;
      readonly target?: DriverTarget;
      readonly generation?: number;
      readonly timeoutMillis?: number;
      readonly operationDeadline?: number;
      readonly queueDeadline?: number;
      readonly evidence?: ExecutionEvidence;
      readonly beforeNative?: (driver: Driver, ticket: Ticket) => Promise<void>;
      readonly validate?: Effect.Effect<void, BrowserError>;
      readonly containPageId?: string;
    } = {},
  ) =>
    (options.validate ?? checkTarget(options.target, options.generation)).pipe(
      Effect.andThen(
        owner.guard(
          operation,
          (ticket) =>
            native(operation, ticket, async () => {
              // A held page is refused, never woken: none of these may run against one.
              if (
                [
                  "resolve",
                  "run",
                  "settled",
                  "resize",
                  "wait",
                  "click-and-wait",
                  "download-action",
                  "select-files",
                  "select-option",
                  "fill-form",
                  "file-chooser",
                  "checkpoint",
                  "control-facts",
                  "revalidate",
                ].includes(operation)
              )
                await getDriver().pageControl?.checkTarget(options.target, ticket);
              await requireReady(operation, ticket, options.target);

              await options.beforeNative?.(getDriver(), ticket);
              ticket.check();

              return action(getDriver(), ticket);
            }),
          {
            ...options,
            targetScope:
              options.targetScope ??
              (() =>
                options.target !== undefined
                  ? { pageId: options.target.pageId }
                  : options.containPageId !== undefined
                    ? { pageId: options.containPageId }
                    : "none"),
            mutationScope:
              options.mutationScope ??
              (() => {
                if (options.containPageId !== undefined) return { pageId: options.containPageId };
                if (options.target !== undefined) return { pageId: options.target.pageId };

                return options.anyPage === true ||
                  [
                    "list-pages",
                    "list-frames",
                    "describe-page",
                    "select-page",
                    "select-frame",
                  ].includes(operation)
                  ? "none"
                  : { pageId: getDriver().selected().pageId };
              }),
            contain: () =>
              options.anyPage === true && options.containPageId === undefined
                ? undefined
                : containment(
                    options.containPageId ??
                      options.target?.pageId ??
                      getDriver().selected().pageId,
                  ),
            preflight: (options.mutation === true && options.anyPage !== true
              ? unreserved(operation, options.target)
              : Effect.void
            ).pipe(
              Effect.andThen(options.preflight ?? Effect.void),
              Effect.andThen(checkTarget(options.target, options.generation)),
            ),
          },
        ),
      ),
    );

  const wait = (
    start: (
      driver: Driver,
      ticket: WaitTicket,
      target: DriverTarget,
      operationTicket: Ticket,
    ) => Promise<void>,
    timeoutMillis?: number,
    browserTarget?: DriverTarget,
    generation?: number,
    operationOptions?: ExecutionOptions,
    operation: "wait" | "settled" = "wait",
  ): Effect.Effect<void, BrowserError> =>
    Effect.suspend(() => {
      let owned: OwnedWait | undefined;
      const target = browserTarget ?? getDriver().selected();

      return owner
        .guard(
          operation,
          (ticket) =>
            native(operation, ticket, async () => {
              const driver = getDriver();
              const connection = activeConnection;

              if (connection === undefined)
                throw BrowserError.make({
                  operation,
                  reason: Reasons.Closed.make({}),
                  outcome: "undispatched",
                });
              const admitted = owner.beginWait(ticket, target, connection, operation);

              owned = admitted;
              let started = false;

              try {
                await driver.pageControl?.checkTarget(target, ticket);
                ticket.check();
                await requireReady(operation, ticket, target);
                ticket.check();
                await operationOptions?.beforeNative?.(driver, ticket);
                ticket.check();
                admitted.start(() => start(driver, admitted.ticket, target, ticket));
                started = true;

                return admitted;
              } finally {
                // Canceled readiness may still be native work: retire only when its raw task exits.
                if (!started) admitted.ticket.retire();
              }
            }),
          {
            ...operationOptions,
            ...(timeoutMillis === undefined
              ? {}
              : {
                  timeoutMillis: Math.min(
                    timeoutMillis,
                    operationOptions?.timeoutMillis ?? timeoutMillis,
                  ),
                }),
            targetScope: () => ({ pageId: target.pageId }),
            preflight: Effect.suspend(() =>
              owner.waitAvailable(target.pageId)
                ? checkTarget(target, generation).pipe(
                    Effect.andThen(unreserved(operation, target)),
                  )
                : Effect.fail(
                    BrowserError.make({
                      operation,
                      reason: Reasons.Busy.make({}),
                      outcome: "undispatched",
                    }),
                  ),
            ),
          },
        )
        .pipe(
          Effect.flatMap((operation) => operation.completed),
          Effect.ensuring(Effect.sync(() => owned?.cancel())),
        );
    });

  /**
   * Direct operations capture selection at execution before admission. Retained operations
   * capture selection and generation; pinned operations capture their explicit page/frame.
   */
  const captureClickAt =
    (target: Target, ticket: Ticket): InputCapture =>
    async (dispatch, dispatched) => {
      const startedMonotonicNanos = clock.monotonicTimeNanosUnsafe();

      await dispatch();

      const receipt = {
        ...dispatched,
        target,
        kind: "click" as const,
        startedMonotonicNanos,
        completedMonotonicNanos: clock.monotonicTimeNanosUnsafe(),
      };

      ticket.recordInput?.(receipt);

      return receipt;
    };

  const makeOperations = (retained?: {
    readonly generation: number;
    readonly selection?: number;
    readonly target?: DriverTarget;
  }) => {
    const browserTarget = retained?.target;
    const authority = browserTarget === undefined ? undefined : pages.get(browserTarget.pageId);

    const frameAuthority =
      browserTarget === undefined ? undefined : authority?.frames.get(browserTarget.frameId);

    const check = () => {
      if (
        (retained !== undefined &&
          (owner.state.generation !== retained.generation ||
            (retained.selection !== undefined && owner.state.selection !== retained.selection))) ||
        (authority !== undefined && authority.phase !== "open") ||
        frameAuthority?.detached === true
      ) {
        return Effect.fail(
          BrowserError.make({
            operation: "handle",
            reason: Reasons.Stale.make({}),
            outcome: "undispatched",
          }),
        );
      }

      return Effect.void;
    };

    const run = <A>(
      operation: BrowserOperation,
      action: (driver: Driver, ticket: Ticket, target: DriverTarget) => Promise<A>,
      mutation = false,
      operationOptions?: ExecutionOptions,
    ) =>
      Effect.suspend(() => {
        return Effect.suspend(check).pipe(
          Effect.andThen(
            Effect.try({
              try: () => browserTarget ?? getDriver().selected(),
              catch: (cause) =>
                publicError(cause, operation, {
                  reason: Reasons.Closed.make({}),
                  outcome: "undispatched",
                }),
            }),
          ),
          Effect.flatMap((admittedTarget) =>
            owner.guard(
              operation,
              (ticket) =>
                native(operation, ticket, async () => {
                  await getDriver().pageControl?.checkTarget(admittedTarget, ticket);
                  await requireReady(operation, ticket, admittedTarget);

                  await operationOptions?.beforeNative?.(getDriver(), ticket);
                  ticket.check();

                  return action(getDriver(), ticket, admittedTarget);
                }),
              {
                ...operationOptions,
                mutation,
                targetScope: () => ({ pageId: admittedTarget.pageId }),
                mutationScope: () => ({ pageId: admittedTarget.pageId }),
                preflight: mutation
                  ? Effect.suspend(check).pipe(
                      Effect.andThen(unreserved(operation, admittedTarget)),
                    )
                  : Effect.suspend(check),
                contain: () =>
                  containment(admittedTarget.pageId, authority ?? pages.get(admittedTarget.pageId)),
              },
            ),
          ),
        );
      });

    const operationTarget = (target?: DriverTarget) =>
      target === undefined
        ? capture.target()
        : Target.make({ generation: retained?.generation ?? owner.state.generation, ...target });

    /**
     * Native input, stamped on the host monotonic clock that stamps captured frames, around
     * the native command alone: admission and readiness are over before the clock is read.
     */
    const input = (
      operation: "pointer-move" | "hover" | "wheel" | "press" | "type",
      action: (driver: Driver, ticket: Ticket, target: DriverTarget) => Promise<NativeInput>,
      operationOptions?: ExecutionOptions,
      inputTarget?: (target: DriverTarget) => DriverTarget,
      keys?: {
        readonly count: number;
        readonly countUnit: "unicode-codepoints" | "logical-strokes";
      },
    ) =>
      run(
        operation,
        async (driver, ticket, browserTarget) => {
          // What the input is sent to, read first: input may replace the document it reaches.
          const target = operationTarget(inputTarget?.(browserTarget) ?? browserTarget);
          const startedMonotonicNanos = clock.monotonicTimeNanosUnsafe();
          const dispatched = await action(driver, ticket, browserTarget);

          const receipt = {
            ...dispatched,
            kind: operation,
            target,
            startedMonotonicNanos,
            completedMonotonicNanos: clock.monotonicTimeNanosUnsafe(),
          };

          ticket.recordInput?.(receipt, keys);

          return receipt;
        },
        true,
        operationOptions,
      );

    /**
     * Dispatches under a short permit and leaves the browser loading outside it. The reservation
     * is taken under that same permit, so no other mutation can reach the page in between, and
     * it is released only on a known outcome: an unsettled operation whose scope closes, or a
     * navigation that fails after dispatch, fences the owner exactly as an interrupted mutation
     * always has. Interrupting a waiter on `completed` stops nothing; `stop` is the one way to.
     */
    const startNavigation = Effect.fnUntraced(
      function* (
        url: string,
        timeoutMillis: number = limits.actionTimeoutMillis,
        operationOptions?: ExecutionOptions,
      ) {
        const requestedTimeout = Math.min(
          timeoutMillis,
          operationOptions?.timeoutMillis ?? timeoutMillis,
        );

        const loadingDeadline = Math.min(
          Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000 + requestedTimeout,
          owner.lifetimeDeadline,
          operationOptions?.operationDeadline ?? Number.POSITIVE_INFINITY,
        );

        let active = true;
        let dismissals = 0;
        let beforeUnload = false;
        let dismissalUnknown = false;
        let rejected: BrowserError | undefined;
        let reconsider = () => {};

        const control: NavigationControl = {
          identity: {},
          beforeUnload: () => {
            if (!active) return { dismissed: () => {} };
            beforeUnload = true;
            dismissals++;
            let settled = false;

            return {
              dismissed: (confirmed) => {
                if (settled || !active) return;
                settled = true;
                dismissals--;
                if (!confirmed) dismissalUnknown = true;
                reconsider();
              },
            };
          },
        };

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            active = false;
          }),
        );

        const begun = yield* run(
          "navigate",
          async (driver, ticket, browserTarget) => {
            const target = operationTarget(browserTarget);

            const loadingStarted = Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000;
            const remainingLifetime = owner.lifetimeDeadline - loadingStarted;

            if (remainingLifetime <= 0)
              throw BrowserError.make({
                operation: "navigate",
                reason: Reasons.Expired.make({}),
                outcome: "undispatched",
              });

            const loadingTimeout = loadingDeadline - loadingStarted;

            if (loadingTimeout <= 0)
              throw BrowserError.make({
                operation: "navigate",
                reason: Reasons.Timeout.make({}),
                outcome: "undispatched",
              });

            const navigation = await driver.beginNavigation(
              url,
              loadingTimeout,
              ticket,
              browserTarget,
              control,
            );

            // A continuation that outlived its permit takes no reservation: whatever gave that
            // permit up has already decided this dispatch's outcome.
            ticket.check();

            const reservation = owner.reserve(navigation.pageId);

            ticket.acknowledge?.();

            return {
              target,
              navigation,
              reservation,
              authority: pages.get(navigation.pageId),
              recoveryDeadline: Math.min(
                loadingStarted + loadingTimeout + 3000,
                owner.lifetimeDeadline,
              ),
            };
          },
          true,
          { ...operationOptions, timeoutMillis: requestedTimeout },
        );

        const { navigation, reservation } = begun;

        const admission =
          begun.authority?.admission ??
          owner.pageAdmission(navigation.pageId, begun.target.generation);

        const outcome = yield* Deferred.make<string, BrowserError>();
        const timeoutRecovery = yield* Deferred.make<boolean>();
        const unknown = yield* Deferred.make<void>();
        let pendingDecision: Effect.Effect<string, BrowserError> | undefined;
        let stopDispatched = false;
        let timedOut = false;
        let deciding = false;

        const failed = (reason: BrowserError["reason"]) =>
          Effect.fail(BrowserError.make({ operation: "navigate", reason, outcome: "unknown" }));

        const settleUnknown = yield* Effect.cached(
          Effect.suspend(() => {
            const decision = pendingDecision;

            if (decision === undefined || Deferred.isDoneUnsafe(outcome)) return Effect.void;

            return owner
              .contain(containment(navigation.pageId, begun.authority), begun.target.generation)
              .pipe(
                Effect.tap((contained) =>
                  Effect.sync(() => {
                    reservation.settle(contained._tag === "PageClosed" ? "known" : "unknown");
                    Deferred.doneUnsafe(
                      outcome,
                      decision.pipe(
                        Effect.mapError((error) =>
                          BrowserError.make({
                            ...error,
                            outcome: "unknown",
                            containment: contained,
                          }),
                        ),
                      ),
                    );
                  }),
                ),
                Effect.asVoid,
              );
          }),
        ).pipe(Effect.map(Effect.uninterruptible));

        /**
         * A navigation has exactly one outcome, and whoever decides it first settles the
         * reservation. It is released before anyone waiting is told, so the operation a waiter
         * runs next is admitted rather than finding its own page still reserved.
         */
        const decide = (result: Effect.Effect<string, BrowserError>, known: boolean) => {
          if (deciding || Deferred.isDoneUnsafe(outcome)) return;
          deciding = true;
          active = false;
          if (known) {
            reservation.settle("known");
            Deferred.doneUnsafe(outcome, result);
            deciding = false;
          } else {
            pendingDecision = result;
            Deferred.doneUnsafe(unknown, Effect.void);
          }
          Deferred.doneUnsafe(timeoutRecovery, Effect.succeed(false));
        };

        reconsider = () => {
          if (!active || rejected === undefined || dismissals !== 0 || stopDispatched) return;
          if (beforeUnload) {
            // Both facts are required: this goto rejected and its exact dialog was dismissed.
            decide(
              dismissalUnknown ? Effect.fail(rejected) : failed(Reasons.Interrupted.make({})),
              !dismissalUnknown,
            );
          } else if (navigation.mainFrame === true && rejected.reason._tag === "Timeout") {
            timedOut = true;
            Deferred.doneUnsafe(timeoutRecovery, Effect.succeed(true));
          } else {
            decide(Effect.fail(rejected), false);
          }
        };

        navigation.settled.then(
          (url) => {
            if (!stopDispatched) decide(Effect.succeed(url), true);
          },
          (error: unknown) => {
            if (stopDispatched || Deferred.isDoneUnsafe(outcome)) return;

            rejected = publicError(error, "navigate", {
              reason: Reasons.Provider.make({}),
              outcome: "unknown",
            });
            reconsider();
          },
        );

        // A fence already cleared the reservation; this only releases anyone still waiting.
        const aborted = () =>
          decide(failed(timedOut ? Reasons.Timeout.make({}) : Reasons.Stale.make({})), true);

        reservation.signal.addEventListener("abort", aborted, {
          once: true,
        });
        // Left unsettled, nothing knows what the browser did with it.
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            decide(failed(timedOut ? Reasons.Timeout.make({}) : Reasons.Stale.make({})), false);
            reservation.signal.removeEventListener("abort", aborted);
          }).pipe(Effect.andThen(settleUnknown)),
        );
        yield* Deferred.await(unknown).pipe(Effect.andThen(settleUnknown), Effect.forkScoped);

        const stop = yield* makeNavigationStopCoordinator(
          () => Deferred.isDoneUnsafe(outcome),
          (onDispatch, retainSetup, deadline) =>
            owner.guard(
              "navigate-stop",
              (ticket) =>
                Effect.suspend(() =>
                  deadline !== undefined && admission.native.stopSetupPending !== undefined
                    ? Deferred.await(admission.native.stopSetupPending)
                    : Effect.void,
                ).pipe(
                  Effect.andThen(
                    native("navigate-stop", ticket, () =>
                      navigation.stop(
                        ticket,
                        () => !Deferred.isDoneUnsafe(outcome),
                        () => {
                          onDispatch();
                          stopDispatched = true;
                        },
                        () => {
                          if (admission.native.stopSetupPending !== undefined)
                            throw BrowserError.make({
                              operation: "navigate-stop",
                              reason: Reasons.Busy.make({}),
                              outcome: "undispatched",
                            });
                          const setup = Deferred.makeUnsafe<void>();

                          admission.native.stopSetupPending = setup;
                          const retired = retainSetup();

                          return () => {
                            if (admission.native.stopSetupPending === setup)
                              admission.native.stopSetupPending = undefined;
                            Deferred.doneUnsafe(setup, Effect.void);
                            retired();
                          };
                        },
                      ),
                    ),
                  ),
                  Effect.timeoutOrElse({
                    duration: Math.min(3000, ticket.remainingMillis()),
                    orElse: () =>
                      Effect.fail(
                        BrowserError.make({
                          operation: "navigate-stop",
                          reason: Reasons.Timeout.make({}),
                          outcome: ticket.dispatched ? "unknown" : "undispatched",
                        }),
                      ),
                  }),
                ),
              {
                mutation: true,
                recovery: true,
                targetScope: () => ({ pageId: navigation.pageId }),
                mutationScope: () => ({ pageId: navigation.pageId }),
                charge: false,
                preflight: checkTarget(
                  { pageId: navigation.pageId, frameId: begun.target.frameId },
                  begun.target.generation,
                ),
                contain: () => containment(navigation.pageId, begun.authority),
                ...(deadline === undefined ? {} : { waitUntil: deadline }),
              },
            ),
          () =>
            decide(
              failed(timedOut ? Reasons.Timeout.make({}) : Reasons.Interrupted.make({})),
              true,
            ),
        );

        // One operation-scoped supervisor, signalled only by the exact native timeout classifier.
        // Its absolute deadline bounds joined public stops, permit wait and late setup retirement too.
        yield* Deferred.await(timeoutRecovery).pipe(
          Effect.flatMap((recover) =>
            recover
              ? stop.recover(begun.recoveryDeadline).pipe(
                  Effect.onExit((exit) =>
                    Effect.sync(() => {
                      if (Exit.isFailure(exit)) decide(failed(Reasons.Timeout.make({})), false);
                    }),
                  ),
                )
              : Effect.void,
          ),
          Effect.ignoreCause,
          Effect.forkScoped,
        );

        return {
          target: begun.target,
          completed: Deferred.await(outcome),
          /**
           * The browser's acknowledgement is the known outcome. Playwright's own promise is not
           * waited for: an aborted parse fires no DOMContentLoaded, so it only ever times out.
           */
          stop: stop.stop,
        };
      },
      Effect.provideService(Clock.Clock, clock),
    );

    return {
      startNavigation,
      // The same machinery, scoped to the call: leaving it unsettled fences, as it always has.
      navigate: (url: string, timeoutMillis?: number, operationOptions?: ExecutionOptions) =>
        Effect.scoped(
          startNavigation(url, timeoutMillis, operationOptions).pipe(
            Effect.flatMap((operation) => operation.completed),
          ),
        ),
      readText: (selector?: string, operationOptions?: ExecutionOptions) =>
        run(
          "read-text",
          (driver, ticket, browserTarget) =>
            driver.readText(selector, options.maxReturnedBytes, ticket, browserTarget),
          false,
          operationOptions,
        ),
      click: (
        target: DeferredElementTarget,
        policy?: AdmissionPolicy,
        operationOptions?: ExecutionOptions,
      ) =>
        run(
          "click",
          (driver, ticket, browserTarget) =>
            driver.click(
              elementTarget(target),
              ticket,
              captureClickAt(
                operationTarget(effectiveTarget(elementTarget(target), browserTarget)),
                ticket,
              ),
              policy,
              effectiveTarget(elementTarget(target), browserTarget),
            ),
          true,
          operationOptions,
        ),
      fill: (
        target: DeferredElementTarget,
        value: string,
        policy?: AdmissionPolicy,
        operationOptions?: ExecutionOptions,
      ) =>
        run(
          "fill",
          (driver, ticket, browserTarget) =>
            driver.fill(
              elementTarget(target),
              value,
              ticket,
              policy,
              effectiveTarget(elementTarget(target), browserTarget),
            ),
          true,
          operationOptions,
        ),
      scroll: (x: number, y: number, operationOptions?: ExecutionOptions) =>
        run(
          "scroll",
          async (driver, ticket, browserTarget) => {
            const startedMonotonicNanos = clock.monotonicTimeNanosUnsafe();
            const result = await driver.scroll(x, y, ticket, browserTarget);

            ticket.recordScroll?.({
              target: browserTarget,
              x,
              y,
              startedMonotonicNanos,
              completedMonotonicNanos: clock.monotonicTimeNanosUnsafe(),
            });

            return result;
          },
          true,
          operationOptions,
        ),
      pointerMove: (to: NativePoint, operationOptions?: ExecutionOptions) =>
        input(
          "pointer-move",
          (driver, ticket, browserTarget) => driver.pointerMove(to, ticket, browserTarget),
          operationOptions,
        ),
      hover: (
        target: DeferredElementTarget,
        policy?: AdmissionPolicy,
        operationOptions?: ExecutionOptions,
      ) =>
        input(
          "hover",
          (driver, ticket, browserTarget) =>
            driver.hover(
              elementTarget(target),
              ticket,
              policy,
              effectiveTarget(elementTarget(target), browserTarget),
            ),
          operationOptions,
          (browserTarget) => effectiveTarget(elementTarget(target), browserTarget),
        ),
      wheel: (
        deltaX: number,
        deltaY: number,
        at?: NativePoint,
        operationOptions?: ExecutionOptions,
      ) =>
        input(
          "wheel",
          (driver, ticket, browserTarget) =>
            driver.wheel(deltaX, deltaY, at, ticket, browserTarget),
          operationOptions,
        ),
      press: (
        key: string,
        modifiers: ReadonlyArray<KeyModifier>,
        into?: DeferredElementTarget,
        policy?: AdmissionPolicy,
        operationOptions?: ExecutionOptions,
      ) =>
        input(
          "press",
          (driver, ticket, browserTarget) =>
            driver.press(
              key,
              modifiers,
              into === undefined ? undefined : elementTarget(into),
              ticket,
              policy,
              effectiveTarget(into === undefined ? undefined : elementTarget(into), browserTarget),
            ),
          operationOptions,
          (browserTarget) =>
            effectiveTarget(into === undefined ? undefined : elementTarget(into), browserTarget),
          { count: 1, countUnit: "logical-strokes" },
        ),
      type: (
        text: string,
        into?: DeferredElementTarget,
        policy?: AdmissionPolicy,
        operationOptions?: ExecutionOptions,
      ) =>
        input(
          "type",
          (driver, ticket, browserTarget) =>
            driver.type(
              text,
              into === undefined ? undefined : elementTarget(into),
              ticket,
              policy,
              effectiveTarget(into === undefined ? undefined : elementTarget(into), browserTarget),
            ),
          operationOptions,
          (browserTarget) =>
            effectiveTarget(into === undefined ? undefined : elementTarget(into), browserTarget),
          { count: codePointCount(text), countUnit: "unicode-codepoints" },
        ),
      screenshot: (full: boolean, operationOptions?: ExecutionOptions) =>
        run(
          "screenshot",
          (driver, ticket, browserTarget) =>
            driver.screenshot(full, options.maxReturnedBytes, ticket, browserTarget),
          false,
          operationOptions,
        ),
    };
  };

  /** The runtime supplies its remaining budget; endpoint sources apply their own wait limits. */
  const remainingMillis = () =>
    Math.max(
      1,
      Math.ceil(owner.lifetimeDeadline - Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000),
    );

  const connectionUrl = (operation: BrowserOperation) =>
    Effect.suspend(() => acquired.connection(remainingMillis())).pipe(
      Effect.mapError((error) =>
        BrowserError.make({ operation, reason: error.reason, outcome: error.outcome }),
      ),
    );

  const connected = yield* Effect.cached(
    owner
      .guard(
        "connect",
        (ticket) =>
          connectionUrl("connect").pipe(
            Effect.flatMap((url) => connectNative(url, options.driver)),
            Effect.andThen(
              native("connect", ticket, async () => {
                initialTarget = getDriver().selected();
                const targetId = await getDriver().selectedTargetId();

                ticket.check();
                initialInfo = {
                  pageId: initialTarget.pageId,
                  targetId,
                  url: "",
                  title: "",
                  selected: true,
                };
                initialAuthority = registerPage(initialInfo, initialTarget, ticket.generation);
              }),
            ),
            Effect.tap(() =>
              Effect.sync(() => {
                owner.transition("open");
              }),
            ),
          ),
        { phases: ["acquiring"], charge: false, verifyAfter: false },
      )
      .pipe(
        Effect.onError(() => closeScope),
        Effect.onInterrupt(() => closeScope),
      ),
  );

  const execution = () => {
    const port = getDriver().pageControl;

    if (port === undefined)
      throw BrowserError.make({
        operation: "page-control",
        reason: Reasons.Unsupported.make({}),
        outcome: "undispatched",
      });

    return port;
  };

  const pinned = (
    info: PageInfo,
    resolve: (driver: Driver, ticket: Ticket) => Promise<DriverTarget>,
    operationOptions?: ExecutionOptions,
  ) =>
    owner.guard(
      "target",
      (ticket) =>
        native("target", ticket, async () => {
          const value = await resolve(getDriver(), ticket);

          ticket.check();
          if (!pages.has(info.pageId)) {
            const main = await getDriver().resolvePage(info, ticket);

            ticket.check();
            registerPage(info, main, ticket.generation);
          }

          return {
            target: Target.make({ generation: ticket.generation, ...value }),
            operations: makeOperations({ generation: ticket.generation, target: value }),
          };
        }),
      { ...operationOptions, charge: false, targetScope: () => ({ pageId: info.pageId }) },
    );

  const retain = (operationOptions?: ExecutionOptions) =>
    Effect.suspend(() => {
      const selection = owner.state.selection;

      return readSelected(operationOptions).pipe(
        Effect.map((target) =>
          makeOperations({
            generation: target.generation,
            selection,
            target: { pageId: target.pageId, frameId: target.frameId },
          }),
        ),
      );
    });

  const makePageControls = (target?: DriverTarget, generation?: number) => {
    const authority = target === undefined ? undefined : pages.get(target.pageId);
    const frameAuthority = target === undefined ? undefined : authority?.frames.get(target.frameId);

    const validate = Effect.suspend(() =>
      (authority !== undefined && authority.phase !== "open") || frameAuthority?.detached === true
        ? Effect.fail(
            BrowserError.make({
              operation: "target",
              reason: Reasons.Stale.make({}),
              outcome: "undispatched",
            }),
          )
        : checkTarget(target, generation),
    );

    const bound = {
      validate,
      targetScope: () => (target === undefined ? ("none" as const) : { pageId: target.pageId }),
      ...(target === undefined ? {} : { target }),
      ...(generation === undefined ? {} : { generation }),
    };

    const targetData = (actual: DriverTarget | undefined = target) =>
      actual === undefined
        ? capture.target()
        : Target.make({ generation: generation ?? owner.state.generation, ...actual });

    const controls = {
      resolve: (descriptor: Descriptor, guard: ResolveGuard, operationOptions?: ExecutionOptions) =>
        nativeOperation(
          "resolve",
          (driver, ticket) =>
            driver.resolveDescriptor(descriptor, ticket, target ?? driver.selected(), guard),
          { ...bound, ...operationOptions, charge: "host-read" },
        ),
      settled: (
        settle: SettledOptions,
        operationOptions?: ExecutionOptions,
      ): Effect.Effect<SettledEvidence, BrowserError> =>
        Effect.suspend(() => {
          let evidence: SettledEvidence | undefined;

          return wait(
            async (driver, ticket, resolved, operationTicket) => {
              evidence = await driver.settled(settle, ticket, resolved);
              operationTicket.recordSettled?.(evidence, resolved);
            },
            settle.withinMillis,
            target,
            generation,
            operationOptions,
            "settled",
          ).pipe(
            Effect.flatMap(() =>
              evidence === undefined
                ? Effect.fail(
                    BrowserError.make({
                      operation: "settled",
                      reason: Reasons.Incomplete.make({}),
                      outcome: "undispatched",
                    }),
                  )
                : Effect.succeed(evidence),
            ),
          );
        }),
      pageControl: {
        state: (page: PageInfo, operationOptions?: ExecutionOptions) =>
          nativeOperation("page-state", (_driver, ticket) => execution().state(page, ticket), {
            ...bound,
            ...operationOptions,
            charge: false,
            containPageId: page.pageId,
            targetScope: () => ({ pageId: page.pageId }),
          }),
        suspend: (page: PageInfo, operationOptions?: ExecutionOptions) =>
          nativeOperation("page-suspend", (_driver, ticket) => execution().suspend(page, ticket), {
            ...bound,
            ...operationOptions,
            charge: false,
            containPageId: page.pageId,
            targetScope: () => ({ pageId: page.pageId }),
            preflight: waitFree("page-suspend", page.pageId),
          }),
        resume: (receipt: PageSuspension, operationOptions?: ExecutionOptions) =>
          nativeOperation("page-resume", (_driver, ticket) => execution().resume(receipt, ticket), {
            ...bound,
            ...operationOptions,
            charge: false,
            containPageId: receipt.pageId,
            targetScope: () => ({ pageId: receipt.pageId }),
            preflight: waitFree("page-resume", receipt.pageId),
          }),
      },
      operations: makeOperations(
        target === undefined
          ? undefined
          : { generation: generation ?? owner.state.generation, target },
      ),
      observe: (reading: Reading = { scope: "document" }, operationOptions?: ExecutionOptions) =>
        textBudget("observe", reading.maxTextBytes).pipe(
          Effect.flatMap((bytes) =>
            validate.pipe(
              Effect.andThen(
                owner.guard(
                  "observe",
                  (ticket) =>
                    observeInside(
                      ticket,
                      bytes,
                      reading.maxControls ?? 32,
                      true,
                      reading.scope,
                      reading.match,
                      target,
                    ),
                  {
                    ...operationOptions,
                    targetScope: bound.targetScope,
                    preflight: checkTarget(target, generation).pipe(
                      Effect.andThen(waitFree("observe", target?.pageId)),
                    ),
                  },
                ),
              ),
            ),
          ),
        ),
      /**
       * Passive: not a mutation, so the action observation and the selection are left exactly as
       * they were. A held page is refused rather than woken to be read.
       */
      checkpoint: (
        reading: Omit<Reading, "scope"> & { readonly picture: boolean },
        operationOptions?: ExecutionOptions,
      ) =>
        textBudget("checkpoint", reading.maxTextBytes).pipe(
          Effect.flatMap((bytes) =>
            nativeOperation(
              "checkpoint",
              async (driver, ticket) => {
                const capturedTarget = targetData();
                const revision = owner.revision(capturedTarget.pageId);
                const startedMonotonicNanos = clock.monotonicTimeNanosUnsafe();

                const sampled = await driver.checkpoint(
                  bytes,
                  reading.maxControls ?? 32,
                  reading.picture ? options.maxReturnedBytes : undefined,
                  ticket,
                  target,
                );

                return {
                  ...sampled,
                  target: capturedTarget,
                  revision,
                  startedMonotonicNanos,
                  completedMonotonicNanos: clock.monotonicTimeNanosUnsafe(),
                };
              },
              { ...bound, ...operationOptions, charge: "host-read" },
            ),
          ),
        ),
      controlFacts: (reference: ObservedElement, operationOptions?: ExecutionOptions) =>
        nativeOperation(
          "control-facts",
          (driver, ticket) => driver.controlFacts(reference, ticket, target),
          {
            ...bound,
            ...operationOptions,
            charge: "host-read",
          },
        ),
      selectOption: (
        reference: ObservedElement | ResolvedElement | (() => ObservedElement | ResolvedElement),
        options: NativeSelectOptions | (() => NativeSelectOptions),
        policy?: AdmissionPolicy,
        operationOptions?: ExecutionOptions,
      ) =>
        nativeOperation(
          "select-option",
          (driver, ticket) => {
            const ref = typeof reference === "function" ? reference() : reference;

            return driver.selectOption(
              ref,
              typeof options === "function" ? options() : options,
              ticket,
              policy,
              effectiveTarget(ref, target ?? driver.selected()),
            );
          },
          { ...bound, ...operationOptions, mutation: true },
        ),
      /**
       * Each step is its own admitted, charged mutation that leaves the observation usable for the
       * next one; anything else that changes the page still retires it. The form ends at the first
       * refusal, and whatever it dispatched retires the observation when it ends, however it ends.
       */
      fillForm: (
        request: FillFormRequest,
        policy: AdmissionPolicy | undefined,
        form: FormSettings,
        operationOptions?: ExecutionOptions,
        bindings?: FormBindings,
      ) =>
        Effect.suspend(() => {
          const requested = Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000;

          const formOptions = {
            ...operationOptions,
            operationDeadline: Math.min(
              requested +
                Math.min(
                  operationOptions?.timeoutMillis ?? limits.actionTimeoutMillis,
                  limits.actionTimeoutMillis,
                ),
              owner.lifetimeDeadline,
              operationOptions?.operationDeadline ?? Number.POSITIVE_INFINITY,
            ),
            ...(operationOptions?.admission?.queue === undefined
              ? {}
              : {
                  queueDeadline: Math.min(
                    requested + Duration.toMillis(operationOptions.admission.queue),
                    operationOptions.queueDeadline ?? Number.POSITIVE_INFINITY,
                  ),
                }),
          };

          // The page whose observation the steps kept usable, known once one of them dispatched.
          let pageId: string | undefined;

          const reference = (elementId: string): ObservedElement | ResolvedElement =>
            bindings?.reference(elementId) ?? {
              observationId: request.observationId,
              elementId,
            };

          const body = Effect.gen(function* () {
            const fields: Array<{
              elementId: string;
              status: "set" | "unchanged";
              input?: InputReceipt;
            }> = [];

            const states: Array<string | undefined> = [];
            let url = "";

            const finish = (submitted: boolean): FormOutcome => ({ fields, submitted, url });

            const stop = (
              stage: "field" | "verify" | "submit",
              error: BrowserError,
              elementId?: string,
            ): FormOutcome => ({
              ...finish(false),
              stopped: { stage, error, ...(elementId === undefined ? {} : { elementId }) },
            });

            for (const [fieldIndex, field] of request.fields.entries()) {
              formOptions.phase?.("Field", fieldIndex);

              const exit = yield* Effect.exit(
                nativeOperation(
                  "fill-form",
                  async (driver, ticket) => {
                    try {
                      return await driver.formStep(
                        reference(field.elementId),
                        bindings?.field(field) ?? field,
                        ticket,
                        policy,
                        form.settleMillis,
                        captureClickAt(
                          targetData(
                            effectiveTarget(
                              reference(field.elementId),
                              target ?? driver.selected(),
                            ),
                          ),
                          ticket,
                        ),
                        effectiveTarget(reference(field.elementId), target ?? driver.selected()),
                      );
                    } finally {
                      if (ticket.dispatched) pageId ??= target?.pageId ?? driver.selected().pageId;
                    }
                  },
                  {
                    ...bound,
                    ...formOptions,
                    mutation: true,
                    ...(bindings === undefined ? { mutationScope: () => "none" as const } : {}),
                  },
                ),
              );

              if (Exit.isFailure(exit)) {
                const error = Cause.findErrorOption(exit.cause);

                // Interruption and defects keep their own meaning. A form that has completed no
                // step fails exactly as its first step did.
                if (Option.isNone(error) || fields.length === 0)
                  return yield* Effect.failCause(exit.cause);

                return stop("field", error.value, field.elementId);
              }
              const step = exit.value;

              fields.push({
                elementId: field.elementId,
                status: step.status,
                ...(step.input === undefined ? {} : { input: step.input }),
              });
              states.push(step.state);
              url = step.url;
              if (!step.reached)
                return stop(
                  "field",
                  BrowserError.make({
                    operation: "fill-form",
                    reason: Reasons.Failed.make({}),
                    outcome: "rejected",
                  }),
                  field.elementId,
                );
            }

            if (form.verify) {
              formOptions.phase?.("Verification");

              // Not charged, like revalidation: it sends no input and reads nodes already issued.
              const exit = yield* Effect.exit(
                nativeOperation(
                  "fill-form",
                  (driver, ticket) =>
                    driver.formState(
                      request.fields.map((field) => reference(field.elementId)),
                      ticket,
                      target,
                    ),
                  { ...bound, ...formOptions, charge: false },
                ),
              );

              if (Exit.isFailure(exit)) {
                const error = Cause.findErrorOption(exit.cause);

                if (Option.isNone(error)) return yield* Effect.failCause(exit.cause);

                return stop("verify", error.value);
              }
              for (const [index, field] of request.fields.entries()) {
                const expected = states[index];

                if (expected === undefined || exit.value[index] !== expected)
                  return stop(
                    "verify",
                    BrowserError.make({
                      operation: "fill-form",
                      reason: Reasons.Stale.make({}),
                      outcome: "undispatched",
                    }),
                    field.elementId,
                  );
              }
            }

            if (request.submit === undefined) return finish(false);
            const submit = request.submit;

            formOptions.phase?.("Submit");

            const exit = yield* Effect.exit(
              nativeOperation(
                "fill-form",
                (driver, ticket) =>
                  driver.formSubmit(
                    reference(submit),
                    ticket,
                    captureClickAt(
                      targetData(effectiveTarget(reference(submit), target ?? driver.selected())),
                      ticket,
                    ),
                    policy,
                    effectiveTarget(reference(submit), target ?? driver.selected()),
                  ),
                { ...bound, ...formOptions, mutation: true },
              ),
            );

            if (Exit.isFailure(exit)) {
              const error = Cause.findErrorOption(exit.cause);

              if (Option.isNone(error)) return yield* Effect.failCause(exit.cause);

              return stop("submit", error.value, submit);
            }
            url = exit.value.url;

            return { ...finish(true), submitInput: exit.value.input };
          });

          // The steps kept the observation usable for each other only. A submit that dispatched
          // has already retired it, as every other mutation does.
          return body.pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (pageId !== undefined) owner.invalidate("observation", { pageId });
              }),
            ),
          );
        }),
      /** Not charged: it sends no input and reads one node the caller was already given. */
      revalidate: (reference: ObservedElement, operationOptions?: ExecutionOptions) =>
        nativeOperation(
          "revalidate",
          (driver, ticket) => driver.revalidate(reference, ticket, target),
          {
            ...bound,
            ...operationOptions,
            charge: false,
          },
        ),
      // Inspecting readiness is not an action: it charges nothing and mutates nothing.
      readiness: (operationOptions?: ExecutionOptions) =>
        validate.pipe(
          Effect.andThen(
            owner.guard(
              "ready",
              (ticket) =>
                native("ready", ticket, () => getDriver().documentReadiness(ticket, target)),
              {
                ...operationOptions,
                charge: false,
                targetScope: bound.targetScope,
                preflight: checkTarget(target, generation),
              },
            ),
          ),
        ),
      pages: (operationOptions?: ExecutionOptions) => listPages(operationOptions),
      listPages: (operationOptions?: ExecutionOptions) => listPages(operationOptions),
      describePage: (page: PageInfo, operationOptions?: ExecutionOptions) =>
        nativeOperation("describe-page", (driver, ticket) => driver.describePage(page, ticket), {
          charge: false,
          ...bound,
          ...operationOptions,
          targetScope: () => ({ pageId: page.pageId }),
        }),
      frames: (operationOptions?: ExecutionOptions) =>
        nativeOperation(
          "list-frames",
          async (driver, ticket) => {
            const page =
              authority?.info ??
              (await driver.listPages(ticket)).find((info) => info.pageId === target?.pageId);

            if (page === undefined)
              throw BrowserError.make({
                operation: "list-frames",
                reason: Reasons.Stale.make({}),
                outcome: "undispatched",
              });

            return driver.listFrames(ticket, page);
          },
          { ...bound, ...operationOptions, charge: false },
        ),
      framesOf: (page: PageInfo, operationOptions?: ExecutionOptions) =>
        nativeOperation("list-frames", (driver, ticket) => driver.listFrames(ticket, page), {
          charge: false,
          ...bound,
          ...operationOptions,
          targetScope: () => ({ pageId: page.pageId }),
        }),
      pinPage: (page: PageInfo, operationOptions?: ExecutionOptions) =>
        pinned(page, (driver, ticket) => driver.resolvePage(page, ticket), operationOptions),
      pinFrame: (page: PageInfo, frame: FrameInfo, operationOptions?: ExecutionOptions) =>
        pinned(
          page,
          (driver, ticket) => driver.resolveFrame(page, frame, ticket),
          operationOptions,
        ),
      selectPage: (page: PageInfo, operationOptions?: ExecutionOptions) =>
        nativeOperation(
          "select-page",
          async (driver, ticket) => {
            const target = await driver.resolvePage(page, ticket);

            ticket.check();
            registerPage(page, target, ticket.generation);
            await driver.selectPage(page, ticket);
            owner.state.selection++;
          },
          { ...operationOptions, charge: false },
        ),
      selectFrame: (id: string, operationOptions?: ExecutionOptions) =>
        nativeOperation(
          "select-frame",
          async (driver, ticket) => {
            await driver.selectFrame(id, ticket);
            owner.state.selection++;
          },
          { ...operationOptions, charge: false },
        ),
      /** Creation and adoption use the registry lane, independently of Page work. */
      createPage: (operationOptions?: ExecutionOptions) =>
        nativeOperation(
          "new-page",
          async (driver, ticket) => {
            const info = await driver.newPage(ticket);

            ticket.check();
            const target = await driver.resolvePage(info, ticket);

            registerPage(info, target, ticket.generation);

            return info;
          },
          {
            ...operationOptions,
            mutation: true,
            mutationScope: () => "none",
            charge: false,
            anyPage: true,
          },
        ),
      closePage: (page: PageInfo, operationOptions?: ExecutionOptions) =>
        Effect.suspend(() => {
          const record = authority ?? pages.get(page.pageId);

          const deadline = Math.min(
            Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000 +
              Math.min(
                operationOptions?.timeoutMillis ?? limits.actionTimeoutMillis,
                limits.actionTimeoutMillis,
              ),
            owner.lifetimeDeadline,
          );

          const stale = () =>
            BrowserError.make({
              operation: "close-page",
              reason: Reasons.Stale.make({}),
              outcome: "undispatched",
            });

          const checked = Effect.suspend(() =>
            (generation !== undefined && generation !== owner.state.generation) ||
            (record !== undefined && record.info.targetId !== page.targetId) ||
            (authority !== undefined && pages.get(page.pageId) !== authority)
              ? Effect.fail(stale())
              : Effect.void,
          );

          const joined = (attempt: Deferred.Deferred<boolean>) =>
            within(Deferred.await(attempt), deadline, () =>
              BrowserError.make({
                operation: "close-page",
                reason: Reasons.Timeout.make({}),
                outcome: "undispatched",
              }),
            ).pipe(
              Effect.flatMap((closed) =>
                closed
                  ? Effect.void
                  : owner
                      .contain(
                        containment(page.pageId, record),
                        generation ?? owner.state.generation,
                      )
                      .pipe(
                        Effect.flatMap((containment) =>
                          Effect.fail(
                            BrowserError.make({
                              operation: "close-page",
                              reason: Reasons.Provider.make({}),
                              outcome: "unknown",
                              containment,
                            }),
                          ),
                        ),
                      ),
              ),
            );

          if (record?.attempt !== undefined)
            return checked.pipe(Effect.andThen(joined(record.attempt)));

          return checked.pipe(
            Effect.andThen(
              owner.guard(
                "close-page",
                (ticket) =>
                  Effect.gen(function* () {
                    const resolved = yield* native("close-page", ticket, () =>
                      getDriver().resolvePage(page, ticket),
                    );

                    const canonical =
                      record ?? registerPage(page, resolved, ticket.generation).record;

                    if (canonical.attempt !== undefined) return yield* joined(canonical.attempt);
                    const attempt = Deferred.makeUnsafe<boolean>();

                    return yield* native("close-page", ticket, async () => {
                      try {
                        await getDriver().closePage(page, ticket, () => {
                          canonical.attempt = attempt;
                          revokePage(page.pageId, ticket.signal);
                        });
                        pageClosed(page.pageId);
                      } catch (error) {
                        if (canonical.attempt === attempt)
                          Deferred.doneUnsafe(
                            attempt,
                            Effect.succeed(canonical.phase === "closed"),
                          );
                        throw error;
                      }
                    });
                  }),
                {
                  ...operationOptions,
                  recovery: true,
                  waitUntil: deadline,
                  mutation: true,
                  targetScope: () => ({ pageId: page.pageId }),
                  mutationScope: () => ({ pageId: page.pageId }),
                  charge: false,
                  preflight: checked.pipe(
                    Effect.andThen(
                      Effect.suspend(() =>
                        record !== undefined && record.phase !== "open" && record.phase !== "paused"
                          ? Effect.fail(stale())
                          : Effect.void,
                      ),
                    ),
                  ),
                  contain: () => containment(page.pageId, record),
                },
              ),
            ),
          );
        }).pipe(Effect.provideService(Clock.Clock, clock)),
      resize: (viewport: Viewport, operationOptions?: ExecutionOptions) =>
        nativeOperation("resize", (driver, ticket) => driver.resize(viewport, ticket, target), {
          ...bound,
          ...operationOptions,
          mutation: true,
          charge: false,
        }),
      waitFor: (
        selector: string,
        state: "visible" | "hidden" | "attached" | "detached",
        operationOptions?: ExecutionOptions,
      ) =>
        validate.pipe(
          Effect.andThen(
            wait(
              (driver, ticket, resolved) => driver.waitFor(selector, state, ticket, resolved),
              undefined,
              target,
              generation,
              operationOptions,
            ),
          ),
        ),
      waitForElement: (request: WaitForElementRequest, operationOptions?: ExecutionOptions) =>
        validate.pipe(
          Effect.andThen(
            wait(
              (driver, ticket, target) =>
                driver.waitForElement(request.reference, request.state, ticket, target),
              request.timeoutMillis,
              target,
              generation,
              operationOptions,
            ),
          ),
        ),
      clickAndWait: (element: string | ObservedElement, operationOptions?: ExecutionOptions) =>
        nativeOperation(
          "click-and-wait",
          (driver, ticket) =>
            driver.clickAndWait(element, ticket, captureClickAt(targetData(), ticket), target),
          { ...bound, ...operationOptions, mutation: true },
        ),
      clickForDownload: (element: string | ObservedElement, operationOptions?: ExecutionOptions) =>
        nativeOperation(
          "download-action",
          (driver, ticket) => driver.clickForDownload(element, ticket, target),
          { ...bound, ...operationOptions, mutation: true },
        ),
      selectFiles: (
        element: string | ObservedElement,
        files: ReadonlyArray<NativeFileSelection>,
        operationOptions?: ExecutionOptions,
      ) =>
        nativeOperation(
          "select-files",
          (driver, ticket) => driver.selectFiles(element, files, ticket, target),
          { ...bound, ...operationOptions, mutation: true },
        ),
      clickForFileSelection: (
        element: string | ObservedElement,
        files: ReadonlyArray<NativeFileSelection>,
        operationOptions?: ExecutionOptions,
      ) =>
        nativeOperation(
          "file-chooser",
          (driver, ticket) => driver.clickForFileSelection(element, files, ticket, target),
          { ...bound, ...operationOptions, mutation: true },
        ),
      validate,
    };

    const decodeReceipt = <S extends Schema.Constraint>(schema: S, value: unknown) =>
      Schema.decodeUnknownEffect(schema)(value).pipe(
        Effect.mapError(() =>
          BrowserError.make({
            operation: "run",
            reason: Reasons.Malformed.make({}),
            outcome: "performed",
          }),
        ),
      );

    const executeStep = (
      step: Step,
      inputs: InputBindings,
      context: StepExecution,
    ): Effect.Effect<{ receipt: RunReceipt; checkpoint?: Checkpoint }, BrowserError> =>
      Effect.suspend(() => {
        const requests = actionTargets(step.action);
        let group: ResolvedGroup | undefined;
        let prepared = false;

        let currentPhase: RunPhase =
          step.action._tag === "FillForm"
            ? "Field"
            : step.action._tag === "Wait" && step.action.mode._tag === "Settled"
              ? "Settled"
              : "Input";

        let currentField: number | undefined;

        const planOptions: ExecutionOptions = {
          ...context.options,
          phase: (phase, fieldIndex) => {
            currentPhase = phase;
            currentField = fieldIndex;
            context.phase(phase, fieldIndex);
          },
          beforeNative: async (driver, ticket) => {
            if (!prepared) {
              if (step.expect?.before !== undefined) {
                context.phase("Precondition");
                owner.chargeHostRead(ticket, "run");
                await driver.expectations(step.expect.before, ticket, target ?? driver.selected());
              }
              if (requests.length > 0) {
                context.phase("Resolution");
                owner.chargeHostRead(ticket, "resolve");
                group = await driver.resolveGroup(
                  requests,
                  ticket,
                  target ?? driver.selected(),
                  step.resolution,
                );
                context.targets(
                  requests.map((request, index) => ({
                    value: groupElement(index),
                    path: request.path,
                    ...(group?.samples?.[index] === undefined
                      ? {}
                      : { sample: group.samples[index] }),
                  })),
                );
              }
              prepared = true;
            }
            group?.activate(ticket);
            ticket.check();
            context.phase(currentPhase, currentField);
          },
        };

        const groupElement = (index: number): ResolvedElement => {
          const value = group?.elements[index];

          if (value === undefined)
            throw BrowserError.make({
              operation: "run",
              reason: Reasons.Incomplete.make({}),
              outcome: "undispatched",
            });

          return value;
        };

        const indexed = (value: ActionTarget): (() => ResolvedElement) => {
          const index = requests.findIndex((request) => request.target === value);

          return () => groupElement(index);
        };

        const inputValue = (value: ValueSource): Effect.Effect<string, BrowserError> =>
          value._tag === "Literal"
            ? Effect.succeed(value.value)
            : inputs[value.name] === undefined
              ? Effect.fail(
                  BrowserError.make({
                    operation: "run",
                    reason: Reasons.Configuration.make({ path: `inputs.${value.name}` }),
                    outcome: "undispatched",
                  }),
                )
              : Effect.succeed(inputs[value.name] ?? "");

        const policy: AdmissionPolicy | undefined = context.policy?.admit;
        const action = step.action;

        const perform: Effect.Effect<RunReceipt, BrowserError> = Effect.suspend(() => {
          switch (action._tag) {
            case "Navigate":
              return controls.operations
                .navigate(action.url, action.timeoutMillis, planOptions)
                .pipe(Effect.flatMap((url) => decodeReceipt(NavigationResult, { url })));
            case "Click":
              return controls.operations
                .click(indexed(action.target), policy, planOptions)
                .pipe(Effect.flatMap((value) => decodeReceipt(ActionResult, value)));
            case "Hover":
              return controls.operations
                .hover(indexed(action.target), policy, planOptions)
                .pipe(
                  Effect.flatMap((value) =>
                    decodeReceipt(InputReceipt, { ...value, kind: "hover" }),
                  ),
                );
            case "Fill":
              return inputValue(action.value).pipe(
                Effect.flatMap((value) =>
                  controls.operations.fill(indexed(action.target), value, policy, planOptions),
                ),
                Effect.flatMap((url) => decodeReceipt(ActionResult, { url })),
              );
            case "Type":
              return inputValue(action.text).pipe(
                Effect.flatMap((value) =>
                  controls.operations.type(
                    value,
                    action.target === undefined ? undefined : indexed(action.target),
                    policy,
                    planOptions,
                  ),
                ),
                Effect.flatMap((value) => decodeReceipt(InputReceipt, { ...value, kind: "type" })),
              );
            case "Press":
              return controls.operations
                .press(
                  action.key,
                  action.modifiers ?? [],
                  action.target === undefined ? undefined : indexed(action.target),
                  policy,
                  planOptions,
                )
                .pipe(
                  Effect.flatMap((value) =>
                    decodeReceipt(InputReceipt, { ...value, kind: "press" }),
                  ),
                );
            case "Select":
              return controls
                .selectOption(
                  indexed(action.target),
                  () => action.options.map((option) => indexed(option)()),
                  policy,
                  planOptions,
                )
                .pipe(Effect.flatMap((url) => decodeReceipt(ActionResult, { url })));
            case "Scroll": {
              const mode = action.mode;

              return (
                mode._tag === "By"
                  ? controls.operations.scroll(mode.deltaX, mode.deltaY, planOptions)
                  : nativeOperation(
                      "scroll",
                      (driver, ticket) => {
                        const ref = indexed(mode.target)();

                        return driver.scrollTo(ref, ticket, ref.target);
                      },
                      { ...bound, ...planOptions, mutation: true },
                    )
              ).pipe(Effect.flatMap((url) => decodeReceipt(ActionResult, { url })));
            }
            case "PointerMove":
              return controls.operations
                .pointerMove(action.to, planOptions)
                .pipe(
                  Effect.flatMap((value) =>
                    decodeReceipt(InputReceipt, { ...value, kind: "pointer-move" }),
                  ),
                );
            case "Wheel":
              return controls.operations
                .wheel(action.deltaX, action.deltaY, action.at, planOptions)
                .pipe(
                  Effect.flatMap((value) =>
                    decodeReceipt(InputReceipt, {
                      ...value,
                      kind: "wheel",
                      delta: { x: action.deltaX, y: action.deltaY },
                    }),
                  ),
                );
            case "Wait": {
              const mode = action.mode;

              if (mode._tag === "Settled") return controls.settled(mode, planOptions);
              if (mode._tag === "Duration")
                return owner.guard(
                  "wait",
                  (ticket) =>
                    native("wait", ticket, async () => {
                      const driver = getDriver();

                      await driver.pageControl?.checkTarget(target, ticket);
                      await planOptions.beforeNative?.(driver, ticket);
                    }).pipe(
                      Effect.andThen(Effect.sleep(mode.milliseconds)),
                      Effect.andThen(Effect.sync(() => ticket.check())),
                    ),
                  { ...bound, ...planOptions, mutation: false },
                );

              return wait(
                (driver, ticket) => {
                  const ref = indexed(mode.target)();

                  return driver.waitForElement(ref, mode.state, ticket, ref.target);
                },
                mode.timeoutMillis,
                target,
                generation,
                planOptions,
              );
            }
            case "FillForm":
              return Effect.gen(function* () {
                const fields = yield* Effect.forEach(
                  action.fields,
                  (field, index): Effect.Effect<FormField, BrowserError> =>
                    field._tag === "Value"
                      ? inputValue(field.value).pipe(
                          Effect.map((value) => ({ elementId: `field_${index}`, value })),
                        )
                      : Effect.succeed(
                          field._tag === "Checked"
                            ? { elementId: `field_${index}`, checked: field.checked }
                            : {
                                elementId: `field_${index}`,
                                options: field.options.map(
                                  (_, option) => `option_${index}_${option}`,
                                ),
                              },
                        ),
                );

                const request = {
                  observationId: "private_plan",
                  fields,
                  ...(action.submit === undefined ? {} : { submit: "private_submit" }),
                };

                const references = new Map<string, () => ResolvedElement>();

                action.fields.forEach((field, index) =>
                  references.set(`field_${index}`, indexed(field.target)),
                );
                if (action.submit !== undefined)
                  references.set("private_submit", indexed(action.submit));

                const result = yield* controls.fillForm(
                  request,
                  policy,
                  {
                    verify: action.options?.verify ?? true,
                    settleMillis: action.options?.settleMillis ?? 50,
                  },
                  planOptions,
                  {
                    reference: (id) => {
                      const ref = references.get(id);

                      if (ref === undefined)
                        throw BrowserError.make({
                          operation: "fill-form",
                          reason: Reasons.Incomplete.make({}),
                          outcome: "undispatched",
                        });

                      return ref();
                    },
                    field: (field) => {
                      const index = action.fields.findIndex(
                        (_, index) => field.elementId === `field_${index}`,
                      );

                      const source = action.fields[index];

                      return source?._tag === "Options"
                        ? { ...field, options: source.options.map((option) => indexed(option)()) }
                        : field;
                    },
                  },
                );

                const receipt = yield* decodeReceipt(FillFormResult, result);

                context.retainReceipt(receipt);
                if (result.stopped !== undefined) return yield* result.stopped.error;

                return receipt;
              });
          }
        });

        return perform.pipe(
          Effect.tap((receipt) => Effect.sync(() => context.retainReceipt(receipt))),
          Effect.flatMap((receipt) => {
            const checkpointOptions = context.checkpoint;

            const after =
              step.expect?.after === undefined
                ? Effect.void
                : Effect.suspend(() => {
                    context.phase("Postcondition");

                    return nativeOperation(
                      "run",
                      async (driver, ticket) => {
                        await driver.expectations(
                          step.expect?.after ?? [],
                          ticket,
                          target ?? driver.selected(),
                        );
                      },
                      { ...bound, ...context.options, charge: "host-read" },
                    );
                  });

            return after.pipe(
              Effect.andThen(
                checkpointOptions === undefined
                  ? Effect.succeed({ receipt })
                  : Effect.suspend(() => {
                      context.phase("Checkpoint");

                      return controls
                        .checkpoint(
                          { ...checkpointOptions, picture: checkpointOptions.picture ?? false },
                          context.options,
                        )
                        .pipe(
                          Effect.flatMap((value) => decodeReceipt(Checkpoint, value)),
                          Effect.map((checkpoint) => ({ receipt, checkpoint })),
                        );
                    }),
              ),
            );
          }),
          Effect.ensuring(Effect.promise(() => group?.release() ?? Promise.resolve())),
        );
      });

    const plans = makePlanExecution({
      clock,
      validate,
      lifetimeDeadline: owner.lifetimeDeadline,
      actionTimeoutMillis: limits.actionTimeoutMillis,
      newId: uuid,
      publish: () => {
        const releaseDomain = domain.retirement.retain();
        const releasePage = authority?.retirement.retain();

        return {
          append: planPublisher(
            domain.store,
            target === undefined
              ? null
              : { generation: generation ?? owner.state.generation, ...target, document: null },
          ),
          release: () => {
            releasePage?.();
            releaseDomain();
          },
        };
      },
      reserve: Effect.suspend(() => {
        const pageId = target?.pageId ?? getDriver().selected().pageId;
        const count = pageRuns.get(pageId) ?? 0;

        if (activeRuns >= 128 || count >= 32)
          return Effect.fail(
            BrowserError.make({
              operation: "run",
              reason: Reasons.Limit.make({
                dimension: "runs",
                maximum: count >= 32 ? 32 : 128,
                observed: count >= 32 ? count : activeRuns,
              }),
              outcome: "undispatched",
            }),
          );
        activeRuns++;
        pageRuns.set(pageId, count + 1);
        let released = false;

        return Effect.succeed(() => {
          if (released) return;
          released = true;
          activeRuns--;
          const remaining = (pageRuns.get(pageId) ?? 1) - 1;

          if (remaining === 0) pageRuns.delete(pageId);
          else pageRuns.set(pageId, remaining);
        });
      }),
      executeStep,
    });

    return { ...controls, plans };
  };

  const registerPage = (info: PageInfo, target: DriverTarget, generation: number) => {
    let page = pages.get(info.pageId);

    if (page === undefined || page.identity.generation !== generation) {
      const identity = Target.make({ generation, ...target });
      const store = domain.store;
      let terminal: Terminal | null = null;

      const retirement = makeRetirement((reason) => {
        const result = publish(store, {
          target: { ...identity, document: null },
          correlation: null,
          event: { _tag: "Terminal", scope: "page", reason },
        });

        terminal = Object.freeze({
          cursor:
            result._tag === "Appended"
              ? Object.freeze({
                  storeId: result.event.storeId,
                  clockId: result.event.clockId,
                  sequence: result.event.sequence,
                })
              : store.cursor(),
          at: result._tag === "Appended" ? result.event.at : store.now(),
          scope: "page",
          reason,
        });
      });

      page = {
        identity,
        admission: owner.pageAdmission(info.pageId, generation),
        info,
        frames: new Map(),
        phase: pausedPages.has(info.pageId) ? "paused" : "open",
        containment: { _tag: "NotRequired" },
        store,
        retirement,
        get terminal() {
          return terminal;
        },
      };
      pages.set(info.pageId, page);
    }
    const record = page;

    return {
      record,
      timeline: journal.forPage(
        record.store,
        info.pageId,
        record.identity.generation,
        () => record.terminal,
      ),
      controls: makePageControls(target, generation),
      status: Effect.sync((): PageStatus =>
        Object.freeze({
          identity: Object.freeze({ ...record.identity }),
          phase:
            record.phase === "closed"
              ? "closed"
              : record.identity.generation !== owner.state.generation
                ? "stale"
                : record.phase,
          containment: Object.freeze({ ...record.containment }),
          admission: owner.admissionSnapshot(record.admission),
        }),
      ),
    };
  };

  const page = (info: PageInfo, operationOptions?: ExecutionOptions) =>
    owner.guard(
      "target",
      (ticket) =>
        native("target", ticket, async () => {
          const target = await getDriver().resolvePage(info, ticket);

          ticket.check();

          return registerPage(info, target, ticket.generation);
        }),
      { ...operationOptions, charge: false, targetScope: () => ({ pageId: info.pageId }) },
    );

  // A generation change retires every issued capability. Rebuild from the same live connection
  // while the lifecycle permit is still held, before new operations can be admitted.
  const refreshPages = (ticket: Ticket, restore = false) =>
    native("list-pages", ticket, async () => {
      const current = getDriver();
      const inventory = await current.listPages(ticket);
      const resolved = [];

      for (const info of inventory) {
        const target = await current.resolvePage(info, ticket);

        ticket.check();
        resolved.push({ info, target });
      }
      ticket.check();

      const fresh = Inventory.make({
        generation: ticket.generation,
        pages: Object.freeze(inventory.map((info) => Object.freeze({ ...info }))),
      });

      for (const { info, target } of resolved) {
        if (restore) {
          restorePageAuthority(info.pageId);
        }
        registerPage(info, target, ticket.generation);
      }

      return Object.freeze(fresh);
    });

  const listPages = (operationOptions?: ExecutionOptions) =>
    owner.guard(
      "list-pages",
      (ticket) => refreshPages(ticket).pipe(Effect.map((inventory) => inventory.pages)),
      { ...operationOptions, charge: false },
    );

  const initialPage = () => {
    if (initialAuthority === undefined)
      throw BrowserError.make({
        operation: "target",
        reason: Reasons.Closed.make({}),
        outcome: "undispatched",
      });

    return initialAuthority;
  };

  const onSelected = <A, E, R>(
    work: (page: ReturnType<typeof makePageControls>) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | BrowserError, R> =>
    Effect.suspend(() =>
      owner.state.phase !== "open"
        ? owner.status.pipe(
            Effect.flatMap((status) =>
              Effect.fail(
                BrowserError.make({
                  operation: "target",
                  reason:
                    status.reason === "expired"
                      ? Reasons.Expired.make({})
                      : status.phase === "paused"
                        ? Reasons.Busy.make({})
                        : Reasons.Closed.make({}),
                  outcome: "undispatched",
                }),
              ),
            ),
          )
        : Effect.try({
            try: () => {
              const target = getDriver().selected();

              if (!pages.has(target.pageId))
                throw BrowserError.make({
                  operation: "target",
                  reason: Reasons.Stale.make({}),
                  outcome: "undispatched",
                });

              return makePageControls(target, owner.state.generation);
            },
            catch: (cause) =>
              publicError(cause, "target", {
                reason: Reasons.Closed.make({}),
                outcome: "undispatched",
              }),
          }).pipe(Effect.flatMap(work)),
    );

  const selectedControls = makePageControls();

  const lifecycle = <A, E, R>(
    operation: BrowserOperation,
    supported: () => boolean,
    work: () => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | BrowserError, R> =>
    Effect.suspend((): Effect.Effect<A, E | BrowserError, R> => {
      if (!supported())
        return Effect.fail(
          BrowserError.make({
            operation,
            reason: Reasons.Unsupported.make({}),
            outcome: "undispatched",
          }),
        );
      // An ordinary active caller owns its deadline. A lifecycle request refuses before
      // installing its barrier rather than converting that caller's latency into uncertainty.
      if (owner.hasActive())
        return Effect.fail(
          BrowserError.make({
            operation,
            reason: Reasons.Busy.make({}),
            outcome: "undispatched",
          }),
        );
      const barrier = owner.pauseAdmission();

      if (barrier === undefined)
        return Effect.fail(
          BrowserError.make({
            operation,
            reason: Reasons.Busy.make({}),
            outcome: "undispatched",
          }),
        );
      activeBindings?.pauseAdmission();

      return Effect.suspend(work).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (owner.resumeAdmission(barrier) && owner.state.phase === "open")
              activeBindings?.resumeAdmission();
          }),
        ),
      );
    });

  const controls = {
    ...selectedControls,
    timeline: journal.timeline,
    pageEvents: journal.pageEvents,
    operations: {
      startNavigation: (
        ...args: Parameters<ReturnType<typeof makePageControls>["operations"]["startNavigation"]>
      ) => onSelected((page) => page.operations.startNavigation(...args)),
      navigate: (
        ...args: Parameters<ReturnType<typeof makePageControls>["operations"]["navigate"]>
      ) => onSelected((page) => page.operations.navigate(...args)),
      readText: (
        ...args: Parameters<ReturnType<typeof makePageControls>["operations"]["readText"]>
      ) => onSelected((page) => page.operations.readText(...args)),
      click: (...args: Parameters<ReturnType<typeof makePageControls>["operations"]["click"]>) =>
        onSelected((page) => page.operations.click(...args)),
      fill: (...args: Parameters<ReturnType<typeof makePageControls>["operations"]["fill"]>) =>
        onSelected((page) => page.operations.fill(...args)),
      scroll: (...args: Parameters<ReturnType<typeof makePageControls>["operations"]["scroll"]>) =>
        onSelected((page) => page.operations.scroll(...args)),
      pointerMove: (
        ...args: Parameters<ReturnType<typeof makePageControls>["operations"]["pointerMove"]>
      ) => onSelected((page) => page.operations.pointerMove(...args)),
      hover: (...args: Parameters<ReturnType<typeof makePageControls>["operations"]["hover"]>) =>
        onSelected((page) => page.operations.hover(...args)),
      wheel: (...args: Parameters<ReturnType<typeof makePageControls>["operations"]["wheel"]>) =>
        onSelected((page) => page.operations.wheel(...args)),
      press: (...args: Parameters<ReturnType<typeof makePageControls>["operations"]["press"]>) =>
        onSelected((page) => page.operations.press(...args)),
      type: (...args: Parameters<ReturnType<typeof makePageControls>["operations"]["type"]>) =>
        onSelected((page) => page.operations.type(...args)),
      screenshot: (
        ...args: Parameters<ReturnType<typeof makePageControls>["operations"]["screenshot"]>
      ) => onSelected((page) => page.operations.screenshot(...args)),
    },
    observe: (...args: Parameters<ReturnType<typeof makePageControls>["observe"]>) =>
      onSelected((page) => page.observe(...args)),
    checkpoint: (...args: Parameters<ReturnType<typeof makePageControls>["checkpoint"]>) =>
      onSelected((page) => page.checkpoint(...args)),
    controlFacts: (...args: Parameters<ReturnType<typeof makePageControls>["controlFacts"]>) =>
      onSelected((page) => page.controlFacts(...args)),
    selectOption: (...args: Parameters<ReturnType<typeof makePageControls>["selectOption"]>) =>
      onSelected((page) => page.selectOption(...args)),
    fillForm: (...args: Parameters<ReturnType<typeof makePageControls>["fillForm"]>) =>
      onSelected((page) => page.fillForm(...args)),
    revalidate: (...args: Parameters<ReturnType<typeof makePageControls>["revalidate"]>) =>
      onSelected((page) => page.revalidate(...args)),
    readiness: (...args: Parameters<ReturnType<typeof makePageControls>["readiness"]>) =>
      onSelected((page) => page.readiness(...args)),
    resize: (...args: Parameters<ReturnType<typeof makePageControls>["resize"]>) =>
      onSelected((page) => page.resize(...args)),
    frames: (...args: Parameters<ReturnType<typeof makePageControls>["frames"]>) =>
      onSelected((page) => page.frames(...args)),
    waitFor: (...args: Parameters<ReturnType<typeof makePageControls>["waitFor"]>) =>
      onSelected((page) => page.waitFor(...args)),
    waitForElement: (...args: Parameters<ReturnType<typeof makePageControls>["waitForElement"]>) =>
      onSelected((page) => page.waitForElement(...args)),
    clickAndWait: (...args: Parameters<ReturnType<typeof makePageControls>["clickAndWait"]>) =>
      onSelected((page) => page.clickAndWait(...args)),
    clickForDownload: (
      ...args: Parameters<ReturnType<typeof makePageControls>["clickForDownload"]>
    ) => onSelected((page) => page.clickForDownload(...args)),
    selectFiles: (...args: Parameters<ReturnType<typeof makePageControls>["selectFiles"]>) =>
      onSelected((page) => page.selectFiles(...args)),
    clickForFileSelection: (
      ...args: Parameters<ReturnType<typeof makePageControls>["clickForFileSelection"]>
    ) => onSelected((page) => page.clickForFileSelection(...args)),
    initialPage,
    page,
    frame: (
      info: PageInfo,
      frame: FrameInfo,
      generation: number,
      operationOptions?: ExecutionOptions,
    ) =>
      owner.guard(
        "target",
        (ticket) =>
          native("target", ticket, async () => {
            const target = await getDriver().resolveFrame(info, frame, ticket);

            ticket.check();
            const page = pages.get(info.pageId);

            if (page === undefined || page.phase !== "open")
              throw BrowserError.make({
                operation: "target",
                reason: Reasons.Stale.make({}),
                outcome: "undispatched",
              });
            let record = page.frames.get(target.frameId);

            if (record === undefined) {
              if (page.frames.size >= 128)
                throw BrowserError.make({
                  operation: "target",
                  reason: Reasons.Limit.make({
                    dimension: "frames",
                    maximum: 128,
                    observed: page.frames.size + 1,
                  }),
                  outcome: "undispatched",
                });
              record = { detached: false };
              page.frames.set(target.frameId, record);
            }

            return {
              identity: Target.make({ generation, ...target }),
              record,
              controls: makePageControls(target, generation),
            };
          }),
        {
          ...operationOptions,
          charge: false,
          targetScope: () => ({ pageId: info.pageId }),
          preflight: checkTarget(undefined, generation),
        },
      ),
    implementation: options.implementation,
    status: owner.status,
    diagnostics: owner.diagnostics,
    admissionStatus: owner.admissionStatus,
    reference: ref,
    capture,
    retain,
    target: readSelected,
    cleanupResult,
    close: release.pipe(
      Effect.tap(() => retireControl),
      Effect.provideService(Clock.Clock, clock),
    ),
    closeChecked: acquired.closeChecked.pipe(
      Effect.onExit(() => retireControl),
      Effect.provideService(Clock.Clock, clock),
    ),
    liveView: <A>(issue: Effect.Effect<A, BrowserError>, operationOptions?: ExecutionOptions) =>
      owner.guard("live-view", () => issue, {
        ...operationOptions,
        charge: false,
        phases: ["open", "paused"],
      }),
    beginHandoff: <A>(issue: Effect.Effect<A, BrowserError>, operationOptions?: ExecutionOptions) =>
      lifecycle(
        "handoff",
        () => !options.driver.pageControl,
        () =>
          owner.guard(
            "handoff",
            (ticket) =>
              Effect.gen(function* () {
                // Drawn before the fence, so the pause and the token that ends it commit together.
                const token = handoffToken ?? (yield* uuid);

                if (owner.state.phase === "open") {
                  const deadline = Math.min(
                    ticket.deadline,
                    Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000 + 3000,
                  );

                  let drained = false;

                  yield* Effect.gen(function* () {
                    yield* Effect.forEach(
                      [...capture.captureLeases.values()],
                      (lease) => lease.stop,
                      {
                        discard: true,
                      },
                    );
                    while (
                      !owner.drained(ticket.signal) ||
                      activeBindings?.drained() === false ||
                      getDriver().handoffDrained?.() === false ||
                      capture.captureLeases.size !== 0 ||
                      pendingPageFaults.size !== 0
                    )
                      yield* Effect.sleep(10);
                    if (owner.state.phase !== "open")
                      return yield* BrowserError.make({
                        operation: "handoff",
                        reason: Reasons.Closed.make({}),
                        outcome: "undispatched",
                        containment: { _tag: "SessionFenced", generation: owner.state.generation },
                      });
                    drained = true;
                    owner.fence("paused", "paused", "handoff");
                  }).pipe(
                    (drain) =>
                      within(drain, deadline, () =>
                        BrowserError.make({
                          operation: "handoff",
                          reason: Reasons.Timeout.make({}),
                          outcome: "undispatched",
                        }),
                      ),
                    Effect.ensuring(
                      Effect.sync(() => {
                        if (!drained) {
                          if (owner.state.phase === "open" || owner.state.phase === "paused")
                            owner.terminate("native-failure", "unknown");
                          activeBindings?.close();
                        }
                      }),
                    ),
                    Effect.mapError((error) =>
                      BrowserError.make({
                        operation: "handoff",
                        reason: error.reason,
                        outcome: error.outcome,
                        containment: drained
                          ? error.containment
                          : { _tag: "SessionFenced", generation: owner.state.generation },
                      }),
                    ),
                  );
                }
                handoffToken ??= token;
                // A refused authorization leaves automation paused until explicit operator release.
                const view = yield* issue;

                return { token: Redacted.make(handoffToken), view };
              }),
            {
              ...operationOptions,
              charge: false,
              phases: ["open", "paused"],
              verifyAfter: false,
              bypassBlocked: true,
            },
          ),
      ),
    resume: (
      token: Redacted.Redacted<string>,
      operatorReleasedControl: boolean,
      operationOptions?: ExecutionOptions,
    ) =>
      lifecycle(
        "resume",
        () => true,
        () =>
          owner.guard(
            "resume",
            (ticket) =>
              Effect.gen(function* () {
                if (
                  !operatorReleasedControl ||
                  handoffToken === undefined ||
                  Redacted.value(token) !== handoffToken
                ) {
                  return yield* BrowserError.make({
                    operation: "resume",
                    reason: Reasons.Authorization.make({}),
                    outcome: "undispatched",
                  });
                }
                yield* native("resume", ticket, () => getDriver().dismissDialogs(ticket));
                const inventory = yield* refreshPages(ticket, true);

                // The fresh registry and phase commit share the lifecycle permit. Reading content
                // remains an explicit operation on a newly acquired Page.
                activeBindings?.resumeAdmission();
                owner.transition("open");
                handoffToken = undefined;

                return inventory;
              }),
            {
              ...operationOptions,
              charge: false,
              phases: ["paused"],
              verifyAfter: false,
              bypassBlocked: true,
            },
          ),
      ),
    detach: lifecycle(
      "detach",
      () => options.keepAlive,
      () =>
        owner
          .guard(
            "detach",
            (ticket) =>
              Effect.gen(function* () {
                if (!options.keepAlive)
                  return yield* BrowserError.make({
                    operation: "detach",
                    reason: Reasons.Unsupported.make({}),
                    outcome: "undispatched",
                  });
                reconnectTarget = yield* native("detach", ticket, () =>
                  getDriver().selectedTargetId(),
                );
                const inventory = yield* refreshPages(ticket);

                if (!inventory.pages.some((info) => info.targetId === reconnectTarget))
                  return yield* BrowserError.make({
                    operation: "detach",
                    reason: Reasons.Stale.make({}),
                    outcome: "undispatched",
                  });
                const attached = getDriver();

                activeConnection = undefined;
                owner.fence("detached", "disconnected", "detached");
                const initialization = yield* Effect.exit(disposeBindings);

                const disconnected = yield* Effect.tryPromise({
                  try: () => attached.disconnect(),
                  catch: () =>
                    BrowserError.make({
                      operation: "detach",
                      reason: Reasons.Disconnected.make({}),
                      outcome: "unknown",
                    }),
                }).pipe(Effect.exit);

                driver = undefined;
                if (Exit.isFailure(initialization))
                  return yield* Effect.failCause(initialization.cause);
                if (Exit.isFailure(disconnected))
                  return yield* Effect.failCause(disconnected.cause);

                return { reference: ref, targetId: reconnectTarget, inventory };
              }),
            { charge: false, verifyAfter: false, bypassBlocked: true },
          )
          .pipe(Effect.onError(() => Effect.sync(() => owner.fence("uncertain", "uncertain")))),
    ),
    reconnect: (operatorReleasedControl: boolean, operationOptions?: ExecutionOptions) =>
      lifecycle(
        "reconnect",
        () =>
          options.keepAlive &&
          reconnectTarget !== undefined &&
          operatorReleasedControl &&
          acquired.verifyReconnect !== undefined,
        () =>
          owner
            .guard(
              "reconnect",
              (ticket) =>
                Effect.gen(function* () {
                  if (
                    !options.keepAlive ||
                    reconnectTarget === undefined ||
                    !operatorReleasedControl ||
                    acquired.verifyReconnect === undefined
                  ) {
                    return yield* BrowserError.make({
                      operation: "reconnect",
                      reason: Reasons.Unsupported.make({}),
                      outcome: "undispatched",
                    });
                  }

                  yield* acquired.verifyReconnect;
                  owner.transition("acquiring");
                  const endpoint = yield* connectionUrl("reconnect");

                  yield* connectNative(endpoint, {
                    ...options.driver,
                    initialTargetId: reconnectTarget,
                    newPage: false,
                    preserveViewport: true,
                  });
                  const inventory = yield* refreshPages(ticket);

                  owner.transition("open");

                  return inventory;
                }),
              {
                ...operationOptions,
                charge: false,
                phases: ["detached", "acquiring"],
                verifyAfter: false,
                bypassBlocked: true,
              },
            )
            .pipe(
              Effect.onError(() => closeScope),
              Effect.onInterrupt(() => closeScope),
            ),
      ),
  };

  yield* Effect.forever(
    Effect.suspend(() =>
      Deferred.await(pageFaultWake).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            const faults = [...pendingPageFaults];

            pageFaultWake = Deferred.makeUnsafe<void>();

            return Effect.forEach(
              faults,
              ([pageId, fault]) =>
                owner
                  .contain(containment(pageId, fault.authority), fault.generation)
                  .pipe(Effect.ensuring(Effect.sync(() => pendingPageFaults.delete(pageId)))),
              { discard: true },
            );
          }),
        ),
      ),
    ),
  ).pipe(Effect.forkScoped);

  // One timer belongs to the enclosing execution, never to an individual Tool call.
  const remaining = Math.max(
    0,
    owner.lifetimeDeadline - Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000,
  );

  // The execution lifetime distinguishes expiry from natural completion before
  // running the shared close path; this race has the required proven semantics.
  // @effect-diagnostics-next-line raceFirstWithSleepToTimeout:off
  yield* Effect.raceFirst(
    Effect.sleep(remaining).pipe(Effect.as(true)),
    Deferred.await(ended).pipe(Effect.as(false)),
  ).pipe(
    Effect.flatMap((expired) =>
      expired ? Effect.sync(owner.expire).pipe(Effect.andThen(closeScope)) : Effect.void,
    ),
    Effect.forkIn(parentScope),
  );

  return {
    reference: ref,
    /** The caller keeps its own lease type, including whether an allocation attempt exists. */
    lease: acquired,
    close: controls.close,
    connect: Effect.suspend(() =>
      owner.state.phase === "closed" || owner.state.phase === "closing"
        ? Effect.fail(
            BrowserError.make({
              operation: "connect",
              reason: Reasons.Closed.make({}),
              outcome: "undispatched",
            }),
          )
        : connected.pipe(Effect.as(controls)),
    ),
  };
});

export type SessionControls<L extends SessionLease = SessionLease> =
  Effect.Success<ReturnType<typeof acquireSession<L, never, never>>> extends {
    connect: Effect.Effect<infer A, infer _E, infer _R>;
  }
    ? A
    : never;

export type TargetControls = SessionControls["operations"];

export type PageControls = ReturnType<SessionControls["initialPage"]>["controls"];
