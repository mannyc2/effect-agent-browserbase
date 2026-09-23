import {
  Cause,
  Clock,
  Crypto,
  Deferred,
  Effect,
  Exit,
  Option,
  Redacted,
  Schema,
  Scope,
} from "effect";

import {
  type FillFormRequest,
  type FrameInfo,
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
  }>;
  readonly submitted: boolean;
  readonly url: string;
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
  // A canceled setup may outlive its operation and connection. Keep one slot across the owner
  // until that native setup and its port actually retire; a new operation cannot evade the bound.
  let stopSetupPending: Deferred.Deferred<void> | undefined;

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

        return {
          key: binding.targetId,
          target: Target.make({
            generation: owner.state.generation,
            pageId: binding.pageId,
            frameId: binding.frameId,
          }),
          source: binding.source,
        };
      }),
    captureLeases: new Map(),
    captureReservedBytes: 0,
  };

  owner.onInvalidate((reason, scope) => {
    driver?.invalidateObservation(scope);
    if (["disconnected", "uncertain", "closed"].includes(reason)) fenceBindings();
    if (["paused", "disconnected", "uncertain", "closed"].includes(reason))
      for (const lease of capture.captureLeases.values()) lease.invalidate(reason);
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
    pause: (reason = "dialog") => {
      if (activeConnection !== connectionLease) return;
      const trigger = reason === "popup" ? "popup-policy" : "dialog-policy";

      owner.record(trigger, "confirmed", generation);
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
  ) =>
    Effect.suspend(() => {
      const revision = owner.state.revision;

      return native("observe", ticket, async () => {
        await getDriver().pageControl?.checkTarget(undefined, ticket);
        if (dependent) await requireReady("observe", ticket);

        return getDriver().observe(scope, maximumBytes, controls, ticket, match);
      }).pipe(
        Effect.flatMap((raw) =>
          Effect.gen(function* () {
            if (owner.state.revision !== revision)
              return yield* BrowserError.make({
                operation: "observe",
                reason: Reasons.Stale.make({}),
                outcome: "undispatched",
              });

            const result = yield* Effect.try({
              try: () => Observation.make({ ...raw, target: capture.target(), revision }),
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
  const readSelected = owner.guard(
    "target",
    () =>
      Effect.try({
        try: capture.target,
        catch: () =>
          BrowserError.make({
            operation: "target",
            reason: Reasons.Closed.make({}),
            outcome: "undispatched",
          }),
      }),
    { charge: false },
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

  const nativeOperation = <A>(
    operation: BrowserOperation,
    action: (driver: Driver, ticket: Ticket) => Promise<A>,
    options: {
      readonly mutation?: boolean;
      readonly charge?: boolean | "host-read";
      /** Opening or closing a tab is independent of the selected page's document. */
      readonly anyPage?: boolean;
      readonly mutationScope?: () => ObservationScope;
      readonly preflight?: Effect.Effect<void, BrowserError>;
    } = {},
  ) =>
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
            await getDriver().pageControl?.checkTarget(undefined, ticket);
          await requireReady(operation, ticket);

          return action(getDriver(), ticket);
        }),
      {
        ...options,
        mutationScope: options.mutationScope ?? (() => ({ pageId: getDriver().selected().pageId })),
        preflight: (options.mutation === true && options.anyPage !== true
          ? unreserved(operation)
          : Effect.void
        ).pipe(Effect.andThen(options.preflight ?? Effect.void)),
      },
    );

  const wait = (
    start: (driver: Driver, ticket: WaitTicket, target: DriverTarget) => Promise<void>,
    timeoutMillis?: number,
  ): Effect.Effect<void, BrowserError> =>
    Effect.suspend(() => {
      let owned: OwnedWait | undefined;

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
              const target = driver.selected();
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
            ...(timeoutMillis === undefined ? {} : { timeoutMillis }),
            preflight: Effect.suspend(() =>
              owner.waitAvailable()
                ? unreserved("wait")
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
   * Direct operations resolve selection under admission. Retained operations capture selection
   * and generation; pinned operations capture generation and their explicit page/frame only.
   */
  const makeOperations = (retained?: {
    readonly generation: number;
    readonly selection?: number;
    readonly target?: DriverTarget;
  }) => {
    const browserTarget = retained?.target;

    const check = () => {
      if (
        retained !== undefined &&
        (owner.state.generation !== retained.generation ||
          (retained.selection !== undefined && owner.state.selection !== retained.selection))
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
      action: (driver: Driver, ticket: Ticket) => Promise<A>,
      mutation = false,
    ) =>
      owner.guard(
        operation,
        (ticket) =>
          native(operation, ticket, async () => {
            await getDriver().pageControl?.checkTarget(browserTarget, ticket);
            await requireReady(operation, ticket, browserTarget);

            return action(getDriver(), ticket);
          }),
        {
          mutation,
          mutationScope: () => ({ pageId: browserTarget?.pageId ?? getDriver().selected().pageId }),
          preflight: mutation
            ? Effect.suspend(check).pipe(Effect.andThen(unreserved(operation, browserTarget)))
            : Effect.suspend(check),
        },
      );

    const operationTarget = () =>
      retained?.target === undefined
        ? capture.target()
        : Target.make({
            generation: retained.generation,
            pageId: retained.target.pageId,
            frameId: retained.target.frameId,
          });

    /**
     * Native input, stamped on the host monotonic clock that stamps captured frames, around
     * the native command alone: admission and readiness are over before the clock is read.
     */
    const input = (
      operation: BrowserOperation,
      action: (driver: Driver, ticket: Ticket) => Promise<NativeInput>,
    ) =>
      run(
        operation,
        async (driver, ticket) => {
          // What the input is sent to, read first: input may replace the document it reaches.
          const target = operationTarget();
          const startedMonotonicNanos = clock.monotonicTimeNanosUnsafe();
          const dispatched = await action(driver, ticket);

          return {
            ...dispatched,
            target,
            startedMonotonicNanos,
            completedMonotonicNanos: clock.monotonicTimeNanosUnsafe(),
          };
        },
        true,
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
    ) {
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
        async (driver, ticket) => {
          const target = operationTarget();

          const loadingStarted = Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000;
          const remainingLifetime = owner.lifetimeDeadline - loadingStarted;

          if (remainingLifetime <= 0)
            throw BrowserError.make({
              operation: "navigate",
              reason: Reasons.Expired.make({}),
              outcome: "undispatched",
            });

          const loadingTimeout = Math.min(timeoutMillis, remainingLifetime);

          const navigation = await driver.beginNavigation(
            url,
            loadingTimeout,
            ticket,
            browserTarget,
            control,
          );

          return {
            target,
            navigation,
            reservation: owner.reserve(navigation.pageId),
            recoveryDeadline: Math.min(
              loadingStarted + loadingTimeout + 3000,
              owner.lifetimeDeadline,
            ),
          };
        },
        true,
      );

      const { navigation, reservation } = begun;
      const outcome = yield* Deferred.make<string, BrowserError>();
      const timeoutRecovery = yield* Deferred.make<boolean>();
      let stopDispatched = false;
      let timedOut = false;
      let deciding = false;

      const failed = (reason: BrowserError["reason"]) =>
        Effect.fail(BrowserError.make({ operation: "navigate", reason, outcome: "unknown" }));

      /**
       * A navigation has exactly one outcome, and whoever decides it first settles the
       * reservation. It is released before anyone waiting is told, so the operation a waiter
       * runs next is admitted rather than finding its own page still reserved.
       */
      const decide = (result: Effect.Effect<string, BrowserError>, known: boolean) => {
        if (deciding || Deferred.isDoneUnsafe(outcome)) return;
        deciding = true;
        active = false;
        reservation.settle(known ? "known" : "unknown");
        Deferred.doneUnsafe(outcome, result);
        Deferred.doneUnsafe(timeoutRecovery, Effect.succeed(false));
        deciding = false;
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
        }),
      );

      const stop = yield* makeNavigationStopCoordinator(
        () => Deferred.isDoneUnsafe(outcome),
        (onDispatch, retainSetup, deadline) =>
          owner.guard(
            "navigate-stop",
            (ticket) =>
              Effect.suspend(() =>
                deadline !== undefined && stopSetupPending !== undefined
                  ? Deferred.await(stopSetupPending)
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
                        if (stopSetupPending !== undefined)
                          throw BrowserError.make({
                            operation: "navigate-stop",
                            reason: Reasons.Busy.make({}),
                            outcome: "undispatched",
                          });
                        const setup = Deferred.makeUnsafe<void>();

                        stopSetupPending = setup;
                        const retired = retainSetup();

                        return () => {
                          if (stopSetupPending === setup) stopSetupPending = undefined;
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
              mutationScope: () => ({ pageId: navigation.pageId }),
              charge: false,
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
      navigate: (url: string, timeoutMillis?: number) =>
        Effect.scoped(
          startNavigation(url, timeoutMillis).pipe(
            Effect.flatMap((operation) => operation.completed),
          ),
        ),
      readText: (selector?: string) =>
        run("read-text", (driver, ticket) =>
          driver.readText(selector, options.maxReturnedBytes, ticket, browserTarget),
        ),
      click: (target: string | ObservedElement, policy?: AdmissionPolicy) =>
        run("click", (driver, ticket) => driver.click(target, ticket, policy, browserTarget), true),
      fill: (target: string | ObservedElement, value: string, policy?: AdmissionPolicy) =>
        run(
          "fill",
          (driver, ticket) => driver.fill(target, value, ticket, policy, browserTarget),
          true,
        ),
      scroll: (x: number, y: number) =>
        run("scroll", (driver, ticket) => driver.scroll(x, y, ticket, browserTarget), true),
      pointerMove: (to: NativePoint) =>
        input("pointer-move", (driver, ticket) => driver.pointerMove(to, ticket, browserTarget)),
      hover: (target: string | ObservedElement, policy?: AdmissionPolicy) =>
        input("hover", (driver, ticket) => driver.hover(target, ticket, policy, browserTarget)),
      wheel: (deltaX: number, deltaY: number, at?: NativePoint) =>
        input("wheel", (driver, ticket) => driver.wheel(deltaX, deltaY, at, ticket, browserTarget)),
      press: (
        key: string,
        modifiers: ReadonlyArray<KeyModifier>,
        into?: string | ObservedElement,
        policy?: AdmissionPolicy,
      ) =>
        input("press", (driver, ticket) =>
          driver.press(key, modifiers, into, ticket, policy, browserTarget),
        ),
      type: (text: string, into?: string | ObservedElement, policy?: AdmissionPolicy) =>
        input("type", (driver, ticket) => driver.type(text, into, ticket, policy, browserTarget)),
      screenshot: (full: boolean) =>
        run("screenshot", (driver, ticket) =>
          driver.screenshot(full, options.maxReturnedBytes, ticket, browserTarget),
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
                getDriver().selected();
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

  const pinned = (resolve: (driver: Driver, ticket: Ticket) => Promise<DriverTarget>) =>
    owner.guard(
      "target",
      (ticket) =>
        native("target", ticket, async () => {
          const value = await resolve(getDriver(), ticket);

          ticket.check();

          return {
            target: Target.make({ generation: ticket.generation, ...value }),
            operations: makeOperations({ generation: ticket.generation, target: value }),
          };
        }),
      { charge: false },
    );

  const retain = owner.guard(
    "target",
    () =>
      Effect.try({
        try: () => {
          const target = capture.target();

          return makeOperations({
            generation: target.generation,
            selection: owner.state.selection,
          });
        },
        catch: (error) =>
          publicError(error, "target", {
            reason: Reasons.Closed.make({}),
            outcome: "undispatched",
          }),
      }),
    { charge: false },
  );

  const controls = {
    implementation: options.implementation,
    status: owner.status,
    diagnostics: owner.diagnostics,
    pageControl: {
      state: (page: PageInfo) =>
        nativeOperation("page-state", (_driver, ticket) => execution().state(page, ticket), {
          charge: false,
        }),
      suspend: (page: PageInfo) =>
        nativeOperation("page-suspend", (_driver, ticket) => execution().suspend(page, ticket), {
          charge: false,
          preflight: waitFree("page-suspend", page.pageId),
        }),
      resume: (receipt: PageSuspension) =>
        nativeOperation("page-resume", (_driver, ticket) => execution().resume(receipt, ticket), {
          charge: false,
          preflight: waitFree("page-resume", receipt.pageId),
        }),
    },
    reference: ref,
    capture,
    operations: makeOperations(),
    retain,
    target: readSelected,
    cleanupResult,
    close: release.pipe(Effect.tap(() => retireControl)),
    closeChecked: acquired.closeChecked.pipe(Effect.onExit(() => retireControl)),
    observe: (reading: Reading = { scope: "document" }) =>
      textBudget("observe", reading.maxTextBytes).pipe(
        Effect.flatMap((bytes) =>
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
              ),
            { preflight: waitFree("observe") },
          ),
        ),
      ),
    /**
     * Passive: not a mutation, so the action observation and the selection are left exactly as
     * they were. A held page is refused rather than woken to be read.
     */
    checkpoint: (reading: Omit<Reading, "scope"> & { readonly picture: boolean }) =>
      textBudget("checkpoint", reading.maxTextBytes).pipe(
        Effect.flatMap((bytes) =>
          nativeOperation(
            "checkpoint",
            async (driver, ticket) => {
              const target = capture.target();
              const revision = owner.state.revision;
              const startedMonotonicNanos = clock.monotonicTimeNanosUnsafe();

              const sampled = await driver.checkpoint(
                bytes,
                reading.maxControls ?? 32,
                reading.picture ? options.maxReturnedBytes : undefined,
                ticket,
              );

              return {
                ...sampled,
                target,
                revision,
                startedMonotonicNanos,
                completedMonotonicNanos: clock.monotonicTimeNanosUnsafe(),
              };
            },
            { charge: "host-read" },
          ),
        ),
      ),
    controlFacts: (reference: ObservedElement) =>
      nativeOperation("control-facts", (driver, ticket) => driver.controlFacts(reference, ticket), {
        charge: "host-read",
      }),
    selectOption: (reference: ObservedElement, options: SelectOptions, policy?: AdmissionPolicy) =>
      nativeOperation(
        "select-option",
        (driver, ticket) => driver.selectOption(reference, options, ticket, policy),
        { mutation: true },
      ),
    /**
     * Each step is its own admitted, charged mutation that leaves the observation usable for the
     * next one; anything else that changes the page still retires it. The form ends at the first
     * refusal, and whatever it dispatched retires the observation when it ends, however it ends.
     */
    fillForm: (request: FillFormRequest, policy: AdmissionPolicy | undefined, form: FormSettings) =>
      Effect.suspend(() => {
        // The page whose observation the steps kept usable, known once one of them dispatched.
        let pageId: string | undefined;

        const reference = (elementId: string): ObservedElement => ({
          observationId: request.observationId,
          elementId,
        });

        const kept = (): ObservationScope => {
          pageId ??= getDriver().selected().pageId;

          return "none";
        };

        const body = Effect.gen(function* () {
          const fields: Array<{ elementId: string; status: "set" | "unchanged" }> = [];
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
                (driver, ticket) =>
                  driver.formStep(
                    reference(field.elementId),
                    field,
                    ticket,
                    policy,
                    form.settleMillis,
                  ),
                { mutation: true, mutationScope: kept },
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

            fields.push({ elementId: field.elementId, status: step.status });
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
                  ),
                { charge: false },
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
              (driver, ticket) => driver.formSubmit(reference(submit), ticket, policy),
              { mutation: true },
            ),
          );

          if (Exit.isFailure(exit)) {
            const error = Cause.findErrorOption(exit.cause);

            if (Option.isNone(error)) return yield* Effect.failCause(exit.cause);

            return stop("submit", error.value, submit);
          }
          url = exit.value;

          return finish(true);
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
    revalidate: (reference: ObservedElement) =>
      nativeOperation("revalidate", (driver, ticket) => driver.revalidate(reference, ticket), {
        charge: false,
      }),
    // Inspecting readiness is not an action: it charges nothing and mutates nothing.
    readiness: owner.guard(
      "ready",
      (ticket) => native("ready", ticket, () => getDriver().documentReadiness(ticket)),
      { charge: false },
    ),
    pages: nativeOperation("list-pages", (driver, ticket) => driver.listPages(ticket), {
      charge: false,
    }),
    frames: nativeOperation("list-frames", (driver, ticket) => driver.listFrames(ticket), {
      charge: false,
    }),
    framesOf: (page: PageInfo) =>
      nativeOperation("list-frames", (driver, ticket) => driver.listFrames(ticket, page), {
        charge: false,
      }),
    pinPage: (page: PageInfo) => pinned((driver, ticket) => driver.resolvePage(page, ticket)),
    pinFrame: (page: PageInfo, frame: FrameInfo) =>
      pinned((driver, ticket) => driver.resolveFrame(page, frame, ticket)),
    selectPage: (page: PageInfo) =>
      nativeOperation(
        "select-page",
        async (driver, ticket) => {
          await driver.selectPage(page, ticket);
          owner.state.selection++;
        },
        { charge: false },
      ),
    selectFrame: (id: string) =>
      nativeOperation(
        "select-frame",
        async (driver, ticket) => {
          await driver.selectFrame(id, ticket);
          owner.state.selection++;
        },
        { charge: false },
      ),
    createPage: () =>
      nativeOperation("new-page", (driver, ticket) => driver.newPage(ticket), {
        mutation: true,
        mutationScope: () => "none",
        charge: false,
        anyPage: true,
      }),
    closePage: (page: PageInfo) =>
      nativeOperation("close-page", (driver, ticket) => driver.closePage(page, ticket), {
        mutation: true,
        mutationScope: () => ({ pageId: page.pageId }),
        charge: false,
        anyPage: true,
      }),
    resize: (viewport: Viewport) =>
      nativeOperation("resize", (driver, ticket) => driver.resize(viewport, ticket), {
        mutation: true,
        charge: false,
      }),
    waitFor: (selector: string, state: "visible" | "hidden" | "attached" | "detached") =>
      wait((driver, ticket, target) => driver.waitFor(selector, state, ticket, target)),
    waitForElement: (request: WaitForElementRequest) =>
      wait(
        (driver, ticket, target) =>
          driver.waitForElement(request.reference, request.state, ticket, target),
        request.timeoutMillis,
      ),
    clickAndWait: (target: string | ObservedElement) =>
      nativeOperation("click-and-wait", (driver, ticket) => driver.clickAndWait(target, ticket), {
        mutation: true,
      }),
    clickForDownload: (target: string | ObservedElement) =>
      nativeOperation(
        "download-action",
        (driver, ticket) => driver.clickForDownload(target, ticket),
        { mutation: true },
      ),
    selectFiles: (target: string | ObservedElement, files: ReadonlyArray<NativeFileSelection>) =>
      nativeOperation(
        "select-files",
        (driver, ticket) => driver.selectFiles(target, files, ticket),
        { mutation: true },
      ),
    clickForFileSelection: (
      target: string | ObservedElement,
      files: ReadonlyArray<NativeFileSelection>,
    ) =>
      nativeOperation(
        "file-chooser",
        (driver, ticket) => driver.clickForFileSelection(target, files, ticket),
        { mutation: true },
      ),
    liveView: <A>(issue: Effect.Effect<A, BrowserError>) =>
      owner.guard("live-view", () => issue, { charge: false, phases: ["open", "paused"] }),
    beginHandoff: <A>(issue: Effect.Effect<A, BrowserError>) =>
      owner.guard(
        "handoff",
        () =>
          Effect.gen(function* () {
            if (options.driver.pageControl)
              return yield* BrowserError.make({
                operation: "handoff",
                reason: Reasons.Unsupported.make({}),
                outcome: "undispatched",
              });
            // Drawn before the fence, so the pause and the token that ends it commit together.
            const token = handoffToken ?? (yield* uuid);

            if (owner.state.phase === "open") owner.fence("paused", "paused", "handoff");
            handoffToken ??= token;
            // A refused authorization leaves automation paused until explicit operator release.
            const view = yield* issue;

            return { token: Redacted.make(handoffToken), view };
          }),
        { charge: false, phases: ["open", "paused"], verifyAfter: false },
      ),
    resume: (token: Redacted.Redacted<string>, operatorReleasedControl: boolean) =>
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
            const observation = yield* observeInside(ticket, undefined, undefined, false);

            // This synchronous commit remains under the same permit as the fresh observation.
            owner.transition("open");
            handoffToken = undefined;

            return observation;
          }),
        { charge: false, phases: ["paused"], verifyAfter: false },
      ),
    detach: owner
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
            reconnectTarget = yield* native("detach", ticket, () => getDriver().selectedTargetId());
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
            if (Exit.isFailure(disconnected)) return yield* Effect.failCause(disconnected.cause);

            return { reference: ref, targetId: reconnectTarget };
          }),
        { charge: false, verifyAfter: false },
      )
      .pipe(Effect.onError(() => Effect.sync(() => owner.fence("uncertain", "uncertain")))),
    reconnect: (operatorReleasedControl: boolean) =>
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
              const observation = yield* observeInside(ticket, undefined, undefined, false);

              owner.transition("open");

              return observation;
            }),
          { charge: false, phases: ["detached", "acquiring"], verifyAfter: false },
        )
        .pipe(
          Effect.onError(() => closeScope),
          Effect.onInterrupt(() => closeScope),
        ),
  };

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
