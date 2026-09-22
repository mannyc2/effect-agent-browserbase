import { Clock, Deferred, Effect, Exit, Redacted, Schema, Scope } from "effect";

import {
  type FrameInfo,
  type KeyModifier,
  Observation,
  type ObservedElement,
  type PageInfo,
  type PageSuspension,
  Target,
  type Viewport,
} from "../../BrowserData.ts";
import type { Lifetime, Source } from "../../BrowserRuntime.ts";
import { BrowserError, type BrowserOperation } from "../../Errors.ts";
import { type CaptureParent } from "./Association.ts";
import type { BindingImplementation } from "./Binding.ts";
import type { ConnectionBindings } from "./Bindings.ts";
import type { ConnectionCleanup, ConnectionState } from "./ConnectionCleanup.ts";
import type {
  Driver,
  DriverEvents,
  DriverOptions,
  DriverTarget,
  NativeFileSelection,
} from "./Driver.ts";
import { publicError } from "./NativeCalls.ts";
import type { AdmissionPolicy } from "./Observation.ts";
import { makeOwner, native, type Limits, type Ticket } from "./Owner.ts";
import type { NativeInput, NativePoint } from "./Pointer.ts";

export type SessionLease = Lifetime;
export type RemoteSource<L extends SessionLease, E, R = never> = Source<L, E, R>;

/** Bounds a reading of the selected document. Already validated at the public boundary. */
export interface Reading {
  readonly scope: "document" | "viewport";
  readonly maxTextBytes?: number;
  readonly maxControls?: number;
}

/** One public stop capability: its first Exit, including interruption, is the only native attempt. */
export const makeNavigationStop = <E, R>(
  done: () => boolean,
  attempt: Effect.Effect<"dispatched" | "settled", E, R>,
  confirmed: () => void,
) =>
  Effect.cached(
    Effect.suspend(() =>
      done()
        ? Effect.void
        : attempt.pipe(
            Effect.tap((result) =>
              result === "dispatched" ? Effect.sync(confirmed) : Effect.void,
            ),
            Effect.asVoid,
          ),
    ),
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
    onFault: () => void,
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
      reason: "configuration",
      outcome: "undispatched",
    });
  const parentScope = yield* Scope.Scope;
  // Register the binding lifetime BEFORE the remote cleanup finalizer. On natural Scope
  // shutdown that finalizer must fence the owner before any callback finalizer can reenter it.
  const bindingLifetime = yield* Scope.fork(parentScope, "sequential");
  const ended = yield* Deferred.make<void>();
  const owner = yield* makeOwner(limits);
  const clock = yield* Clock.Clock;

  let driver: Driver | undefined;
  let connectPending = false;
  // Native listeners can outlive disconnect. Authority belongs to this connection
  // lease, not merely to the current session phase or selected browser target.
  let activeConnection: object | undefined;
  let handoffToken: string | undefined;
  let reconnectTarget: string | undefined;
  let activeBindings: ConnectionBindings | undefined;

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
      catch: () => BrowserError.make({ operation: "close", reason: "provider" }),
    }).pipe(Effect.exit);

    if (Exit.isFailure(callbacks)) return yield* Effect.failCause(callbacks.cause);
    if (Exit.isFailure(registrations)) return yield* Effect.failCause(registrations.cause);
  });

  const capture: CaptureParent = {
    owner,
    target: () => {
      if (driver === undefined) throw BrowserError.make({ operation: "target", reason: "closed" });

      return Target.make({ generation: owner.state.generation, ...driver.selected() });
    },
    resolve: (ticket, requested) =>
      native("capture-start", ticket, async () => {
        if (driver === undefined)
          throw BrowserError.make({ operation: "capture", reason: "closed" });
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

  owner.onInvalidate((reason) => {
    driver?.invalidateObservation();
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
        catch: () => BrowserError.make({ operation: "disconnect", reason: "provider" }),
      }).pipe(Effect.as<ConnectionState>("closed"));
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          owner.state.phase = "closed";
        }),
      ),
    ),
  };

  const acquired = yield* options.remote(local, owner.lifetimeDeadline);

  const ref: L["reference"] = acquired.reference;
  const release: L["release"] = acquired.release;
  const cleanupResult: L["cleanupResult"] = acquired.cleanupResult;

  const closeScope = acquired.release.pipe(
    Effect.ensuring(Deferred.succeed(ended, undefined)),
    Effect.asVoid,
  );

  const connectionEvents = (connectionLease: object): DriverEvents => ({
    invalidate: (reason) => {
      if (activeConnection === connectionLease) owner.invalidate(reason);
    },
    disconnected: () => {
      if (activeConnection !== connectionLease) return;
      if (
        owner.state.phase !== "closing" &&
        owner.state.phase !== "closed" &&
        owner.state.phase !== "detached"
      ) {
        owner.fence("uncertain", "disconnected");
      }
    },
    pause: () => {
      if (activeConnection !== connectionLease) return;
      if (owner.state.phase === "open") owner.fence("paused", "paused");
      // An unsolicited popup/dialog during setup cannot be silently admitted by
      // the later connect commit. No usable handle has been exposed: fail closed.
      else if (owner.state.phase === "acquiring") owner.fence("uncertain", "uncertain");
    },
    fault: () => {
      if (activeConnection !== connectionLease) return;
      if (owner.state.phase !== "closing" && owner.state.phase !== "closed")
        owner.fence("uncertain", "uncertain");
    },
  });

  const connectNative = (url: Redacted.Redacted<unknown>, nativeOptions: DriverOptions) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const connectionLease = {};

        activeConnection = connectionLease;
        connectPending = true;
        const events = connectionEvents(connectionLease);

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
          ["closing", "closed", "uncertain"].includes(owner.state.phase);

        if (retired()) {
          bindings?.close();
          yield* bindings?.dispose ?? Effect.void;

          return yield* BrowserError.make({ operation: "connect", reason: "closed" });
        }

        const acquired = yield* restore(
          engine.connect({
            connection: Redacted.value(url),
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
          owner.state.phase === "uncertain"
        ) {
          yield* Effect.tryPromise({
            try: () => acquired.disconnect(),
            catch: () => BrowserError.make({ operation: "connect", reason: "provider" }),
          }).pipe(Effect.ignore);
          driver = undefined;

          return yield* BrowserError.make({ operation: "connect", reason: "closed" });
        }

        return acquired;
      }),
    );

  const getDriver = () => {
    if (driver === undefined)
      throw BrowserError.make({
        operation: "target",
        reason: "closed",
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
          ? "stale"
          : state.reason === "timeout"
            ? "timeout"
            : "failed",
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
  ) =>
    Effect.suspend(() => {
      const revision = owner.state.revision;

      return native("observe", ticket, async () => {
        await getDriver().pageControl?.checkTarget(undefined, ticket);
        if (dependent) await requireReady("observe", ticket);

        return getDriver().observe(scope, maximumBytes, controls, ticket);
      }).pipe(
        Effect.flatMap((raw) =>
          Effect.gen(function* () {
            if (owner.state.revision !== revision)
              return yield* BrowserError.make({ operation: "observe", reason: "stale" });

            const result = yield* Effect.try({
              try: () => Observation.make({ ...raw, target: capture.target(), revision }),
              catch: (error) => publicError(error, "observe", { reason: "malformed" }),
            });

            const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Observation))(
              result,
            ).pipe(
              Effect.mapError(() =>
                BrowserError.make({ operation: "observe", reason: "malformed" }),
              ),
            );

            if (new TextEncoder().encode(encoded).length > options.maxReturnedBytes) {
              return yield* BrowserError.make({ operation: "observe", reason: "limit" });
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
          BrowserError.make({ operation, reason: "configuration", outcome: "undispatched" }),
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
          BrowserError.make({ operation: "target", reason: "closed", outcome: "undispatched" }),
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

      return pageId !== undefined && owner.reserved(pageId)
        ? Effect.fail(BrowserError.make({ operation, reason: "busy", outcome: "undispatched" }))
        : Effect.void;
    });

  const nativeOperation = <A>(
    operation: BrowserOperation,
    action: (driver: Driver, ticket: Ticket) => Promise<A>,
    options: {
      readonly mutation?: boolean;
      readonly charge?: boolean;
      /** Opening or closing a tab is independent of the selected page's document. */
      readonly anyPage?: boolean;
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
        ...(options.mutation === true && options.anyPage !== true
          ? { preflight: unreserved(operation) }
          : {}),
      },
    );

  /**
   * A selected handle captures selection plus generation. A pinned handle captures only the
   * connection generation and re-resolves its exact page/frame identity on every operation.
   */
  const bind = (browserTarget?: DriverTarget) => {
    const generation = owner.state.generation,
      selection = browserTarget === undefined ? owner.state.selection : undefined;

    const check = () => {
      if (
        owner.state.generation !== generation ||
        (selection !== undefined && owner.state.selection !== selection)
      ) {
        return Effect.fail(
          BrowserError.make({ operation: "handle", reason: "stale", outcome: "undispatched" }),
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
          preflight: mutation
            ? Effect.suspend(check).pipe(Effect.andThen(unreserved(operation, browserTarget)))
            : Effect.suspend(check),
        },
      );

    const operationTarget = () =>
      browserTarget === undefined
        ? capture.target()
        : Target.make({
            generation,
            pageId: browserTarget.pageId,
            frameId: browserTarget.frameId,
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
      timeoutMillis = limits.actionTimeoutMillis,
    ) {
      const begun = yield* run(
        "navigate",
        async (driver, ticket) => {
          const target = operationTarget();

          const navigation = await driver.beginNavigation(
            url,
            timeoutMillis,
            ticket,
            browserTarget,
          );

          return { target, navigation, reservation: owner.reserve(navigation.pageId) };
        },
        true,
      );

      const { navigation, reservation } = begun;
      const outcome = yield* Deferred.make<string, BrowserError>();
      let stopDispatched = false;

      const failed = (reason: BrowserError["reason"]) =>
        Effect.fail(BrowserError.make({ operation: "navigate", reason, outcome: "unknown" }));

      /**
       * A navigation has exactly one outcome, and whoever decides it first settles the
       * reservation. It is released before anyone waiting is told, so the operation a waiter
       * runs next is admitted rather than finding its own page still reserved.
       */
      const decide = (result: Effect.Effect<string, BrowserError>, known: boolean) => {
        if (Deferred.isDoneUnsafe(outcome)) return;
        reservation.settle(known ? "known" : "unknown");
        Deferred.doneUnsafe(outcome, result);
      };

      navigation.settled.then(
        (url) => {
          if (!stopDispatched) decide(Effect.succeed(url), true);
        },
        // Failed after dispatch, and nothing says what the browser did: unknown, as it always was.
        (error: unknown) => {
          if (!stopDispatched)
            decide(
              Effect.fail(
                publicError(error, "navigate", { reason: "provider", outcome: "unknown" }),
              ),
              false,
            );
        },
      );
      // A fence already cleared the reservation; this only releases anyone still waiting.
      reservation.signal.addEventListener("abort", () => decide(failed("stale"), true), {
        once: true,
      });
      // Left unsettled, nothing knows what the browser did with it.
      yield* Effect.addFinalizer(() => Effect.sync(() => decide(failed("stale"), false)));

      const stop = yield* makeNavigationStop(
        () => Deferred.isDoneUnsafe(outcome),
        owner.guard(
          "navigate-stop",
          (ticket) =>
            native("navigate-stop", ticket, () =>
              navigation.stop(
                ticket,
                () => !Deferred.isDoneUnsafe(outcome),
                () => {
                  stopDispatched = true;
                },
              ),
            ).pipe(
              Effect.timeoutOrElse({
                duration: Math.min(3000, ticket.remainingMillis()),
                orElse: () =>
                  Effect.fail(BrowserError.make({ operation: "navigate-stop", reason: "timeout" })),
              }),
            ),
          { mutation: true, charge: false },
        ),
        () => decide(failed("interrupted"), true),
      );

      return {
        target: begun.target,
        completed: Deferred.await(outcome),
        /**
         * The browser's acknowledgement is the known outcome. Playwright's own promise is not
         * waited for: an aborted parse fires no DOMContentLoaded, so it only ever times out.
         */
        stop,
      };
    });

    return {
      startNavigation,
      // The same machinery, scoped to the call: leaving it unsettled fences, as it always has.
      navigate: (url: string) =>
        Effect.scoped(
          startNavigation(url).pipe(Effect.flatMap((operation) => operation.completed)),
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
      Effect.mapError((error) => BrowserError.make({ operation, reason: error.reason })),
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
                owner.state.phase = "open";
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
        reason: "unsupported",
        outcome: "undispatched",
      });

    return port;
  };

  const pinned = (target: Effect.Effect<DriverTarget, BrowserError>) =>
    target.pipe(
      Effect.map((value) => ({
        target: Target.make({
          generation: owner.state.generation,
          pageId: value.pageId,
          frameId: value.frameId,
        }),
        bound: bind(value),
      })),
    );

  const controls = {
    implementation: options.implementation,
    pageControl: {
      state: (page: PageInfo) =>
        nativeOperation("page-state", (_driver, ticket) => execution().state(page, ticket), {
          charge: false,
        }),
      suspend: (page: PageInfo) =>
        nativeOperation("page-suspend", (_driver, ticket) => execution().suspend(page, ticket), {
          charge: false,
        }),
      resume: (receipt: PageSuspension) =>
        nativeOperation("page-resume", (_driver, ticket) => execution().resume(receipt, ticket), {
          charge: false,
        }),
    },
    reference: ref,
    capture,
    bind,
    currentTarget: readSelected,
    cleanupResult,
    close: release,
    closeChecked: acquired.closeChecked,
    observe: (reading: Reading = { scope: "document" }) =>
      textBudget("observe", reading.maxTextBytes).pipe(
        Effect.flatMap((bytes) =>
          owner.guard("observe", (ticket) =>
            observeInside(ticket, bytes, reading.maxControls ?? 32, true, reading.scope),
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
          nativeOperation("checkpoint", async (driver, ticket) => {
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
          }),
        ),
      ),
    controlFacts: (reference: ObservedElement) =>
      nativeOperation("control-facts", (driver, ticket) => driver.controlFacts(reference, ticket)),
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
    pinPage: (page: PageInfo) =>
      pinned(
        nativeOperation("target", (driver, ticket) => driver.resolvePage(page, ticket), {
          charge: false,
        }),
      ),
    pinFrame: (page: PageInfo, frame: FrameInfo) =>
      pinned(
        nativeOperation("target", (driver, ticket) => driver.resolveFrame(page, frame, ticket), {
          charge: false,
        }),
      ),
    selectPage: (id: string) =>
      nativeOperation(
        "select-page",
        async (driver, ticket) => {
          await driver.selectPage(id, ticket);
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
        charge: false,
        anyPage: true,
      }),
    closePage: (id: string) =>
      nativeOperation("close-page", (driver, ticket) => driver.closePage(id, ticket), {
        mutation: true,
        charge: false,
        anyPage: true,
      }),
    resize: (viewport: Viewport) =>
      nativeOperation("resize", (driver, ticket) => driver.resize(viewport, ticket), {
        mutation: true,
        charge: false,
      }),
    waitFor: (selector: string, state: "visible" | "hidden" | "attached" | "detached") =>
      nativeOperation("wait", (driver, ticket) => driver.waitFor(selector, state, ticket)),
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
                reason: "unsupported",
                outcome: "undispatched",
              });
            if (owner.state.phase === "open") owner.fence("paused", "paused");
            handoffToken ??= globalThis.crypto.randomUUID();
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
                reason: "authorization",
                outcome: "undispatched",
              });
            }
            yield* native("resume", ticket, () => getDriver().dismissDialogs(ticket));
            const observation = yield* observeInside(ticket, undefined, undefined, false);

            // This synchronous commit remains under the same permit as the fresh observation.
            owner.state.phase = "open";
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
                reason: "unsupported",
                outcome: "undispatched",
              });
            reconnectTarget = yield* native("detach", ticket, () => getDriver().selectedTargetId());
            const attached = getDriver();

            activeConnection = undefined;
            owner.fence("detached", "disconnected");
            const initialization = yield* Effect.exit(disposeBindings);

            const disconnected = yield* Effect.tryPromise({
              try: () => attached.disconnect(),
              catch: () => BrowserError.make({ operation: "detach", reason: "disconnected" }),
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
                  reason: "unsupported",
                  outcome: "undispatched",
                });
              }

              yield* acquired.verifyReconnect;
              owner.state.phase = "acquiring";
              const endpoint = yield* connectionUrl("reconnect");

              yield* connectNative(endpoint, {
                ...options.driver,
                initialTargetId: reconnectTarget,
                newPage: false,
                preserveViewport: true,
              });
              const observation = yield* observeInside(ticket, undefined, undefined, false);

              owner.state.phase = "open";

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
    Effect.flatMap((expired) => (expired ? closeScope : Effect.void)),
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
              reason: "closed",
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

export type BoundControls = ReturnType<SessionControls["bind"]>;
