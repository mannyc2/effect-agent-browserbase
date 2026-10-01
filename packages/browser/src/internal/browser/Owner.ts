import { Cause, Clock, Deferred, Duration, Effect, Exit, Option, Schema } from "effect";

import type { OperationOptions } from "../../Browser.ts";
import {
  BrowserDiagnostic,
  BrowserDiagnostics,
  type ObservedElement,
  type InputReceipt,
  type AdmissionLimits,
  SessionStatus,
  type SessionReason,
  type SessionPhase,
} from "../../BrowserData.ts";
import {
  BrowserError,
  Reasons,
  type BrowserOperation,
  type BrowserOutcome,
  type BrowserReason,
  type Containment,
} from "../../Errors.ts";
import type { AcknowledgementFact, SettledEvidence } from "../../PlanData.ts";
import type { Correlation } from "../../TimelineData.ts";
import { makeAdmission } from "./Admission.ts";
import type { DriverFault, DriverTarget } from "./Driver.ts";
import { NativeEffectFailure, providerReason, publicError } from "./NativeCalls.ts";
import type { DescriptorSample, ResolvedElement } from "./Observation.ts";
import type { PerformancePlan } from "./Performance.ts";

export interface NativePictureBoundary {
  readonly phase: "Requested" | "Returned";
  readonly target: DriverTarget;
  readonly documentEpoch: number;
  readonly geometry: { readonly width: number; readonly height: number };
  readonly byteLength?: number;
}

/** Bounded metadata observed from the original admission; these callbacks grant no authority. */
export interface TicketObserver {
  readonly phase: (
    phase: Exclude<NonNullable<Ticket["phase"]>, "Terminal">,
    mutation: boolean,
    acknowledgement?: AcknowledgementFact,
  ) => void;
  readonly picture: (boundary: NativePictureBoundary) => void;
  readonly input: (
    receipt: InputReceipt,
    keys?: { readonly count: number; readonly countUnit: "unicode-codepoints" | "logical-strokes" },
  ) => void;
  readonly scroll: (facts: {
    readonly target: DriverTarget;
    readonly x?: number;
    readonly y?: number;
    readonly qualification?: "exact-node-scroll-into-view";
    readonly startedMonotonicNanos: bigint;
    readonly completedMonotonicNanos: bigint;
  }) => void;
  readonly glide: (facts: {
    readonly target: DriverTarget;
    readonly startedMonotonicNanos: bigint;
    readonly samples: ReadonlyArray<{
      readonly offsetMillis: number;
      readonly position: { readonly x: number; readonly y: number };
    }>;
  }) => void;
  readonly settled: (evidence: SettledEvidence, target: DriverTarget) => void;
  readonly finished: (summary: {
    readonly kind: "Completed" | "Failed" | "Cancelled";
    readonly outcome: BrowserOutcome;
    readonly error?: BrowserError;
    readonly containment: Containment;
  }) => void;
}

export type ObserveTicket = (facts: {
  readonly operation: BrowserOperation;
  readonly operationId: string;
  readonly ticket: () => Ticket | undefined;
  readonly generation: number;
  readonly scope: ObservationScope | undefined;
  readonly correlation: () => Correlation | null;
}) => TicketObserver;

/** The browser domain's bounded step: one deadline, one declared BrowserError timeout. */
export const within = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  deadline: number,
  onTimeout: () => BrowserError,
): Effect.Effect<A, E | BrowserError, R> =>
  Effect.gen(function* () {
    const now = Number(yield* Clock.monotonicTimeNanos) / 1_000_000;

    return yield* deadline <= now
      ? Effect.fail(onTimeout())
      : effect.pipe(
          Effect.timeoutOrElse({
            duration: Duration.millis(deadline - now),
            orElse: () => Effect.fail(onTimeout()),
          }),
        );
  });

export type Phase = SessionPhase;

export type Invalidation =
  | "observation"
  | "target-changed"
  | "resized"
  | "paused"
  | "disconnected"
  | "uncertain"
  | "closed";

/**
 * Observation retirement is independent of the owner's revision and connection fences. A frame
 * narrows a page: an observation holds nodes of the one frame it read, so another frame of the
 * page navigating or detaching (an advertisement reloading, say) changes nothing it names.
 */
export type ObservationScope =
  | "all"
  | "none"
  | { readonly pageId: string; readonly frameId?: string };

/** A bounded native reading has no mutation dispatch authority. */
export interface ReadTicket {
  readonly signal: AbortSignal;
  readonly deadline: number;
  readonly generation: number;
  readonly remainingMillis: () => number;
  check(): void;
}

/** One admitted native operation; checks at dispatch also fence late Promise continuations. */
export interface Ticket extends ReadTicket {
  readonly performance?: { readonly plan: PerformancePlan; readonly fieldIndex?: number };
  readonly monotonicTimeNanosUnsafe?: () => bigint;
  /** Exact original-owner time left; native SDK timeouts retain their separate millisecond floor. */
  readonly remainingTimeNanos?: () => bigint;
  /** Original-owner sleep, bounded by this admission and fenced before and after waiting. */
  readonly pauseUntil?: (atNanos: bigint) => Promise<void>;
  readonly operationId?: string;
  readonly picture?: TicketObserver["picture"];
  readonly recordInput?: TicketObserver["input"];
  readonly recordScroll?: TicketObserver["scroll"];
  readonly recordGlide?: TicketObserver["glide"];
  readonly recordSettled?: TicketObserver["settled"];
  /** Native work keeps capacity until settlement, independently of the request fiber. */
  readonly retainNative?: () => () => void;
  readonly dispatched: boolean;
  /** Original phase-aware native outcome; preparatory acknowledgement is not logical success. */
  readonly outcome?: BrowserOutcome;
  readonly phase?: "Prepared" | "Dispatched" | "Acknowledged" | "FollowUp" | "Terminal";
  /** Actual owner's containment, including pure interruption without a typed failure. */
  readonly containment?: Containment;
  dispatch(): void;
  /** Called only for positive completion of all native commands in the current mutation phase. */
  acknowledge?(fact?: AcknowledgementFact): void;
  followUp?(): void;
  /** Facts from the checked node immediately before dispatch; no separate recording read. */
  readonly captureTarget?: (
    target: string | ObservedElement | ResolvedElement,
    sample: DescriptorSample | undefined,
  ) => void;
}

/** Synchronous host evidence from the original ticket, never dispatch authority. */
export interface ExecutionEvidence {
  readonly scroll?: (facts: Parameters<TicketObserver["scroll"]>[0], ticket: Ticket) => void;
  readonly correlation?: () => Correlation | null;
  readonly phase?: (
    phase: NonNullable<Ticket["phase"]>,
    ticket: Ticket,
    acknowledgement?: AcknowledgementFact,
  ) => void;
  readonly target?: NonNullable<Ticket["captureTarget"]>;
}

/** The driver retires native capacity only after its wait and required handle disposal settle. */
export interface WaitTicket extends ReadTicket {
  invalidate(): void;
  retire(): void;
}

export interface OwnedWait {
  readonly ticket: WaitTicket;
  readonly completed: Effect.Effect<void, BrowserError>;
  readonly start: (body: () => Promise<void>) => void;
  readonly cancel: (reason?: BrowserError["reason"]) => void;
}

/**
 * A dispatched mutation the browser is still performing after its permit was released: an
 * in-flight navigation. It keeps other mutations off that page while reads, holds and other
 * pages proceed. Like a permit it cannot be dropped silently: only a known outcome releases it.
 */
export interface Reservation {
  /** Aborted by any fence, so work that outlives its connection is never treated as current. */
  readonly signal: AbortSignal;
  /** `unknown` fences the owner, exactly as a mutation interrupted after dispatch does. */
  readonly settle: (outcome: "known" | "unknown") => void;
}

export interface Limits {
  readonly admissionLimits?: AdmissionLimits;
  readonly maxActions: number;
  readonly maxHostReads: number;
  readonly maxElapsedMillis: number;
  readonly actionTimeoutMillis: number;
}

export const makeOwner = Effect.fnUntraced(function* (limits: Limits) {
  const clock = yield* Clock.Clock;
  let observeTicket: ObserveTicket | undefined;
  let observePhase: ((phase: Phase) => void) | undefined;
  let operationSequence = 0n;

  const lifetimeDeadline =
    Number(yield* Clock.monotonicTimeNanos) / 1_000_000 + limits.maxElapsedMillis;

  const hooks = new Set<
    (reason: Invalidation, scope: ObservationScope, origin?: AbortSignal) => void
  >();

  const state = {
    phase: "acquiring" as Phase,
    generation: 0,
    revision: 0,
    selection: 0,
    actions: 0,
    hostReads: 0,
  };

  let admissionBarrier: object | undefined;
  let nativeConnection: object | undefined;

  const admission = makeAdmission(
    () => Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000,
    () => terminalReason === "expired",
    limits.admissionLimits,
  );

  const waits = () =>
    new Set(
      admission
        .lanes()
        .flatMap((lane) => (lane.native.wait === undefined ? [] : [lane.native.wait])),
    );

  const waitOn = (pageId: string) => admission.pages.get(pageId)?.native.wait;
  // These facts outlive the tickets which produced them. Aborting admission is not retirement.
  const unresolved = new Map<object, string | undefined>();
  let nativeUncertainty = false;
  let terminalReason: SessionReason | null = null;
  let pauseReason: SessionReason | null = null;
  const policies = new Map<object, Extract<DriverFault, { readonly source: "policy" }>>();
  const records: Array<BrowserDiagnostics["records"][number]> = [];
  let total = 0;
  let dropped = 0;

  const record = (
    reason: SessionReason,
    disposition: BrowserDiagnostics["records"][number]["disposition"],
    generation = state.generation,
  ) => {
    total = Math.min(Number.MAX_SAFE_INTEGER, total + 1);
    if (records.length === 32) {
      records.shift();
      dropped = Math.min(Number.MAX_SAFE_INTEGER, dropped + 1);
    }
    records.push(
      Object.freeze(
        BrowserDiagnostic.make({
          reason,
          disposition,
          generation,
          monotonicNanos: clock.monotonicTimeNanosUnsafe(),
        }),
      ),
    );
  };

  /**
   * Why admission refuses work in the owner's present state, or undefined when it would admit it.
   * Both of the guard's admission checks and stale-capability reporting share this one answer,
   * so a pending policy cleanup reports busy only while the session can still recover.
   */
  const refusal = (
    options: {
      readonly phases?: ReadonlyArray<Phase>;
      readonly recovery?: boolean;
      readonly bypassBlocked?: boolean;
    } = {},
  ): BrowserReason | undefined => {
    const blocked = admissionBarrier !== undefined && options.bypassBlocked !== true;

    if (
      (options.phases ?? ["open"]).includes(state.phase) &&
      (policies.size === 0 || options.recovery === true) &&
      (!blocked || options.recovery === true)
    )
      return undefined;

    return terminalReason === "expired"
      ? Reasons.Expired.make({})
      : state.phase === "paused" || blocked || (terminalReason === null && policies.size > 0)
        ? Reasons.Busy.make({})
        : Reasons.Closed.make({});
  };

  const transition = (phase: Phase) => {
    if (
      (terminalReason !== null || state.phase === "closed" || state.phase === "closing") &&
      phase !== "closing" &&
      phase !== "closed"
    )
      return;
    const changed = state.phase !== phase;

    state.phase = phase;
    if (phase === "open") pauseReason = null;
    if (changed) observePhase?.(state.phase);
  };

  const invalidate = (
    reason: Invalidation,
    scope: ObservationScope = "all",
    origin?: AbortSignal,
  ) => {
    for (const waiting of waits())
      if (scope === "all" || (scope !== "none" && scope.pageId === waiting.target.pageId))
        waiting.cancel(Reasons.Stale.make({}));
    for (const lane of admission.pages.values())
      if (scope === "all" || (scope !== "none" && scope.pageId === lane.pageId)) lane.revision++;
    state.revision++;
    for (const hook of hooks) hook(reason, scope, origin);
  };

  const fence = (phase: Phase, reason: Invalidation, trigger?: SessionReason) => {
    if (
      state.phase === "closed" ||
      (state.phase === "closing" && phase !== "closed" && phase !== "closing")
    )
      return;
    if (phase === "uncertain" || phase === "faulted" || phase === "closing" || phase === "closed")
      terminalReason ??= trigger ?? (phase === "uncertain" ? "native-failure" : "closed");
    else if (trigger !== undefined) pauseReason = trigger;
    // A known trigger is retained even when the abort below interrupts dispatched work.
    const previous = state.phase;

    if (!(state.phase === "faulted" && phase === "uncertain")) state.phase = phase;
    state.generation++;
    if (state.phase !== previous) observePhase?.(state.phase);
    const pending: Array<AbortController> = [];

    for (const lane of admission.lanes()) {
      if (lane.reservation === undefined) continue;
      pending.push(lane.reservation);
      lane.reservation = undefined;
    }

    const refusal =
      terminalReason === "expired" ? Reasons.Expired.make({}) : Reasons.Stale.make({});

    admission.fence(refusal);
    for (const waiting of waits()) waiting.cancel(refusal);
    for (const reservation of pending) reservation.abort();
    invalidate(reason);
  };

  const terminate = (
    reason: SessionReason,
    disposition: "known" | "not-dispatched" | "unknown",
    generation = state.generation,
  ) => {
    if (disposition === "unknown") nativeUncertainty = true;
    record(reason, disposition === "known" ? "confirmed" : disposition, generation);
    fence(
      disposition === "unknown" ? "uncertain" : "faulted",
      disposition === "unknown" ? "uncertain" : "closed",
      reason,
    );
  };

  const expire = () => {
    if (terminalReason !== null || state.phase === "closing" || state.phase === "closed") return;
    terminate("expired", "known");
  };

  /** Quarantine changes admission only; an originating click keeps its own valid ticket. */
  const policy = (
    event: Extract<DriverFault, { readonly source: "policy" }>,
    generation: number,
  ) => {
    if (event.disposition !== "dispatched") record(event.reason, event.disposition, generation);
    const previous = policies.get(event.token);

    switch (event.disposition) {
      case "pending":
        if (previous === undefined && terminalReason === null) policies.set(event.token, event);
        break;
      case "dispatched":
        unresolved.set(event.token, undefined);
        if (previous !== undefined) policies.set(event.token, event);
        break;
      case "confirmed":
        unresolved.delete(event.token);
        policies.delete(event.token);
        break;
      case "unknown":
        // Keep the token so a late acknowledgement may retire it, but never reopen admission.
        unresolved.set(event.token, undefined);
        fence("uncertain", "uncertain", event.reason);
        break;
      case "not-dispatched":
        policies.delete(event.token);
        fence("faulted", "closed", event.reason);
        break;
    }
  };

  /** Taken under the permit that dispatched the work, so nothing can interleave before it. */
  const reserve = (key: string): Reservation => {
    // Outlives the fiber that dispatched it, and must be abortable by a fence from outside it.
    const controller = new AbortController();

    const lane = admission.pages.get(key);

    if (lane === undefined)
      throw BrowserError.make({
        operation: "navigate",
        reason: Reasons.Stale.make({}),
        outcome: "unknown",
      });
    lane.reservation = controller;
    unresolved.set(controller, key);

    return {
      signal: controller.signal,
      settle: (outcome) => {
        // Navigation recovery is bounded by the lifetime, so it can give up at the same instant
        // as the independent lifetime timer. As for an action's timer, that instant is expiry.
        if (
          outcome === "unknown" &&
          lane.reservation === controller &&
          Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000 >= lifetimeDeadline
        )
          expire();
        // A fence already cleared it, and decided the outcome for everything it aborted.
        if (lane.reservation !== controller) return;
        lane.reservation = undefined;
        if (outcome === "known") unresolved.delete(controller);
        else fence("uncertain", "uncertain");
        admission.forget(lane);
      },
    };
  };

  /**
   * Admission transfers a pure wait to an independent deadline and cancellation record. Its
   * logical barrier may end before uncancellable native work; neither is a mutation reservation.
   */
  const beginWait = (
    admitted: Ticket,
    target: DriverTarget,
    connection: object,
    operation: "wait" | "settled" = "wait",
  ): OwnedWait => {
    admitted.check();
    const lane = admission.pages.get(target.pageId);

    if (lane === undefined || lane.native.wait !== undefined)
      throw BrowserError.make({
        operation,
        reason: Reasons.Busy.make({}),
        outcome: "undispatched",
      });
    const controller = new AbortController();
    const result = Deferred.makeUnsafe<void, BrowserError>();
    const generation = admitted.generation;
    const deadline = admitted.deadline;
    let retired = false;
    let started = false;
    let canceled: BrowserError | undefined;

    const error = (reason: BrowserError["reason"]) =>
      BrowserError.make({ operation, reason, outcome: "undispatched" });

    const release = () => {
      if (retired && !record.pending) {
        for (const lane of admission.lanes()) {
          if (lane.native.wait !== record) continue;
          lane.native.wait = undefined;
          admission.forget(lane);
        }
      }
    };

    const complete = (exit: Effect.Effect<void, BrowserError>) => {
      if (!record.pending) return;
      record.pending = false;
      release();
      Deferred.doneUnsafe(result, exit);
    };

    const cancel: OwnedWait["cancel"] = (reason = Reasons.Interrupted.make({})) => {
      if (record.pending) {
        canceled = error(reason);
        complete(Effect.fail(canceled));
      }
      controller.abort();
    };

    const record = {
      connection,
      target: { ...target },
      pending: true,
      cancel,
      retire: () => {
        retired = true;
        release();
      },
    };

    lane.native.wait = record;

    const check = () => {
      const now = Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000;

      if (now >= lifetimeDeadline) expire();
      if (canceled !== undefined) throw canceled;
      if (controller.signal.aborted || state.generation !== generation || state.phase !== "open")
        throw error(Reasons.Stale.make({}));
      if (now >= deadline) throw error(Reasons.Timeout.make({}));
    };

    const ticket: WaitTicket = {
      signal: controller.signal,
      deadline,
      generation,
      remainingMillis: () =>
        Math.max(1, deadline - Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000),
      check,
      invalidate: () => cancel(Reasons.Stale.make({})),
      retire: record.retire,
    };

    const fail = (cause: unknown) => {
      let failure = publicError(cause, operation, {
        reason: Reasons.Provider.make({}),
        outcome: "undispatched",
      });

      try {
        check();
      } catch (current) {
        failure = publicError(current, "wait", failure);
      }
      complete(Effect.fail(failure));
    };

    return {
      ticket,
      cancel,
      completed: within(Deferred.await(result), deadline, () => {
        if (Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000 >= lifetimeDeadline) expire();
        cancel(Reasons.Timeout.make({}));

        return canceled ?? error(Reasons.Timeout.make({}));
      }).pipe(
        Effect.provideService(Clock.Clock, clock),
        Effect.tap(() =>
          Effect.try({
            try: check,
            catch: (cause) =>
              publicError(cause, operation, {
                reason: Reasons.Stale.make({}),
                outcome: "undispatched",
              }),
          }),
        ),
      ),
      start: (body) => {
        if (started) return;
        started = true;
        try {
          check();
          // Observe settlement after cancellation too; the native retire callback owns capacity.
          void body().then(() => {
            try {
              check();
              complete(Effect.void);
            } catch (cause) {
              fail(cause);
            }
          }, fail);
        } catch (cause) {
          record.retire();
          fail(cause);
        }
      },
    };
  };

  const contain = (
    page: { readonly pageId: string; readonly close: Effect.Effect<boolean> } | undefined,
    generation: number,
  ): Effect.Effect<Containment> =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        if (Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000 >= lifetimeDeadline) expire();
        if (page === undefined || state.generation !== generation || state.phase !== "open") {
          fence("uncertain", "uncertain");

          return { _tag: "SessionFenced", generation: state.generation };
        }
        const closed = yield* page.close;

        if (!closed || state.generation !== generation || state.phase !== "open") {
          fence("uncertain", "uncertain");

          return { _tag: "SessionFenced", generation: state.generation };
        }
        const lane = admission.pages.get(page.pageId);
        const reservation = lane?.reservation;

        if (reservation !== undefined) {
          if (lane !== undefined) lane.reservation = undefined;
          unresolved.delete(reservation);
          reservation.abort();
        }
        record("page-contained", "confirmed", generation);

        return { _tag: "PageClosed", pageId: page.pageId, generation };
      }),
    );

  const guard = <A, E, R>(
    operation: BrowserOperation,
    body: (ticket: Ticket) => Effect.Effect<A, E, R>,
    options: {
      readonly charge?: boolean | "host-read";
      readonly mutation?: boolean;
      readonly mutationScope?: () => ObservationScope;
      /** Exact work attribution can remain page-local while a form preserves its observations. */
      readonly targetScope?: () => ObservationScope;
      readonly phases?: ReadonlyArray<Phase>;
      readonly verifyAfter?: boolean;
      readonly preflight?: Effect.Effect<void, BrowserError>;
      /** A request can shorten this operation's policy deadline, never extend it. */
      readonly timeoutMillis?: number;
      readonly admission?: OperationOptions["admission"];
      /** Composite operations retain the deadlines captured by their original caller. */
      readonly operationDeadline?: number;
      readonly queueDeadline?: number;
      readonly evidence?: ExecutionEvidence;
      readonly performance?: Ticket["performance"];
      /** Private recovery admission: one absolute deadline also bounds waiting for this permit. */
      readonly waitUntil?: number;
      /** Recovery and lifecycle cleanup own independent, bounded capacity. */
      readonly recovery?: boolean;
      readonly bypassBlocked?: boolean;
      /**
       * Where this operation's own page can absorb an unknown outcome: the page, and a request
       * that the browser close it, made once the outcome is unknown, which says whether it did.
       * Undefined, or a page that did not close, fences.
       */
      readonly contain?: () =>
        | { readonly pageId: string; readonly close: Effect.Effect<boolean> }
        | undefined;
    } = {},
  ): Effect.Effect<A, E | BrowserError, R> =>
    Effect.suspend(() => {
      const requested = Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000;
      const operationId = (++operationSequence).toString();
      let observedTicket: Ticket | undefined;

      const deadline = Math.min(
        requested +
          Math.min(options.timeoutMillis ?? limits.actionTimeoutMillis, limits.actionTimeoutMillis),
        options.operationDeadline ?? Number.POSITIVE_INFINITY,
        options.waitUntil ?? Number.POSITIVE_INFINITY,
        lifetimeDeadline,
      );

      const queueMillis =
        options.waitUntil !== undefined
          ? Math.max(0, options.waitUntil - requested)
          : options.admission?.queue === undefined
            ? 0
            : Duration.toMillis(options.admission.queue);

      const queueDeadline = options.queueDeadline ?? requested + queueMillis;
      const scope = options.targetScope?.() ?? options.mutationScope?.();

      const observer = observeTicket?.({
        operation,
        operationId,
        generation: state.generation,
        ticket: () => observedTicket,
        scope,
        correlation: options.evidence?.correlation ?? (() => null),
      });

      const pageLane =
        scope !== undefined && scope !== "all" && scope !== "none"
          ? admission.pages.get(scope.pageId)
          : undefined;

      const lane =
        options.recovery === true && pageLane !== undefined
          ? admission.recovery(pageLane, operation)
          : (pageLane ?? admission.registry);

      const pending = {
        token: {},
        operation,
        requestedAt: requested,
        deadline,
        queueDeadline,
        result: Deferred.makeUnsafe<void, BrowserError>(),
        reserved: options.recovery === true,
      };

      const work = Effect.gen(function* () {
        const refused = refusal(options);

        if (refused !== undefined)
          return yield* BrowserError.make({ operation, reason: refused, outcome: "undispatched" });
        yield* options.preflight ?? Effect.void;
        const now = Number(yield* Clock.monotonicTimeNanos) / 1_000_000;

        if (lane.revoked)
          return yield* BrowserError.make({
            operation,
            reason: Reasons.Stale.make({}),
            outcome: "undispatched",
          });
        if (now >= lifetimeDeadline) {
          expire();

          return yield* BrowserError.make({
            operation,
            reason: Reasons.Expired.make({}),
            outcome: "undispatched",
          });
        }

        if (now >= deadline)
          return yield* BrowserError.make({
            operation,
            reason: Reasons.Timeout.make({}),
            outcome: "undispatched",
          });
        if (options.charge !== false) {
          const hostRead = options.charge === "host-read";
          const maximum = hostRead ? limits.maxHostReads : limits.maxActions;
          const observed = hostRead ? state.hostReads : state.actions;

          if (observed >= maximum)
            return yield* BrowserError.make({
              operation,
              reason: Reasons.Limit.make({
                dimension: hostRead ? "host-reads" : "actions",
                maximum,
                observed,
              }),
              outcome: "undispatched",
            });
          if (hostRead) state.hostReads++;
          else state.actions++;
        }
        // The lifecycle fence must actively abort admitted native work outside the current fiber.
        // @effect-diagnostics-next-line abortControllerInEffect:off
        const controller = new AbortController();

        lane.active = { controller, operation };
        let dispatched = false;
        let pending = false;
        let logicalAcknowledged = false;
        let partialAcknowledged = false;
        let phase: NonNullable<Ticket["phase"]> = "Prepared";
        let unknownDecided = false;
        let containment: Containment = { _tag: "NotRequired" };
        const generation = state.generation;
        const allowed = options.phases ?? ["open"];

        const currentOutcome = (fallback: BrowserOutcome = "undispatched"): BrowserOutcome =>
          pending || unknownDecided
            ? "unknown"
            : logicalAcknowledged
              ? "performed"
              : partialAcknowledged
                ? "rejected"
                : fallback;

        const check = () => {
          if (Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000 >= lifetimeDeadline) expire();
          if (
            controller.signal.aborted ||
            state.generation !== generation ||
            !allowed.includes(state.phase)
          ) {
            throw BrowserError.make({
              operation,
              reason: Reasons.Stale.make({}),
              outcome: currentOutcome(),
            });
          }
          if (Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000 >= deadline)
            throw BrowserError.make({
              operation,
              reason: Reasons.Timeout.make({}),
              outcome: currentOutcome(),
            });
        };

        const ticket: Ticket = {
          ...(options.performance === undefined ? {} : { performance: options.performance }),
          monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
          remainingTimeNanos: () =>
            BigInt(Math.floor(deadline * 1_000_000)) - clock.monotonicTimeNanosUnsafe(),
          pauseUntil: async (atNanos) => {
            check();
            if (atNanos >= BigInt(Math.floor(deadline * 1_000_000)))
              throw BrowserError.make({
                operation,
                reason: Reasons.TimingBudgetExceeded.make({}),
                outcome: currentOutcome(),
              });
            const remaining = atNanos - clock.monotonicTimeNanosUnsafe();

            if (remaining > 0n) {
              // oxlint-disable-next-line no-restricted-properties -- the native Promise callback awaits only its captured Clock and carries the original Exit back to Effect
              const exit = await Effect.runPromiseExit(clock.sleep(Duration.nanos(remaining)), {
                signal: controller.signal,
              });

              if (Exit.isFailure(exit)) throw NativeEffectFailure.make({ cause: exit.cause });
            }
            check();
          },
          operationId,
          picture: (boundary) => observer?.picture(boundary),
          recordInput: (receipt, keys) => observer?.input(receipt, keys),
          recordScroll: (facts) => {
            options.evidence?.scroll?.(facts, ticket);
            observer?.scroll(facts);
          },
          recordGlide: (facts) => observer?.glide(facts),
          recordSettled: (evidence, target) => observer?.settled(evidence, target),
          ...(options.evidence?.target === undefined
            ? {}
            : { captureTarget: options.evidence.target }),
          retainNative: () => admission.retainNative(lane, operation, nativeConnection),
          signal: controller.signal,
          deadline,
          generation,
          remainingMillis: () =>
            Math.max(1, deadline - Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000),
          get dispatched() {
            return dispatched;
          },
          get outcome() {
            return currentOutcome();
          },
          get phase() {
            return phase;
          },
          get containment() {
            return containment;
          },
          check,
          dispatch() {
            check();
            if (!dispatched && options.mutation)
              invalidate("observation", options.mutationScope?.() ?? "all", controller.signal);
            dispatched = true;
            pending = true;
            phase = "Dispatched";
            const scope = options.targetScope?.() ?? options.mutationScope?.();

            unresolved.set(
              controller,
              scope !== undefined && scope !== "all" && scope !== "none" ? scope.pageId : undefined,
            );
            options.evidence?.phase?.("Dispatched", ticket);
            observer?.phase("Dispatched", true);
          },
          acknowledge(fact) {
            const mutation = pending;

            pending = false;
            if (
              dispatched &&
              !unknownDecided &&
              !controller.signal.aborted &&
              phase !== "Terminal"
            ) {
              if (fact === undefined || fact.logicalComplete) logicalAcknowledged = true;
              else if (mutation) partialAcknowledged = true;
            }
            if (phase !== "Terminal") phase = "Acknowledged";
            if (!unknownDecided) unresolved.delete(controller);
            options.evidence?.phase?.("Acknowledged", ticket, fact);
            observer?.phase("Acknowledged", mutation, fact);
          },
          followUp() {
            if (phase === "Acknowledged") {
              phase = "FollowUp";
              options.evidence?.phase?.("FollowUp", ticket);
              observer?.phase("FollowUp", false);
            }
          },
        };

        observedTicket = ticket;
        options.evidence?.phase?.("Prepared", ticket);
        observer?.phase("Prepared", false);

        // A revocation freezes the pending attempt synchronously, before a late native
        // acknowledgement can run and before the interrupted Effect resumes its handler.
        const freezeUnknown = () => {
          if (phase !== "Terminal" && pending) unknownDecided = true;
        };

        controller.signal.addEventListener("abort", freezeUnknown, { once: true });

        // Dispatched work this admission gave up on, whose outcome no fence has decided yet.
        let abandoned = false;

        const abandon = () => {
          // The action timer can win the same instant as the independent lifetime timer.
          if (Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000 >= lifetimeDeadline) expire();
          controller.abort();
          if (pending || unknownDecided) {
            unknownDecided = true;
            if (state.generation === generation && state.phase === "open") abandoned = true;
            else {
              if (state.phase === "paused" || state.phase === "acquiring")
                fence("uncertain", "uncertain");
              containment = { _tag: "SessionFenced", generation: state.generation };
            }
          }
        };

        const current = () => state.generation === generation && state.phase === "open";

        /**
         * Work given up after dispatch fences the owner, since nothing knows what it did or
         * whether more of it will land. An operation confined to one page it may close instead
         * closes that page: once the browser confirms it closed, nothing still bound for it can
         * land anywhere, and every other page keeps working. It is still never replayed.
         */
        const settle = Effect.uninterruptible(
          Effect.suspend(() => {
            if (!abandoned) return Effect.void;
            abandoned = false;
            const page = current() ? options.contain?.() : undefined;

            return contain(page, generation).pipe(
              Effect.tap((result) =>
                Effect.sync(() => {
                  containment = result;
                  if (result._tag === "PageClosed") unresolved.delete(controller);
                }),
              ),
            );
          }),
        );

        return yield* within(body(ticket), ticket.deadline, () => {
          abandon();

          return BrowserError.make({
            operation,
            reason: Reasons.Timeout.make({}),
            outcome: currentOutcome(),
          });
        }).pipe(
          Effect.tap(() =>
            options.verifyAfter === false
              ? Effect.void
              : Effect.try({
                  try: check,
                  catch: (error) =>
                    Schema.is(BrowserError)(error)
                      ? error
                      : BrowserError.make({
                          operation,
                          reason: Reasons.Stale.make({}),
                          outcome: currentOutcome(),
                        }),
                }),
          ),
          Effect.catch((error): Effect.Effect<never, E | BrowserError> => {
            const outcome = currentOutcome(
              Schema.is(BrowserError)(error) ? error.outcome : "undispatched",
            );

            if (pending || unknownDecided) abandon();

            // The permit adds dispatch evidence only to browser-operation errors. Typed
            // initialization/consumer failures retain their identity and original family.
            return settle.pipe(
              Effect.andThen(
                Effect.suspend((): Effect.Effect<never, E | BrowserError> =>
                  Schema.is(BrowserError)(error)
                    ? Effect.fail(
                        BrowserError.make({
                          operation,
                          reason: error.reason,
                          outcome,
                          containment:
                            containment._tag === "NotRequired"
                              ? (error.containment ?? containment)
                              : containment,
                        }),
                      )
                    : Effect.fail(error),
                ),
              ),
            );
          }),
          Effect.onExit((exit) =>
            Exit.isFailure(exit) && containment._tag === "NotRequired"
              ? Effect.sync(abandon).pipe(Effect.andThen(settle))
              : Effect.void,
          ),
          Effect.tap(() => Effect.sync(() => unresolved.delete(controller))),
          Effect.onExit((exit) =>
            Effect.sync(() => {
              const failure = Exit.isFailure(exit)
                ? Cause.findErrorOption(exit.cause)
                : Option.none();

              const error =
                Option.isSome(failure) && Schema.is(BrowserError)(failure.value)
                  ? failure.value
                  : undefined;

              observer?.finished({
                kind: Exit.isSuccess(exit)
                  ? "Completed"
                  : Cause.hasInterrupts(exit.cause)
                    ? "Cancelled"
                    : "Failed",
                outcome: currentOutcome(error?.outcome),
                ...(error === undefined ? {} : { error }),
                containment:
                  containment._tag === "NotRequired"
                    ? (error?.containment ?? containment)
                    : containment,
              });
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              phase = "Terminal";
              options.evidence?.phase?.("Terminal", ticket);
              controller.signal.removeEventListener("abort", freezeUnknown);
              controller.abort();
              if (lane.active?.controller === controller) lane.active = undefined;
            }),
          ),
        );
      });

      const checkAdmission = Effect.suspend(() => {
        const refused = refusal(options);

        return refused === undefined
          ? (options.preflight ?? Effect.void)
          : Effect.fail(BrowserError.make({ operation, reason: refused, outcome: "undispatched" }));
      });

      return checkAdmission.pipe(
        Effect.andThen(
          Effect.uninterruptibleMask((restore) =>
            Effect.suspend(() =>
              restore(
                within(
                  admission.acquire(
                    lane,
                    pending,
                    options.recovery === true &&
                      (operation !== "navigate-stop" || options.waitUntil === undefined)
                      ? 0
                      : queueMillis,
                  ),
                  lane.holder === pending.token || queueMillis <= 0
                    ? deadline
                    : Math.min(queueDeadline, deadline),
                  () =>
                    BrowserError.make({
                      operation,
                      reason:
                        Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000 >= lifetimeDeadline
                          ? Reasons.Expired.make({})
                          : deadline <= queueDeadline
                            ? Reasons.Timeout.make({})
                            : Reasons.QueueExpired.make({}),
                      outcome: "undispatched",
                    }),
                ),
              ).pipe(
                Effect.onError(() => Effect.sync(() => admission.cancel(lane, pending))),
                Effect.andThen(restore(work)),
                Effect.ensuring(Effect.sync(() => admission.release(lane, pending.token))),
              ),
            ),
          ),
        ),
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (observedTicket !== undefined) return;

            const failure = Exit.isFailure(exit)
              ? Cause.findErrorOption(exit.cause)
              : Option.none();

            const error =
              Option.isSome(failure) && Schema.is(BrowserError)(failure.value)
                ? failure.value
                : undefined;

            observer?.finished({
              kind: Exit.isSuccess(exit)
                ? "Completed"
                : Cause.hasInterrupts(exit.cause)
                  ? "Cancelled"
                  : "Failed",
              outcome: error?.outcome ?? "undispatched",
              ...(error === undefined ? {} : { error }),
              containment: error?.containment ?? { _tag: "NotRequired" },
            });
          }),
        ),
      );
    }).pipe(Effect.provideService(Clock.Clock, clock));

  /** Lifecycle transitions are performed while holding guard's permit; close alone preempts it. */
  return {
    clock,
    observeTickets: (observer: ObserveTicket) => {
      observeTicket = observer;
    },
    observePhase: (observer: (phase: Phase) => void) => {
      observePhase = observer;
    },
    state,
    lifetimeDeadline,
    guard,
    refusal,
    chargeHostRead: (ticket: Ticket, operation: BrowserOperation) => {
      ticket.check();
      if (state.hostReads >= limits.maxHostReads)
        throw BrowserError.make({
          operation,
          reason: Reasons.Limit.make({
            dimension: "host-reads",
            maximum: limits.maxHostReads,
            observed: state.hostReads,
          }),
          outcome: "undispatched",
        });
      state.hostReads++;
    },
    pageAdmission: admission.page,
    admissionSnapshot: admission.snapshot,
    admissionStatus: Effect.sync(admission.status),
    setConnection: (connection: object) => {
      nativeConnection = connection;
    },
    hasActive: (except?: AbortSignal) =>
      admission
        .lanes()
        .some(
          (lane) =>
            lane.holder !== undefined &&
            (except === undefined || lane.active?.controller.signal !== except),
        ),
    restorePageAdmission: (pageId: string) => {
      const lane = admission.pages.get(pageId);

      if (lane !== undefined) lane.revoked = false;
    },
    revision: (pageId: string) => admission.pages.get(pageId)?.revision ?? state.revision,
    reserve,
    contain,
    pauseAdmission: () => {
      if (admissionBarrier !== undefined) return undefined;
      const token = {};

      admissionBarrier = token;
      admission.blockPending(Reasons.Busy.make({}));

      return token;
    },
    resumeAdmission: (token: object) => {
      if (admissionBarrier !== token) return false;
      admissionBarrier = undefined;

      return true;
    },
    drained: (except?: AbortSignal) =>
      admission.drained(except) &&
      !nativeUncertainty &&
      unresolved.size === 0 &&
      admission.lanes().every((lane) => lane.reservation === undefined) &&
      waits().size === 0 &&
      policies.size === 0,
    reserved: (key: string): boolean => admission.pages.get(key)?.reservation !== undefined,
    revokePage: (pageId: string, except?: AbortSignal) => {
      for (const lane of admission.lanes()) {
        if (lane.pageId !== pageId) continue;
        if (except === undefined || lane.active?.controller.signal !== except)
          admission.revoke(lane, Reasons.Stale.make({}));
        const reservation = lane.reservation;

        lane.reservation = undefined;
        reservation?.abort();
      }
      waitOn(pageId)?.cancel(Reasons.Stale.make({}));
    },
    retirePage: (pageId: string) => {
      const waiting = waitOn(pageId);

      waiting?.cancel(Reasons.Stale.make({}));
      waiting?.retire();
      admission.retirePage(pageId);
      for (const [token, page] of unresolved) if (page === pageId) unresolved.delete(token);
    },
    beginWait,
    waitAvailable: (pageId: string) => waitOn(pageId) === undefined,
    waitPending: (pageId?: string) =>
      pageId === undefined
        ? [...waits()].some((waiting) => waiting.pending)
        : waitOn(pageId)?.pending === true,
    /** Positive retirement is specific to a connection, including a late retired predecessor. */
    retireWait: (connection: object) => {
      admission.retireConnection(connection);
      for (const waiting of waits()) {
        if (waiting.connection !== connection) continue;
        waiting.cancel(Reasons.Stale.make({}));
        waiting.retire();
      }
    },
    invalidate,
    fence,
    get reason() {
      return terminalReason ?? pauseReason;
    },
    transition,
    expire,
    terminate,
    policy,
    record,
    /** Only positive lifetime-source evidence may retire control lost to a connection fence. */
    retireControl: () => {
      for (const waiting of waits()) {
        waiting.cancel(Reasons.Stale.make({}));
        waiting.retire();
      }
      admission.retire();
      unresolved.clear();
      nativeUncertainty = false;
      policies.clear();
    },
    status: Effect.sync(() => {
      const status = SessionStatus.make({
        phase: state.phase,
        reason: terminalReason ?? pauseReason ?? policies.values().next().value?.reason ?? null,
        generation: state.generation,
        busy:
          admission
            .lanes()
            .some((lane) => lane.holder !== undefined || lane.native.work.size > 0) ||
          policies.size > 0 ||
          waits().size > 0,
        unresolvedDispatch: nativeUncertainty || unresolved.size > 0,
        actions: { used: state.actions, maximum: limits.maxActions },
      });

      // Schema construction owns the nested record; freeze the produced snapshot, not its input.
      Object.freeze(status.actions);

      return Object.freeze(status);
    }),
    diagnostics: Effect.sync(() => {
      const snapshot = BrowserDiagnostics.make({
        records: [...records],
        total,
        dropped,
        truncated: dropped > 0,
      });

      // Schema construction owns its array; freeze the produced snapshot, not merely its input.
      for (const record of snapshot.records) Object.freeze(record);
      Object.freeze(snapshot.records);

      return Object.freeze(snapshot);
    }),
    onInvalidate(
      hook: (reason: Invalidation, scope: ObservationScope, origin?: AbortSignal) => void,
    ): () => void {
      hooks.add(hook);

      return () => {
        hooks.delete(hook);
      };
    },
  };
});

export type Owner = Effect.Success<ReturnType<typeof makeOwner>>;

/** Without a native answer, whether the step was sent is all the owner knows about it. */
const unsettled = (ticket: Ticket, error: unknown): Pick<BrowserError, "reason" | "outcome"> => ({
  reason: providerReason(error),
  outcome: ticket.outcome ?? (ticket.dispatched ? "unknown" : "undispatched"),
});

/**
 * The one place a native step becomes a public error: whatever the driver raised, the caller
 * sees the operation it asked for.
 */
export const native = <A>(operation: BrowserOperation, ticket: Ticket, body: () => Promise<A>) =>
  Effect.callback<A, BrowserError>((resume) => {
    let done = false;
    let retire: (() => void) | undefined;

    const cleanup = () => {
      done = true;
      ticket.signal.removeEventListener("abort", abort);
    };

    const abort = () => {
      if (done) return;
      cleanup();
      resume(
        Effect.fail(
          BrowserError.make({
            operation,
            reason: Reasons.Stale.make({}),
            outcome: ticket.outcome ?? (ticket.dispatched ? "unknown" : "undispatched"),
          }),
        ),
      );
    };

    ticket.signal.addEventListener("abort", abort, { once: true });
    try {
      ticket.check();
      retire = ticket.retainNative?.();
      // Observe both branches even after the waiter exits. Cancellation does not undo native work.
      void body().then(
        (value) => {
          retire?.();
          if (!done) {
            cleanup();
            resume(Effect.succeed(value));
          }
        },
        (error: unknown) => {
          retire?.();
          if (!done) {
            cleanup();
            resume(
              Schema.is(NativeEffectFailure)(error)
                ? Effect.failCause(error.cause)
                : Effect.fail(publicError(error, operation, unsettled(ticket, error))),
            );
          }
        },
      );
    } catch (error) {
      retire?.();
      cleanup();
      resume(
        Schema.is(NativeEffectFailure)(error)
          ? Effect.failCause(error.cause)
          : Effect.fail(publicError(error, operation, unsettled(ticket, error))),
      );
    }

    return Effect.sync(cleanup);
  });
