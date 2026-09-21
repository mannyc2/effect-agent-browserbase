import { Clock, Deferred, Effect, type Option, Redacted, Schema, Scope } from "effect";

import {
  Observation,
  type ObservedElement,
  type PageInfo,
  type PageSuspension,
  Target,
  type Viewport,
} from "../../BrowserData.ts";
import type { CleanupResult } from "../../Cleanup.ts";
import { BrowserbaseClient } from "../../Client.ts";
import type { AllocationError, ContextError, SessionError } from "../../Errors.ts";
import { BrowserError } from "../../Errors.ts";
import type { LaunchRecipe } from "../../Launch.ts";
import type { AllocationAttempt, SessionReference } from "../../References.ts";
import { BrowserbaseSessions } from "../../Sessions.ts";
import { acquireRemote } from "../session/Acquisition.ts";
import { attachRemote } from "../session/Attachment.ts";
import type { LocalCleanup } from "../session/Cleanup.ts";
import type { ContextWriterPermit } from "../session/WriterFacts.ts";
import { type CaptureParent } from "./Association.ts";
import type { Driver, DriverEvents, DriverOptions, NativeFileSelection } from "./Driver.ts";
import { issueLiveView } from "./LiveView.ts";
import { makeOwner, native, type Limits, type Ticket } from "./Owner.ts";
import { connectPlaywright } from "./Playwright.ts";

/**
 * What this owner needs from the remote session it drives, whether it allocated that session
 * or borrowed one. Release authority lives behind `release`, so a borrowed lease cannot
 * accidentally expose one: the lease decides what closing means.
 */
export interface RemoteLease {
  readonly reference: SessionReference;
  readonly attempt?: AllocationAttempt;
  readonly connection: (
    timeoutMillis: number,
  ) => Effect.Effect<Redacted.Redacted<string>, SessionError>;
  readonly release: Effect.Effect<CleanupResult>;
  readonly cleanupResult: Effect.Effect<Option.Option<CleanupResult>>;
}

export type RemoteSource<L extends RemoteLease, E> = (
  local: LocalCleanup,
  lifetimeDeadline: number,
) => Effect.Effect<L, E, BrowserbaseClient | BrowserbaseSessions | Scope.Scope>;

export interface SessionOptions<L extends RemoteLease, E> {
  readonly remote: RemoteSource<L, E>;
  /** Only a keep-alive session may detach and reattach inside this owner. */
  readonly keepAlive: boolean;
  readonly driver: DriverOptions;
  readonly maxReturnedBytes: number;
}

export interface OwnedLease extends RemoteLease {
  readonly attempt: AllocationAttempt;
}

export interface OwnedOptions {
  /** The single provider-faithful launch description; the owner adds no second default body. */
  readonly launch: LaunchRecipe;
  /** Required for a persistent context; the writer permit, not this owner, holds that authority. */
  readonly contextWriter?: ContextWriterPermit;
  readonly onCleanup?: (result: CleanupResult) => Effect.Effect<void>;
  readonly onAllocationUncertain?: (attempt: AllocationAttempt) => Effect.Effect<void>;
}

/** Allocates the session, and therefore owns releasing it. */
export const ownedRemote =
  (
    options: OwnedOptions,
  ): RemoteSource<OwnedLease, AllocationError | BrowserError | ContextError> =>
  (local, lifetimeDeadline) =>
    acquireRemote(
      {
        launch: options.launch,
        ...(options.contextWriter === undefined ? {} : { contextWriter: options.contextWriter }),
        allocationDeadline: lifetimeDeadline,
        ...(options.onCleanup === undefined ? {} : { onCleanup: options.onCleanup }),
        ...(options.onAllocationUncertain === undefined
          ? {}
          : { onAllocationUncertain: options.onAllocationUncertain }),
      },
      local,
    );

/** Borrows a running session: local connection only, and never a release request. */
export const borrowedRemote =
  (options: {
    readonly reference: SessionReference;
    readonly pendingWaitMillis?: number;
    readonly onCleanup?: (result: CleanupResult) => Effect.Effect<void>;
  }): RemoteSource<RemoteLease, SessionError> =>
  (local) =>
    attachRemote(options, local);

export type Connector = (
  connection: unknown,
  signal: AbortSignal,
  options: DriverOptions,
  events: DriverEvents,
) => Promise<Driver>;

/**
 * The one owned browser. Remote allocation, release and terminal observation belong to the
 * canonical control plane; this owner supplies only the local connection's cleanup evidence.
 */
export const acquireSession = Effect.fnUntraced(function* <L extends RemoteLease, E>(
  limits: Limits,
  options: SessionOptions<L, E>,
  connector: Connector = connectPlaywright,
) {
  const client = yield* BrowserbaseClient;
  const sessions = yield* BrowserbaseSessions;
  const parentScope = yield* Scope.Scope;
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

  const capture: CaptureParent = {
    owner,
    target: () => {
      if (driver === undefined) throw BrowserError.make({ operation: "target", reason: "closed" });

      return Target.make({ generation: owner.state.generation, ...driver.selected() });
    },
    resolve: (ticket, requested) =>
      native("capture-source", ticket, async () => {
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
    if (["paused", "disconnected", "uncertain", "closed"].includes(reason))
      for (const lease of capture.captureLeases.values()) lease.invalidate(reason);
  });

  /**
   * The local half of cleanup. Each step is an independent fact for the canonical
   * coordinator, which owns the release request and the terminal status observation.
   */
  const local: LocalCleanup = {
    fence: Effect.sync(() => {
      owner.fence("closing", "closed");
      handoffToken = undefined;
      activeConnection = undefined;
    }),
    capture: Effect.suspend(() =>
      Effect.forEach([...capture.captureLeases.values()], (lease) => lease.stop, {
        discard: true,
      }),
    ),
    initialization: Effect.void,
    disconnect: Effect.suspend(() => {
      const acquired = driver;

      driver = undefined;
      if (acquired === undefined)
        return Effect.succeed<CleanupResult["local"]>(connectPending ? "pending" : "not-connected");

      return Effect.tryPromise({
        try: () => acquired.disconnect(),
        catch: () => BrowserError.make({ operation: "disconnect", reason: "provider" }),
      }).pipe(Effect.as<CleanupResult["local"]>("closed"));
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          owner.state.phase = "closed";
        }),
      ),
    ),
  };

  const acquired = yield* options.remote(local, owner.lifetimeDeadline);

  const ref = acquired.reference;

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

        const acquired = yield* restore(
          Effect.tryPromise({
            try: (signal) => {
              const pending = connector(Redacted.value(url), signal, nativeOptions, events).then(
                async (acquired) => {
                  if (signal.aborted) {
                    await acquired.disconnect().catch(() => {});
                    throw BrowserError.make({ operation: "connect", reason: "interrupted" });
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
              Schema.is(BrowserError)(error)
                ? error
                : BrowserError.make({ operation: "connect", reason: "provider" }),
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
    "click",
    "fill",
    "scroll",
    "screenshot",
    "observe",
    "wait",
    "click-and-wait",
    "download-action",
    "select-files",
    "file-chooser",
  ];

  const requireReady = async (operation: string, ticket: Ticket) => {
    if (!dependent.includes(operation)) return;
    const state = await getDriver().documentReadiness(ticket);

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
  ) =>
    Effect.suspend(() => {
      const revision = owner.state.revision;

      return native("observe", ticket, async () => {
        await getDriver().pageControl?.checkSelected(ticket);
        if (dependent) await requireReady("observe", ticket);

        return getDriver().observe(maximumBytes, controls, ticket);
      }).pipe(
        Effect.flatMap((raw) =>
          Effect.gen(function* () {
            if (owner.state.revision !== revision)
              return yield* BrowserError.make({ operation: "observe", reason: "stale" });

            const result = yield* Effect.try({
              try: () => Observation.make({ ...raw, target: capture.target(), revision }),
              catch: (error) =>
                Schema.is(BrowserError)(error)
                  ? error
                  : BrowserError.make({ operation: "observe", reason: "malformed" }),
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

  const nativeOperation = <A>(
    operation: string,
    action: (driver: Driver, ticket: Ticket) => Promise<A>,
    mutation = false,
    charge = true,
  ) =>
    owner.guard(
      operation,
      (ticket) =>
        native(operation, ticket, async () => {
          if (
            [
              "resize",
              "wait",
              "click-and-wait",
              "download-action",
              "select-files",
              "file-chooser",
            ].includes(operation)
          )
            await getDriver().pageControl?.checkSelected(ticket);
          await requireReady(operation, ticket);

          return action(getDriver(), ticket);
        }),
      { mutation, charge },
    );

  /** A bound handle captures the page selection and connection generation, never the current DOM. */
  const bind = () => {
    const generation = owner.state.generation,
      selection = owner.state.selection;

    const check = () => {
      if (owner.state.generation !== generation || owner.state.selection !== selection) {
        return Effect.fail(
          BrowserError.make({ operation: "handle", reason: "stale", outcome: "undispatched" }),
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
        (ticket) =>
          native(operation, ticket, async () => {
            await getDriver().pageControl?.checkSelected(ticket);
            await requireReady(operation, ticket);

            return action(getDriver(), ticket);
          }),
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

  /**
   * The remaining execution lifetime bounds waiting for a RUNNING session and its endpoint,
   * within the resource service's own maximum wait. A long business budget does not become
   * an invalid provider-wait configuration.
   */
  const remainingMillis = () =>
    Math.min(
      600_000,
      Math.max(
        1,
        Math.ceil(owner.lifetimeDeadline - Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000),
      ),
    );

  const connectionUrl = (operation: string) =>
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

  const controls = {
    pageControl: {
      state: (page: PageInfo) =>
        nativeOperation(
          "page-state",
          (_driver, ticket) => execution().state(page, ticket),
          false,
          false,
        ),
      suspend: (page: PageInfo) =>
        nativeOperation(
          "page-suspend",
          (_driver, ticket) => execution().suspend(page, ticket),
          true,
          false,
        ),
      resume: (receipt: PageSuspension) =>
        nativeOperation(
          "page-resume",
          (_driver, ticket) => execution().resume(receipt, ticket),
          true,
          false,
        ),
    },
    reference: ref,
    capture,
    bind,
    currentTarget: readSelected,
    cleanupResult: acquired.cleanupResult,
    close: acquired.release.pipe(Effect.ensuring(Deferred.succeed(ended, undefined))),
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
          BrowserError.make({
            operation: "observe",
            reason: "configuration",
            outcome: "undispatched",
          }),
        );
      }

      return owner.guard("observe", (ticket) => observeInside(ticket, bytes, controlLimit));
    },
    // Inspecting readiness is not an action: it charges nothing and mutates nothing.
    readiness: owner.guard(
      "ready",
      (ticket) => native("ready", ticket, () => getDriver().documentReadiness(ticket)),
      { charge: false },
    ),
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
    selectFiles: (target: string | ObservedElement, files: ReadonlyArray<NativeFileSelection>) =>
      nativeOperation(
        "select-files",
        (driver, ticket) => driver.selectFiles(target, files, ticket),
        true,
      ),
    clickForFileSelection: (
      target: string | ObservedElement,
      files: ReadonlyArray<NativeFileSelection>,
    ) =>
      nativeOperation(
        "file-chooser",
        (driver, ticket) => driver.clickForFileSelection(target, files, ticket),
        true,
      ),
    liveView: (ttl: number) =>
      owner.guard("live-view", () => issueLiveView(client, ref, ttl), {
        charge: false,
        phases: ["open", "paused"],
      }),
    beginHandoff: (ttl: number) =>
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
            // Failure to mint a view leaves automation paused; there is no finally/resume pair.
            const view = yield* issueLiveView(client, ref, ttl);

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
            yield* Effect.tryPromise({
              try: () => attached.disconnect(),
              catch: () => BrowserError.make({ operation: "detach", reason: "disconnected" }),
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
                return yield* BrowserError.make({
                  operation: "reconnect",
                  reason: "unsupported",
                  outcome: "undispatched",
                });
              }

              const status = yield* sessions
                .retrieve(ref)
                .pipe(
                  Effect.mapError((error) =>
                    BrowserError.make({ operation: "reconnect", reason: error.reason }),
                  ),
                );

              if (status.status !== "RUNNING")
                return yield* BrowserError.make({ operation: "reconnect", reason: "expired" });
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

export type SessionControls =
  Effect.Success<ReturnType<typeof acquireSession>> extends {
    connect: Effect.Effect<infer A, infer _E, infer _R>;
  }
    ? A
    : never;

export type BoundControls = ReturnType<SessionControls["bind"]>;
