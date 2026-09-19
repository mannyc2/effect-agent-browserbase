import { Clock, Deferred, Effect, Exit, Option, Redacted, Schema, Scope } from "effect";

import {
  AllocationAttempt,
  BrowserbaseError,
  CleanupResult,
  Observation,
  Target,
  type ObservedElement,
  type SessionReference,
  type Viewport,
} from "../Types.ts";
import { type CaptureParent } from "./Association.ts";
import { within } from "./Deadline.ts";
import type { Driver, DriverEvents, DriverOptions } from "./Driver.ts";
import { makeOwner, native, type Limits, type Ticket } from "./Owner.ts";
import { connectPlaywright } from "./Playwright.ts";
import type { Provider, SessionSettings } from "./Provider.ts";

export interface ContextLease {
  /** Quarantine an unconfirmed remote writer. Scope loss alone does not authorize a replacement writer. */
  readonly finalize: (outcome: {
    readonly attempt: AllocationAttempt;
    readonly cleanup: Option.Option<CleanupResult>;
  }) => Effect.Effect<void>;
}

export interface SessionOptions extends SessionSettings {
  readonly driver: DriverOptions;
  readonly maxReturnedBytes: number;
  readonly contextLease?: (request: {
    readonly projectId: string;
    readonly contextId: string;
  }) => Effect.Effect<ContextLease, BrowserbaseError>;
  readonly onCleanup?: (result: CleanupResult) => Effect.Effect<void>;
  readonly onAllocationUncertain?: (attempt: AllocationAttempt) => Effect.Effect<void>;
}

export type Connector = (
  connection: unknown,
  signal: AbortSignal,
  options: DriverOptions,
  events: DriverEvents,
) => Promise<Driver>;

/** Internal owner used by the public adapter; it imports no substitute effect-agent contracts. */
export const acquireSession = Effect.fnUntraced(function* (
  provider: Provider,
  projectId: string,
  limits: Limits,
  options: SessionOptions,
  connector: Connector = connectPlaywright,
) {
  const parentScope = yield* Scope.Scope;
  const resourceScope = yield* Scope.make();
  const ended = yield* Deferred.make<void>();
  const owner = yield* makeOwner(limits);
  const clock = yield* Clock.Clock;

  const attempt = Object.freeze(
    AllocationAttempt.make({
      projectId,
      attemptId: globalThis.crypto.randomUUID(),
      requestedAtMillis: yield* Clock.currentTimeMillis,
      timeoutSeconds: Math.min(21600, Math.max(60, Math.ceil(limits.maxElapsedMillis / 1000))),
    }),
  );

  let reference: SessionReference | undefined;
  let driver: Driver | undefined;
  let connection: Redacted.Redacted<unknown> | undefined;
  let connectPending = false;
  // Native listeners can outlive disconnect. Authority belongs to this connection
  // lease, not merely to the current session phase or selected browser target.
  let activeConnection: object | undefined;
  let cleanup: CleanupResult | undefined;
  let handoffToken: string | undefined;
  let reconnectTarget: string | undefined;
  let allocationReported = false;

  const result = () => Option.fromNullishOr(cleanup);

  const capture: CaptureParent = {
    owner,
    target: () => {
      if (driver === undefined)
        throw BrowserbaseError.make({ operation: "target", reason: "closed" });

      return Target.make({ generation: owner.state.generation, ...driver.selected() });
    },
    resolve: (ticket, requested) =>
      native("capture-source", ticket, async () => {
        if (driver === undefined)
          throw BrowserbaseError.make({ operation: "capture", reason: "closed" });
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
    if (["paused", "disconnected", "uncertain", "closed"].includes(reason))
      for (const lease of capture.captureLeases.values()) lease.invalidate(reason);
  });

  const boundedCleanup = (effect: Effect.Effect<void>, operation: string) =>
    effect.pipe(
      Effect.interruptible,
      Effect.timeoutOrElse({
        duration: 2000,
        orElse: () => Effect.fail(BrowserbaseError.make({ operation, reason: "timeout" })),
      }),
      Effect.exit,
    );

  const terminate = yield* Effect.cached(
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        owner.fence("closing", "closed");
        handoffToken = undefined;
        activeConnection = undefined;
        const leases = [...capture.captureLeases.values()];

        for (const lease of leases) yield* boundedCleanup(lease.stop, "capture-cleanup");
        let local: CleanupResult["local"] = connectPending ? "pending" : "not-connected";
        let remote: CleanupResult | undefined;

        // Provider confirmation is attempted independently of local teardown.
        if (reference !== undefined) {
          const outcome = yield* restore(provider.reconcile(reference)).pipe(Effect.exit);

          remote = Exit.isSuccess(outcome)
            ? outcome.value
            : CleanupResult.make({
                reference,
                releaseRequested: false,
                remote: "unknown",
                local,
                error: BrowserbaseError.make({ operation: "release", reason: "provider" }),
              });
        }
        const acquired = driver;

        driver = undefined;
        if (acquired !== undefined) {
          const exit = yield* restore(
            Effect.tryPromise({
              try: () => acquired.disconnect(),
              catch: () => BrowserbaseError.make({ operation: "disconnect", reason: "provider" }),
            }).pipe(
              Effect.timeoutOrElse({
                duration: 3000,
                orElse: () =>
                  Effect.fail(
                    BrowserbaseError.make({ operation: "disconnect", reason: "timeout" }),
                  ),
              }),
            ),
          ).pipe(Effect.exit);

          local = Exit.isSuccess(exit) ? "closed" : "failed";
        }
        owner.state.phase = "closed";
        if (remote !== undefined) {
          cleanup = CleanupResult.make({ ...remote, local, reporting: "not-configured" });
          if (options.onCleanup !== undefined) {
            const report = yield* boundedCleanup(options.onCleanup(cleanup), "cleanup-report");

            cleanup = CleanupResult.make({
              ...cleanup,
              reporting: Exit.isSuccess(report) ? "reported" : "failed",
            });
          }
        }
      }),
    ),
  );

  const closeScope = yield* Effect.cached(
    Scope.close(resourceScope, Exit.void).pipe(Effect.ensuring(Deferred.succeed(ended, undefined))),
  );

  yield* Scope.addFinalizer(parentScope, closeScope);
  // Lease teardown runs after browser teardown and receives the actual release facts.
  if (options.context?.persist) {
    if (options.contextLease === undefined)
      return yield* BrowserbaseError.make({
        operation: "context",
        reason: "context-lease",
        outcome: "undispatched",
      });
    yield* Effect.acquireRelease(
      options.contextLease({ projectId, contextId: options.context.id }),
      (lease) => lease.finalize({ attempt, cleanup: result() }),
    ).pipe(Effect.provideService(Scope.Scope, resourceScope));
  }
  yield* Scope.addFinalizer(resourceScope, terminate);

  const allocationUnknown = Effect.suspend(() => {
    if (reference !== undefined || allocationReported) return Effect.void;
    allocationReported = true;

    return options.onAllocationUncertain === undefined
      ? Effect.void
      : boundedCleanup(options.onAllocationUncertain(attempt), "allocation-report").pipe(
          Effect.asVoid,
        );
  });

  const created = yield* within(
    provider.create(attempt, options, (known) => {
      reference = Object.freeze(known);
    }),
    owner.lifetimeDeadline,
    "allocate",
  ).pipe(
    Effect.onInterrupt(() => allocationUnknown.pipe(Effect.andThen(closeScope))),
    Effect.onError(() => allocationUnknown.pipe(Effect.andThen(closeScope))),
    Effect.mapError((error) =>
      reference === undefined
        ? BrowserbaseError.make({
            operation: "allocate",
            reason: "allocation-unknown",
            outcome: "unknown",
            ...(error.status === undefined ? {} : { status: error.status }),
          })
        : error,
    ),
  );

  connection = created.connection;
  const ref = created.reference;

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

        const acquired = yield* restore(
          Effect.tryPromise({
            try: (signal) => {
              const pending = connector(Redacted.value(url), signal, nativeOptions, events).then(
                async (acquired) => {
                  if (signal.aborted) {
                    await acquired.disconnect().catch(() => {});
                    throw BrowserbaseError.make({ operation: "connect", reason: "interrupted" });
                  }

                  return acquired;
                },
              );

              const settled = () => {
                if (activeConnection === connectionLease) connectPending = false;
              };

              void pending.then(settled, settled);

              return pending;
            },
            catch: (error) =>
              Schema.is(BrowserbaseError)(error)
                ? error
                : BrowserbaseError.make({ operation: "connect", reason: "provider" }),
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
            catch: () => BrowserbaseError.make({ operation: "connect", reason: "provider" }),
          }).pipe(Effect.ignore);
          driver = undefined;

          return yield* BrowserbaseError.make({ operation: "connect", reason: "closed" });
        }

        return acquired;
      }),
    );

  const getDriver = () => {
    if (driver === undefined)
      throw BrowserbaseError.make({
        operation: "target",
        reason: "closed",
        outcome: "undispatched",
      });

    return driver;
  };

  const observeInside = (
    ticket: Ticket,
    maximumBytes = Math.min(options.maxReturnedBytes, 16384),
    controls = 32,
  ) =>
    Effect.suspend(() => {
      const revision = owner.state.revision;

      return native("observe", ticket, () =>
        getDriver().observe(maximumBytes, controls, ticket),
      ).pipe(
        Effect.flatMap((raw) =>
          Effect.gen(function* () {
            if (owner.state.revision !== revision)
              return yield* BrowserbaseError.make({ operation: "observe", reason: "stale" });

            const result = yield* Effect.try({
              try: () => Observation.make({ ...raw, target: capture.target(), revision }),
              catch: (error) =>
                Schema.is(BrowserbaseError)(error)
                  ? error
                  : BrowserbaseError.make({ operation: "observe", reason: "malformed" }),
            });

            const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Observation))(
              result,
            ).pipe(
              Effect.mapError(() =>
                BrowserbaseError.make({ operation: "observe", reason: "malformed" }),
              ),
            );

            if (new TextEncoder().encode(encoded).length > options.maxReturnedBytes) {
              return yield* BrowserbaseError.make({ operation: "observe", reason: "limit" });
            }

            return result;
          }),
        ),
      );
    });

  // Reading a target is an ownership operation too. A native mutation that times out
  // after dispatch fences the owner as uncertain; retaining the last native target
  // must not manufacture a fresh usable handle in that state.
  const readSelected = owner.guard(
    "target",
    () =>
      Effect.try({
        try: capture.target,
        catch: () =>
          BrowserbaseError.make({ operation: "target", reason: "closed", outcome: "undispatched" }),
      }),
    { charge: false },
  );

  const nativeOperation = <A>(
    operation: string,
    action: (driver: Driver, ticket: Ticket) => Promise<A>,
    mutation = false,
    charge = true,
  ) =>
    owner.guard(
      operation,
      (ticket) => native(operation, ticket, () => action(getDriver(), ticket)),
      { mutation, charge },
    );

  /** A bound handle captures the page selection and connection generation, never the current DOM. */
  const bind = () => {
    const generation = owner.state.generation,
      selection = owner.state.selection;

    const check = () => {
      if (owner.state.generation !== generation || owner.state.selection !== selection) {
        return Effect.fail(
          BrowserbaseError.make({ operation: "handle", reason: "stale", outcome: "undispatched" }),
        );
      }

      return Effect.void;
    };

    const run = <A>(
      operation: string,
      action: (driver: Driver, ticket: Ticket) => Promise<A>,
      mutation = false,
    ) =>
      owner.guard(
        operation,
        (ticket) => native(operation, ticket, () => action(getDriver(), ticket)),
        { mutation, preflight: Effect.suspend(check) },
      );

    return {
      navigate: (url: string) =>
        run("navigate", (driver, ticket) => driver.navigate(url, ticket), true),
      readText: (selector?: string) =>
        run("read-text", (driver, ticket) =>
          driver.readText(selector, options.maxReturnedBytes, ticket),
        ),
      click: (target: string | ObservedElement) =>
        run("click", (driver, ticket) => driver.click(target, ticket), true),
      fill: (target: string | ObservedElement, value: string) =>
        run("fill", (driver, ticket) => driver.fill(target, value, ticket), true),
      scroll: (x: number, y: number) =>
        run("scroll", (driver, ticket) => driver.scroll(x, y, ticket), true),
      screenshot: (full: boolean) =>
        run("screenshot", (driver, ticket) =>
          driver.screenshot(full, options.maxReturnedBytes, ticket),
        ),
    };
  };

  const connected = yield* Effect.cached(
    owner
      .guard(
        "connect",
        (ticket) =>
          connectNative(created.connection, options.driver).pipe(
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

  const controls = {
    reference: ref,
    attempt,
    capture,
    bind,
    currentTarget: readSelected,
    cleanupResult: Effect.sync(result),
    close: closeScope.pipe(
      Effect.andThen(
        Effect.suspend(() =>
          cleanup === undefined
            ? Effect.fail(BrowserbaseError.make({ operation: "close", reason: "malformed" }))
            : Effect.succeed(cleanup),
        ),
      ),
    ),
    observe: (maximumBytes?: number, controlLimit = 32) => {
      const bytes = maximumBytes ?? Math.min(options.maxReturnedBytes, 16384);

      if (
        !Number.isSafeInteger(bytes) ||
        bytes < 1 ||
        bytes > Math.min(options.maxReturnedBytes, 131072) ||
        !Number.isSafeInteger(controlLimit) ||
        controlLimit < 0 ||
        controlLimit > 64
      ) {
        return Effect.fail(
          BrowserbaseError.make({
            operation: "observe",
            reason: "configuration",
            outcome: "undispatched",
          }),
        );
      }

      return owner.guard("observe", (ticket) => observeInside(ticket, bytes, controlLimit));
    },
    pages: nativeOperation(
      "list-pages",
      (driver, ticket) => driver.listPages(ticket),
      false,
      false,
    ),
    frames: nativeOperation(
      "list-frames",
      (driver, ticket) => driver.listFrames(ticket),
      false,
      false,
    ),
    selectPage: (id: string) =>
      nativeOperation(
        "select-page",
        async (driver, ticket) => {
          await driver.selectPage(id, ticket);
          owner.state.selection++;
        },
        false,
        false,
      ),
    selectFrame: (id: string) =>
      nativeOperation(
        "select-frame",
        async (driver, ticket) => {
          await driver.selectFrame(id, ticket);
          owner.state.selection++;
        },
        false,
        false,
      ),
    createPage: () =>
      nativeOperation("new-page", (driver, ticket) => driver.newPage(ticket), true, false),
    closePage: (id: string) =>
      nativeOperation("close-page", (driver, ticket) => driver.closePage(id, ticket), true, false),
    resize: (viewport: Viewport) =>
      nativeOperation("resize", (driver, ticket) => driver.resize(viewport, ticket), true, false),
    waitFor: (selector: string, state: "visible" | "hidden" | "attached" | "detached") =>
      nativeOperation("wait", (driver, ticket) => driver.waitFor(selector, state, ticket)),
    clickAndWait: (target: string | ObservedElement) =>
      nativeOperation(
        "click-and-wait",
        (driver, ticket) => driver.clickAndWait(target, ticket),
        true,
      ),
    clickForDownload: (target: string | ObservedElement) =>
      nativeOperation(
        "download-action",
        (driver, ticket) => driver.clickForDownload(target, ticket),
        true,
      ),
    liveView: (ttl: number) =>
      owner.guard("live-view", () => provider.liveView(ref, ttl), {
        charge: false,
        phases: ["open", "paused"],
      }),
    beginHandoff: (ttl: number) =>
      owner.guard(
        "handoff",
        () =>
          Effect.gen(function* () {
            if (owner.state.phase === "open") owner.fence("paused", "paused");
            handoffToken ??= globalThis.crypto.randomUUID();
            // Failure to mint a view leaves automation paused; there is no finally/resume pair.
            const view = yield* provider.liveView(ref, ttl);

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
              return yield* BrowserbaseError.make({
                operation: "resume",
                reason: "authorization",
                outcome: "undispatched",
              });
            }
            yield* native("resume", ticket, () => getDriver().dismissDialogs(ticket));
            const observation = yield* observeInside(ticket);

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
              return yield* BrowserbaseError.make({
                operation: "detach",
                reason: "unsupported",
                outcome: "undispatched",
              });
            reconnectTarget = yield* native("detach", ticket, () => getDriver().selectedTargetId());
            const acquired = getDriver();

            activeConnection = undefined;
            owner.fence("detached", "disconnected");
            yield* Effect.tryPromise({
              try: () => acquired.disconnect(),
              catch: () => BrowserbaseError.make({ operation: "detach", reason: "disconnected" }),
            });
            driver = undefined;

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
              if (!options.keepAlive || reconnectTarget === undefined || !operatorReleasedControl) {
                return yield* BrowserbaseError.make({
                  operation: "reconnect",
                  reason: "unsupported",
                  outcome: "undispatched",
                });
              }
              const status = yield* provider.metadata(ref);

              if (status.status !== "RUNNING")
                return yield* BrowserbaseError.make({ operation: "reconnect", reason: "expired" });
              owner.state.phase = "acquiring";
              connection = Redacted.make(status.connectUrl);
              yield* connectNative(connection, {
                ...options.driver,
                initialTargetId: reconnectTarget,
                newPage: false,
                preserveViewport: true,
              });
              const observation = yield* observeInside(ticket);

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
    attempt,
    close: controls.close,
    connect: Effect.suspend(() =>
      owner.state.phase === "closed" || owner.state.phase === "closing"
        ? Effect.fail(
            BrowserbaseError.make({
              operation: "connect",
              reason: "closed",
              outcome: "undispatched",
            }),
          )
        : connected.pipe(Effect.as(controls)),
    ),
  };
});

export type SessionControls =
  Effect.Success<ReturnType<typeof acquireSession>> extends {
    connect: Effect.Effect<infer A, infer _E, infer _R>;
  }
    ? A
    : never;

export type BoundControls = ReturnType<SessionControls["bind"]>;
