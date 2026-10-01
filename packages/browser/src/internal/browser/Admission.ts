import { Deferred, Effect } from "effect";

import type { AdmissionStatus } from "../../Browser.ts";
import type { AdmissionLimits } from "../../BrowserData.ts";
import { BrowserError, Reasons, type BrowserOperation } from "../../Errors.ts";
import type { DriverTarget } from "./Driver.ts";

export interface NativeWait {
  readonly connection: object;
  readonly target: DriverTarget;
  readonly cancel: (reason?: BrowserError["reason"]) => void;
  readonly retire: () => void;
  pending: boolean;
}

export interface PendingAdmission {
  readonly token: object;
  readonly operation: BrowserOperation;
  readonly deadline: number;
  readonly requestedAt: number;
  readonly queueDeadline: number;
  readonly result: Deferred.Deferred<void, BrowserError>;
  readonly reserved: boolean;
}

/** Native ownership survives generation changes and caller cancellation. */
export interface NativePageCapacity {
  readonly work: ReadonlySet<object>;
  readonly wait?: NativeWait;
  readonly stopSetupPending?: Deferred.Deferred<void>;
  /** The connection whose positive retirement may release `stopSetupPending`. */
  readonly stopSetupConnection?: object;
}

/**
 * One page's caller ownership and retained native capacity share this record. Callers read it;
 * only admission's own operations change it.
 */
export interface AdmissionLane {
  readonly pageId?: string;
  readonly generation: number;
  readonly pending: ReadonlyArray<PendingAdmission>;
  readonly native: NativePageCapacity;
  readonly revision: number;
  readonly holder?: object;
  readonly active?: {
    readonly controller: AbortController;
    readonly operation: BrowserOperation;
  };
  readonly reservation?: AbortController;
  readonly recovery?: AdmissionLane;
  readonly closure?: AdmissionLane;
  readonly revoked: boolean;
  readonly retired: boolean;
}

interface CapacityState {
  readonly work: Set<object>;
  wait?: NativeWait;
  stopSetupPending?: Deferred.Deferred<void>;
  stopSetupConnection?: object;
}

interface LaneState {
  readonly pageId?: string;
  readonly generation: number;
  readonly pending: Array<PendingAdmission>;
  readonly native: CapacityState;
  revision: number;
  holder?: object;
  active?: { readonly controller: AbortController; readonly operation: BrowserOperation };
  reservation?: AbortController;
  recovery?: LaneState;
  closure?: LaneState;
  revoked: boolean;
  retired: boolean;
}

export const makeAdmission = (
  now: () => number,
  expired: () => boolean,
  limits: AdmissionLimits = {},
  /** Called after work leaves admission, once its bookkeeping is complete. */
  settled: () => void = () => {},
) => {
  const pages = new Map<string, LaneState>();
  const retained = new Set<LaneState>();
  // Every lane this admission made, by identity: callers hold the read-only view of each one.
  const owned = new WeakMap<AdmissionLane, LaneState>();

  const own = (lane: LaneState): LaneState => {
    owned.set(lane, lane);

    return lane;
  };

  const state = (lane: AdmissionLane): LaneState => {
    const found = owned.get(lane);

    if (found === undefined) throw new TypeError("Admission lane belongs to another admission");

    return found;
  };

  const registry = own({
    generation: 0,
    pending: [],
    native: { work: new Set() },
    revision: 0,
    revoked: false,
    retired: false,
  });

  const maximumPage = limits.pendingPerPage ?? 32;
  const maximumSession = limits.pendingPerSession ?? 128;
  const maximumNative = 128;
  let pendingCount = 0;

  const native = new Map<
    object,
    {
      readonly lane: LaneState;
      readonly connection?: object;
      /** Whether this unsettled native call can still change its page. */
      readonly occupies: () => boolean;
    }
  >();

  const error = (operation: BrowserOperation, reason: BrowserError["reason"]) =>
    BrowserError.make({ operation, reason, outcome: "undispatched" });

  /**
   * Native work outlives its caller. Work that dispatched input keeps its page until it settles;
   * a read, or a mutation whose caller left before dispatch, can no longer change the page.
   */
  const occupied = (capacity: CapacityState) =>
    [...capacity.work].some((token) => native.get(token)?.occupies() !== false);

  const available = (lane: LaneState) => lane.holder === undefined && !occupied(lane.native);

  const forgetState = (lane: LaneState) => {
    if (
      !lane.retired ||
      lane.native.work.size > 0 ||
      lane.holder !== undefined ||
      lane.native.stopSetupPending !== undefined ||
      lane.native.wait !== undefined ||
      lane.reservation !== undefined
    )
      return;
    retained.delete(lane);
    if (lane.pageId !== undefined && pages.get(lane.pageId) === lane) pages.delete(lane.pageId);
  };

  const next = (lane: LaneState) => {
    if (!available(lane) || lane.revoked) return;
    while (lane.pending.length > 0) {
      const head = lane.pending.shift();

      if (head === undefined) return;
      if (!head.reserved) pendingCount--;
      const time = now();

      const refusal = expired()
        ? Reasons.Expired.make({})
        : time >= head.deadline
          ? Reasons.Timeout.make({})
          : time >= head.queueDeadline
            ? Reasons.QueueExpired.make({})
            : undefined;

      if (refusal !== undefined) {
        Deferred.doneUnsafe(head.result, Effect.fail(error(head.operation, refusal)));
        continue;
      }
      // The next caller owns admission before it wakes. A fresh arrival cannot barge.
      lane.holder = head.token;
      Deferred.doneUnsafe(head.result, Effect.void);

      return;
    }
  };

  const releaseState = (lane: LaneState, token: object) => {
    if (lane.holder !== token) return;
    lane.holder = undefined;
    next(lane);
    forgetState(lane);
    settled();
  };

  const cancelState = (lane: LaneState, pending: PendingAdmission) => {
    const index = lane.pending.indexOf(pending);

    if (index >= 0) {
      lane.pending.splice(index, 1);
      if (!pending.reserved) pendingCount--;
      next(lane);
    } else releaseState(lane, pending.token);
  };

  const revokeState = (lane: LaneState, reason: BrowserError["reason"]) => {
    lane.revoked = true;
    lane.active?.controller.abort();
    const pending = lane.pending.splice(0);

    pendingCount -= pending.filter((waiter) => !waiter.reserved).length;
    for (const waiter of pending)
      Deferred.doneUnsafe(waiter.result, Effect.fail(error(waiter.operation, reason)));
  };

  const snapshot = (lane: AdmissionLane): AdmissionStatus =>
    Object.freeze({
      active: lane.active?.operation ?? null,
      waiting: lane.pending.length,
      maximum: maximumPage,
      oldestWaitMillis:
        lane.pending[0] === undefined ? null : Math.max(0, now() - lane.pending[0].requestedAt),
      nativePending: lane.native.work.size,
      nativeWaitPending: lane.native.wait !== undefined,
      stopSetupPending: lane.native.stopSetupPending !== undefined,
    });

  /** Ends a navigation stop's setup on its capacity, if it is still the current one. */
  const clearStopSetup = (capacity: CapacityState) => {
    const setup = capacity.stopSetupPending;

    capacity.stopSetupPending = undefined;
    capacity.stopSetupConnection = undefined;
    if (setup !== undefined) Deferred.doneUnsafe(setup, Effect.void);
  };

  const wake = (capacity: CapacityState) => {
    for (const waiting of [registry, ...retained]) if (waiting.native === capacity) next(waiting);
  };

  const registryView: AdmissionLane = registry;

  return {
    registry: registryView,
    snapshot,
    status: () =>
      Object.freeze({
        waiting: pendingCount,
        maximum: maximumSession,
        nativePending: native.size,
        nativeMaximum: maximumNative,
        nativeWaits: new Set(
          [registry, ...retained]
            .map((lane) => lane.native)
            .filter((capacity) => capacity.wait !== undefined),
        ).size,
        stopSetups: new Set(
          [registry, ...retained]
            .map((lane) => lane.native)
            .filter((capacity) => capacity.stopSetupPending !== undefined),
        ).size,
        registry: snapshot(registry),
      }),
    /** The page's current lane, if it has one. */
    lane: (pageId: string): AdmissionLane | undefined => pages.get(pageId),
    lanes: (): ReadonlyArray<AdmissionLane> => [registry, ...retained],
    page: (pageId: string, generation: number): AdmissionLane => {
      const previous = pages.get(pageId);

      if (previous?.generation === generation) return previous;
      if (previous !== undefined) previous.retired = true;

      const lane = own({
        pageId,
        generation,
        pending: [],
        native: previous?.native ?? { work: new Set() },
        revision: previous?.revision ?? 0,
        revoked: false,
        retired: false,
      });

      pages.set(pageId, lane);
      retained.add(lane);
      if (previous !== undefined) forgetState(previous);

      return lane;
    },
    recovery: (lane: AdmissionLane, operation: BrowserOperation): AdmissionLane => {
      const page = state(lane);
      const key = operation === "close-page" ? "closure" : "recovery";
      const previous = page[key];

      if (previous !== undefined) {
        if (key === "closure" && !previous.retired && !page.retired) previous.revoked = false;

        return previous;
      }

      const recovery = own({
        ...(page.pageId === undefined ? {} : { pageId: page.pageId }),
        generation: page.generation,
        pending: [],
        native: { work: new Set() },
        revision: page.revision,
        revoked: false,
        retired: false,
      });

      page[key] = recovery;
      retained.add(recovery);

      return recovery;
    },
    acquire: (lane: AdmissionLane, pending: PendingAdmission, queueMillis: number) => {
      const owner = state(lane);

      if (owner.revoked) return Effect.fail(error(pending.operation, Reasons.Stale.make({})));
      if (available(owner) && owner.pending.length === 0) {
        owner.holder = pending.token;

        return Effect.void;
      }
      if (queueMillis <= 0) return Effect.fail(error(pending.operation, Reasons.Busy.make({})));

      if (pending.reserved && owner.pending.length >= 1)
        return Effect.fail(error(pending.operation, Reasons.Busy.make({})));

      const scope =
        pendingCount >= maximumSession
          ? "session"
          : owner.pageId === undefined
            ? "registry"
            : "page";

      if (
        !pending.reserved &&
        (pendingCount >= maximumSession || owner.pending.length >= maximumPage)
      )
        return Effect.fail(
          error(
            pending.operation,
            Reasons.QueueFull.make({
              scope,
              maximum: scope === "session" ? maximumSession : maximumPage,
              observed: (scope === "session" ? pendingCount : owner.pending.length) + 1,
            }),
          ),
        );
      owner.pending.push(pending);
      if (!pending.reserved) pendingCount++;

      return Deferred.await(pending.result);
    },
    cancel: (lane: AdmissionLane, pending: PendingAdmission) => cancelState(state(lane), pending),
    release: (lane: AdmissionLane, token: object) => releaseState(state(lane), token),
    forget: (lane: AdmissionLane) => forgetState(state(lane)),
    revoke: (lane: AdmissionLane, reason: BrowserError["reason"]) =>
      revokeState(state(lane), reason),
    /** A page whose quarantine an operator released admits work again. */
    restore: (pageId: string) => {
      const lane = pages.get(pageId);

      if (lane !== undefined) lane.revoked = false;
    },
    /** Observation evidence on these pages (all of them without a page) is out of date. */
    revise: (pageId?: string) => {
      for (const lane of pages.values())
        if (pageId === undefined || lane.pageId === pageId) lane.revision++;
    },
    /** The admitted operation now running in this lane, until `deactivate`. */
    activate: (lane: AdmissionLane, controller: AbortController, operation: BrowserOperation) => {
      state(lane).active = { controller, operation };
    },
    deactivate: (lane: AdmissionLane, controller: AbortController) => {
      const owner = state(lane);

      if (owner.active?.controller === controller) owner.active = undefined;
    },
    /** A dispatched navigation's claim on its page, held until it settles or a fence aborts it. */
    reserve: (lane: AdmissionLane, controller: AbortController) => {
      state(lane).reservation = controller;
    },
    /** Clears the lane's reservation if it is still `controller`; false when it was replaced. */
    settleReservation: (lane: AdmissionLane, controller: AbortController): boolean => {
      const owner = state(lane);

      if (owner.reservation !== controller) return false;
      owner.reservation = undefined;

      return true;
    },
    /** Removes and returns the lane's reservation, for the caller to abort or settle. */
    takeReservation: (lane: AdmissionLane): AbortController | undefined => {
      const owner = state(lane);
      const reservation = owner.reservation;

      owner.reservation = undefined;

      return reservation;
    },
    /** A pure wait owns its page's single wait slot until `endWait`. */
    beginWait: (lane: AdmissionLane, wait: NativeWait) => {
      state(lane).native.wait = wait;
    },
    endWait: (wait: NativeWait) => {
      for (const lane of [registry, ...retained]) {
        if (lane.native.wait !== wait) continue;
        lane.native.wait = undefined;
        forgetState(lane);
      }
    },
    /**
     * Installs a navigation stop's setup on the lane's native capacity for `connection`. Returns
     * undefined while another setup is pending; otherwise its settle, which clears the setup if
     * it is still current and releases anyone waiting for it.
     */
    beginStopSetup: (lane: AdmissionLane, connection: object | undefined) => {
      const capacity = state(lane).native;

      if (capacity.stopSetupPending !== undefined) return undefined;
      const setup = Deferred.makeUnsafe<void>();

      capacity.stopSetupPending = setup;
      capacity.stopSetupConnection = connection;

      return () => {
        if (capacity.stopSetupPending === setup) {
          capacity.stopSetupPending = undefined;
          capacity.stopSetupConnection = undefined;
        }
        Deferred.doneUnsafe(setup, Effect.void);
      };
    },
    blockPending: (reason: BrowserError["reason"]) => {
      for (const lane of [registry, ...retained]) {
        const pending = lane.pending.filter((waiter) => !waiter.reserved);

        if (pending.length === 0) continue;
        for (const waiter of pending) lane.pending.splice(lane.pending.indexOf(waiter), 1);

        pendingCount -= pending.length;
        for (const waiter of pending)
          Deferred.doneUnsafe(waiter.result, Effect.fail(error(waiter.operation, reason)));
      }
    },
    fence: (reason: BrowserError["reason"]) => {
      // Registry ownership belongs to the transition that performed the fence.
      for (const lane of retained) {
        lane.retired = true;
        revokeState(lane, reason);
      }
      registry.active?.controller.abort();
      const pending = registry.pending.splice(0);

      pendingCount -= pending.filter((waiter) => !waiter.reserved).length;
      for (const waiter of pending)
        Deferred.doneUnsafe(waiter.result, Effect.fail(error(waiter.operation, reason)));
      for (const lane of retained) forgetState(lane);
    },
    retainNative: (
      lane: AdmissionLane,
      operation: BrowserOperation,
      connection?: object,
      occupies: () => boolean = () => true,
    ) => {
      const owner = state(lane);

      if (native.size >= maximumNative)
        throw error(
          operation,
          Reasons.Limit.make({
            dimension: "native-operations",
            maximum: maximumNative,
            observed: native.size,
          }),
        );
      const token = {};

      owner.native.work.add(token);
      native.set(token, {
        lane: owner,
        occupies,
        ...(connection === undefined ? {} : { connection }),
      });

      return () => {
        if (!native.delete(token)) return;
        owner.native.work.delete(token);
        wake(owner.native);
        forgetState(owner);
        settled();
      };
    },
    retirePage: (pageId: string) => {
      for (const lane of retained) {
        if (lane.pageId !== pageId) continue;
        for (const token of lane.native.work) native.delete(token);
        lane.native.work.clear();
        clearStopSetup(lane.native);
        lane.revoked = true;
        lane.retired = true;
        forgetState(lane);
        next(lane);
      }
      pages.delete(pageId);
      settled();
    },
    retire: () => {
      native.clear();
      for (const lane of [registry, ...retained]) {
        lane.native.work.clear();
        clearStopSetup(lane.native);
        forgetState(lane);
      }
      settled();
    },
    retireConnection: (connection: object) => {
      for (const lane of [registry, ...retained]) {
        // Only the setup's own connection may release it, even when that retirement arrives
        // after a successor connection has used the same page.
        if (lane.native.stopSetupConnection !== connection) continue;
        clearStopSetup(lane.native);
        forgetState(lane);
      }
      for (const [token, lease] of native) {
        if (lease.connection !== connection) continue;
        native.delete(token);
        lease.lane.native.work.delete(token);
        wake(lease.lane.native);
        forgetState(lease.lane);
      }
      settled();
    },
    /**
     * Only native work that can still change a page must settle. A `held` lane belongs to an
     * operator's quarantine, whose own work cannot hold up the handoff that releases it.
     */
    drained: (except?: AbortSignal, held: (lane: AdmissionLane) => boolean = () => false) =>
      [...native.values()].every((lease) => !lease.occupies() || held(lease.lane)) &&
      [registry, ...retained].every(
        (lane) =>
          lane.native.stopSetupPending === undefined &&
          (lane.holder === undefined ||
            (except !== undefined && lane.active?.controller.signal === except)),
      ),
  };
};
