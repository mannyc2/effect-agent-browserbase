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
  type FrameInfo,
  type InputReceipt,
  Inventory,
  type KeyModifier,
  Observation,
  type ObservedElement,
  type PageInfo,
  type PageSuspension,
  type SelectOptions,
  Target,
  type Viewport,
  type WaitForElementRequest,
} from "../../BrowserData.ts";
import type { Lifetime, Source } from "../../BrowserRuntime.ts";
import { BrowserError, Reasons, type BrowserOperation } from "../../Errors.ts";
import type { AdmissionLane } from "./Admission.ts";
import { type CaptureParent } from "./Association.ts";
import type { BindingImplementation, ConnectionIdentity } from "./Binding.ts";
import type { ConnectionBindings } from "./Bindings.ts";
import { cleanupStep, type ConnectionCleanup, type ConnectionState } from "./ConnectionCleanup.ts";
import type {
  Driver,
  DriverEvents,
  DriverFault,
  DriverOptions,
  DriverTarget,
  InputCapture,
  NativeFileSelection,
  NavigationControl,
} from "./Driver.ts";
import { publicError } from "./NativeCalls.ts";
import type { AdmissionPolicy } from "./Observation.ts";
import {
  makeOwner,
  native,
  within,
  type Limits,
  type ObservationScope,
  type OwnedWait,
  type Ticket,
  type WaitTicket,
} from "./Owner.ts";
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
  limits: Limits,
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
  const clock = yield* Clock.Clock;
  const uuid = randomUuid(yield* Crypto.Crypto);

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
      attempt?: Deferred.Deferred<boolean>;
    }
  >();

  let initialTarget: DriverTarget | undefined;
  let initialInfo: PageInfo | undefined;
  let initialAuthority: ReturnType<typeof registerPage> | undefined;
  const pausedPages = new Set<string>();

  const pageClosed = (pageId: string) => {
    pausedPages.delete(pageId);
    driver?.retireInitializationPage?.(pageId);
    activeBindings?.retirePage(pageId);
    const page = pages.get(pageId);

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
    resolve: (ticket, requested) =>
      native("capture-start", ticket, async () => {
        if (driver === undefined)
          throw BrowserError.make({
            operation: "capture",
            reason: Reasons.Closed.make({}),
            outcome: "undispatched",
          });
        const binding = await driver.capture(requested);
        const generation = owner.state.generation;

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

        return {
          key: binding.targetId,
          target,
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
      }),
    captureLeases: new Map(),
    captureReservedBytes: 0,
  };

  owner.onInvalidate((reason, scope) => {
    driver?.invalidateObservation(scope);
    if (reason === "uncertain" && scope === "all")
      for (const page of pages.values())
        page.containment = { _tag: "SessionFenced", generation: owner.state.generation };
    if (scope === "all" && ["paused", "disconnected", "uncertain", "closed"].includes(reason))
      pages.clear();
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
  const local: ConnectionCleanup = {
    fence: Effect.sync(() => {
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
  );

  const connectionEvents = (connectionLease: object, generation: number): DriverEvents => ({
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
    pageClosed: (pageId) => {
      if (activeConnection === connectionLease) pageClosed(pageId);
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
  });

  const connectNative = (url: Redacted.Redacted<unknown>, nativeOptions: DriverOptions) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        // Drawn before this attempt claims the connection, so a failed draw leaves nothing to undo.
        const identity: ConnectionIdentity = { namespace: yield* uuid, bindings: yield* uuid };
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
  const readSelected = (operationOptions?: OperationOptions) =>
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
    start: (driver: Driver, ticket: WaitTicket, target: DriverTarget) => Promise<void>,
    timeoutMillis?: number,
    browserTarget?: DriverTarget,
    generation?: number,
    operationOptions?: OperationOptions,
  ): Effect.Effect<void, BrowserError> =>
    Effect.suspend(() => {
      let owned: OwnedWait | undefined;
      const target = browserTarget ?? getDriver().selected();

      return owner
        .guard(
          "wait",
          (ticket) =>
            native("wait", ticket, async () => {
              const driver = getDriver();
              const connection = activeConnection;

              if (connection === undefined)
                throw BrowserError.make({
                  operation: "wait",
                  reason: Reasons.Closed.make({}),
                  outcome: "undispatched",
                });
              const admitted = owner.beginWait(ticket, target, connection);

              owned = admitted;
              let started = false;

              try {
                await driver.pageControl?.checkTarget(target, ticket);
                ticket.check();
                await requireReady("wait", ticket, target);
                ticket.check();
                admitted.start(() => start(driver, admitted.ticket, target));
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
                ? checkTarget(target, generation).pipe(Effect.andThen(unreserved("wait", target)))
                : Effect.fail(
                    BrowserError.make({
                      operation: "wait",
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
    (target: Target): InputCapture =>
    async (dispatch, dispatched) => {
      const startedMonotonicNanos = clock.monotonicTimeNanosUnsafe();

      await dispatch();

      return {
        ...dispatched,
        target,
        kind: "click",
        startedMonotonicNanos,
        completedMonotonicNanos: clock.monotonicTimeNanosUnsafe(),
      };
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
      operationOptions?: OperationOptions,
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
      operation: BrowserOperation,
      action: (driver: Driver, ticket: Ticket, target: DriverTarget) => Promise<NativeInput>,
      operationOptions?: OperationOptions,
    ) =>
      run(
        operation,
        async (driver, ticket, browserTarget) => {
          // What the input is sent to, read first: input may replace the document it reaches.
          const target = operationTarget(browserTarget);
          const startedMonotonicNanos = clock.monotonicTimeNanosUnsafe();
          const dispatched = await action(driver, ticket, browserTarget);

          return {
            ...dispatched,
            target,
            startedMonotonicNanos,
            completedMonotonicNanos: clock.monotonicTimeNanosUnsafe(),
          };
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
    const startNavigation = Effect.fnUntraced(function* (
      url: string,
      timeoutMillis: number = limits.actionTimeoutMillis,
      operationOptions?: OperationOptions,
    ) {
      const requestedTimeout = Math.min(
        timeoutMillis,
        operationOptions?.timeoutMillis ?? timeoutMillis,
      );

      const loadingDeadline = Math.min(
        Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000 + requestedTimeout,
        owner.lifetimeDeadline,
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
          decide(failed(timedOut ? Reasons.Timeout.make({}) : Reasons.Interrupted.make({})), true),
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
    });

    return {
      startNavigation,
      // The same machinery, scoped to the call: leaving it unsettled fences, as it always has.
      navigate: (url: string, timeoutMillis?: number, operationOptions?: OperationOptions) =>
        Effect.scoped(
          startNavigation(url, timeoutMillis, operationOptions).pipe(
            Effect.flatMap((operation) => operation.completed),
          ),
        ),
      readText: (selector?: string, operationOptions?: OperationOptions) =>
        run(
          "read-text",
          (driver, ticket, browserTarget) =>
            driver.readText(selector, options.maxReturnedBytes, ticket, browserTarget),
          false,
          operationOptions,
        ),
      click: (
        target: string | ObservedElement,
        policy?: AdmissionPolicy,
        operationOptions?: OperationOptions,
      ) =>
        run(
          "click",
          (driver, ticket, browserTarget) =>
            driver.click(
              target,
              ticket,
              captureClickAt(operationTarget(browserTarget)),
              policy,
              browserTarget,
            ),
          true,
          operationOptions,
        ),
      fill: (
        target: string | ObservedElement,
        value: string,
        policy?: AdmissionPolicy,
        operationOptions?: OperationOptions,
      ) =>
        run(
          "fill",
          (driver, ticket, browserTarget) =>
            driver.fill(target, value, ticket, policy, browserTarget),
          true,
          operationOptions,
        ),
      scroll: (x: number, y: number, operationOptions?: OperationOptions) =>
        run(
          "scroll",
          (driver, ticket, browserTarget) => driver.scroll(x, y, ticket, browserTarget),
          true,
          operationOptions,
        ),
      pointerMove: (to: NativePoint, operationOptions?: OperationOptions) =>
        input(
          "pointer-move",
          (driver, ticket, browserTarget) => driver.pointerMove(to, ticket, browserTarget),
          operationOptions,
        ),
      hover: (
        target: string | ObservedElement,
        policy?: AdmissionPolicy,
        operationOptions?: OperationOptions,
      ) =>
        input(
          "hover",
          (driver, ticket, browserTarget) => driver.hover(target, ticket, policy, browserTarget),
          operationOptions,
        ),
      wheel: (
        deltaX: number,
        deltaY: number,
        at?: NativePoint,
        operationOptions?: OperationOptions,
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
        into?: string | ObservedElement,
        policy?: AdmissionPolicy,
        operationOptions?: OperationOptions,
      ) =>
        input(
          "press",
          (driver, ticket, browserTarget) =>
            driver.press(key, modifiers, into, ticket, policy, browserTarget),
          operationOptions,
        ),
      type: (
        text: string,
        into?: string | ObservedElement,
        policy?: AdmissionPolicy,
        operationOptions?: OperationOptions,
      ) =>
        input(
          "type",
          (driver, ticket, browserTarget) => driver.type(text, into, ticket, policy, browserTarget),
          operationOptions,
        ),
      screenshot: (full: boolean, operationOptions?: OperationOptions) =>
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
    operationOptions?: OperationOptions,
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

  const retain = (operationOptions?: OperationOptions) =>
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

    const targetData = () =>
      target === undefined
        ? capture.target()
        : Target.make({ generation: generation ?? owner.state.generation, ...target });

    return {
      pageControl: {
        state: (page: PageInfo, operationOptions?: OperationOptions) =>
          nativeOperation("page-state", (_driver, ticket) => execution().state(page, ticket), {
            ...bound,
            ...operationOptions,
            charge: false,
            containPageId: page.pageId,
            targetScope: () => ({ pageId: page.pageId }),
          }),
        suspend: (page: PageInfo, operationOptions?: OperationOptions) =>
          nativeOperation("page-suspend", (_driver, ticket) => execution().suspend(page, ticket), {
            ...bound,
            ...operationOptions,
            charge: false,
            containPageId: page.pageId,
            targetScope: () => ({ pageId: page.pageId }),
            preflight: waitFree("page-suspend", page.pageId),
          }),
        resume: (receipt: PageSuspension, operationOptions?: OperationOptions) =>
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
      observe: (reading: Reading = { scope: "document" }, operationOptions?: OperationOptions) =>
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
        operationOptions?: OperationOptions,
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
      controlFacts: (reference: ObservedElement, operationOptions?: OperationOptions) =>
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
        reference: ObservedElement,
        options: SelectOptions,
        policy?: AdmissionPolicy,
        operationOptions?: OperationOptions,
      ) =>
        nativeOperation(
          "select-option",
          (driver, ticket) => driver.selectOption(reference, options, ticket, policy, target),
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
        operationOptions?: OperationOptions,
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
            ),
            ...(operationOptions?.admission?.queue === undefined
              ? {}
              : { queueDeadline: requested + Duration.toMillis(operationOptions.admission.queue) }),
          };

          // The page whose observation the steps kept usable, known once one of them dispatched.
          let pageId: string | undefined;

          const reference = (elementId: string): ObservedElement => ({
            observationId: request.observationId,
            elementId,
          });

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

            for (const field of request.fields) {
              const exit = yield* Effect.exit(
                nativeOperation(
                  "fill-form",
                  async (driver, ticket) => {
                    try {
                      return await driver.formStep(
                        reference(field.elementId),
                        field,
                        ticket,
                        policy,
                        form.settleMillis,
                        captureClickAt(targetData()),
                        target,
                      );
                    } finally {
                      if (ticket.dispatched) pageId ??= target?.pageId ?? driver.selected().pageId;
                    }
                  },
                  { ...bound, ...formOptions, mutation: true, mutationScope: () => "none" },
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

            const exit = yield* Effect.exit(
              nativeOperation(
                "fill-form",
                (driver, ticket) =>
                  driver.formSubmit(
                    reference(submit),
                    ticket,
                    captureClickAt(targetData()),
                    policy,
                    target,
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
      revalidate: (reference: ObservedElement, operationOptions?: OperationOptions) =>
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
      readiness: (operationOptions?: OperationOptions) =>
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
      pages: (operationOptions?: OperationOptions) => listPages(operationOptions),
      listPages: (operationOptions?: OperationOptions) => listPages(operationOptions),
      describePage: (page: PageInfo, operationOptions?: OperationOptions) =>
        nativeOperation("describe-page", (driver, ticket) => driver.describePage(page, ticket), {
          charge: false,
          ...bound,
          ...operationOptions,
          targetScope: () => ({ pageId: page.pageId }),
        }),
      frames: (operationOptions?: OperationOptions) =>
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
      framesOf: (page: PageInfo, operationOptions?: OperationOptions) =>
        nativeOperation("list-frames", (driver, ticket) => driver.listFrames(ticket, page), {
          charge: false,
          ...bound,
          ...operationOptions,
          targetScope: () => ({ pageId: page.pageId }),
        }),
      pinPage: (page: PageInfo, operationOptions?: OperationOptions) =>
        pinned(page, (driver, ticket) => driver.resolvePage(page, ticket), operationOptions),
      pinFrame: (page: PageInfo, frame: FrameInfo, operationOptions?: OperationOptions) =>
        pinned(
          page,
          (driver, ticket) => driver.resolveFrame(page, frame, ticket),
          operationOptions,
        ),
      selectPage: (page: PageInfo, operationOptions?: OperationOptions) =>
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
      selectFrame: (id: string, operationOptions?: OperationOptions) =>
        nativeOperation(
          "select-frame",
          async (driver, ticket) => {
            await driver.selectFrame(id, ticket);
            owner.state.selection++;
          },
          { ...operationOptions, charge: false },
        ),
      /** Creation and adoption use the registry lane, independently of Page work. */
      createPage: (operationOptions?: OperationOptions) =>
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
      closePage: (page: PageInfo, operationOptions?: OperationOptions) =>
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
        }),
      resize: (viewport: Viewport, operationOptions?: OperationOptions) =>
        nativeOperation("resize", (driver, ticket) => driver.resize(viewport, ticket, target), {
          ...bound,
          ...operationOptions,
          mutation: true,
          charge: false,
        }),
      waitFor: (
        selector: string,
        state: "visible" | "hidden" | "attached" | "detached",
        operationOptions?: OperationOptions,
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
      waitForElement: (request: WaitForElementRequest, operationOptions?: OperationOptions) =>
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
      clickAndWait: (element: string | ObservedElement, operationOptions?: OperationOptions) =>
        nativeOperation(
          "click-and-wait",
          (driver, ticket) =>
            driver.clickAndWait(element, ticket, captureClickAt(targetData()), target),
          { ...bound, ...operationOptions, mutation: true },
        ),
      clickForDownload: (element: string | ObservedElement, operationOptions?: OperationOptions) =>
        nativeOperation(
          "download-action",
          (driver, ticket) => driver.clickForDownload(element, ticket, target),
          { ...bound, ...operationOptions, mutation: true },
        ),
      selectFiles: (
        element: string | ObservedElement,
        files: ReadonlyArray<NativeFileSelection>,
        operationOptions?: OperationOptions,
      ) =>
        nativeOperation(
          "select-files",
          (driver, ticket) => driver.selectFiles(element, files, ticket, target),
          { ...bound, ...operationOptions, mutation: true },
        ),
      clickForFileSelection: (
        element: string | ObservedElement,
        files: ReadonlyArray<NativeFileSelection>,
        operationOptions?: OperationOptions,
      ) =>
        nativeOperation(
          "file-chooser",
          (driver, ticket) => driver.clickForFileSelection(element, files, ticket, target),
          { ...bound, ...operationOptions, mutation: true },
        ),
      validate,
    };
  };

  const registerPage = (info: PageInfo, target: DriverTarget, generation: number) => {
    let page = pages.get(info.pageId);

    if (page === undefined || page.identity.generation !== generation) {
      page = {
        identity: Target.make({ generation, ...target }),
        admission: owner.pageAdmission(info.pageId, generation),
        info,
        frames: new Map(),
        phase: pausedPages.has(info.pageId) ? "paused" : "open",
        containment: { _tag: "NotRequired" },
      };
      pages.set(info.pageId, page);
    }
    const record = page;

    return {
      record,
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

  const page = (info: PageInfo, operationOptions?: OperationOptions) =>
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

  const listPages = (operationOptions?: OperationOptions) =>
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
      operationOptions?: OperationOptions,
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
    close: release.pipe(Effect.tap(() => retireControl)),
    closeChecked: acquired.closeChecked.pipe(Effect.onExit(() => retireControl)),
    liveView: <A>(issue: Effect.Effect<A, BrowserError>, operationOptions?: OperationOptions) =>
      owner.guard("live-view", () => issue, {
        ...operationOptions,
        charge: false,
        phases: ["open", "paused"],
      }),
    beginHandoff: <A>(issue: Effect.Effect<A, BrowserError>, operationOptions?: OperationOptions) =>
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
      operationOptions?: OperationOptions,
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
    reconnect: (operatorReleasedControl: boolean, operationOptions?: OperationOptions) =>
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
