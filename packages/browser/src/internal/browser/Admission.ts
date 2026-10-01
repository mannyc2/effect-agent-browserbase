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
  readonly work: Set<object>;
  wait?: NativeWait;
  stopSetupPending?: Deferred.Deferred<void>;
  /** The connection whose positive retirement may release `stopSetupPending`. */
  stopSetupConnection?: object;
}

/** One page's caller ownership and retained native capacity share this record. */
export interface AdmissionLane {
  readonly pageId?: string;
  readonly generation: number;
  readonly pending: Array<PendingAdmission>;
  readonly native: NativePageCapacity;
  revision: number;
  holder?: object;
  active?: { readonly controller: AbortController; readonly operation: BrowserOperation };
  reservation?: AbortController;
  recovery?: AdmissionLane;
  closure?: AdmissionLane;
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
  const pages = new Map<string, AdmissionLane>();
  const retained = new Set<AdmissionLane>();

  const registry: AdmissionLane = {
    generation: 0,
    pending: [],
    native: { work: new Set() },
    revision: 0,
    revoked: false,
    retired: false,
  };

  const maximumPage = limits.pendingPerPage ?? 32;
  const maximumSession = limits.pendingPerSession ?? 128;
  const maximumNative = 128;
  let pendingCount = 0;

  const native = new Map<
    object,
    {
      readonly lane: AdmissionLane;
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
  const occupied = (capacity: NativePageCapacity) =>
    [...capacity.work].some((token) => native.get(token)?.occupies() !== false);

  const available = (lane: AdmissionLane) => lane.holder === undefined && !occupied(lane.native);

  const forget = (lane: AdmissionLane) => {
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

  const next = (lane: AdmissionLane) => {
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

  const release = (lane: AdmissionLane, token: object) => {
    if (lane.holder !== token) return;
    lane.holder = undefined;
    next(lane);
    forget(lane);
    settled();
  };

  const cancel = (lane: AdmissionLane, pending: PendingAdmission) => {
    const index = lane.pending.indexOf(pending);

    if (index >= 0) {
      lane.pending.splice(index, 1);
      if (!pending.reserved) pendingCount--;
      next(lane);
    } else release(lane, pending.token);
  };

  const revoke = (lane: AdmissionLane, reason: BrowserError["reason"]) => {
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

  return {
    registry,
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
    pages,
    lanes: () => [registry, ...retained],
    page: (pageId: string, generation: number) => {
      const previous = pages.get(pageId);

      if (previous?.generation === generation) return previous;
      if (previous !== undefined) previous.retired = true;

      const lane: AdmissionLane = {
        pageId,
        generation,
        pending: [],
        native: previous?.native ?? { work: new Set() },
        revision: previous?.revision ?? 0,
        revoked: false,
        retired: false,
      };

      pages.set(pageId, lane);
      retained.add(lane);
      if (previous !== undefined) forget(previous);

      return lane;
    },
    recovery: (page: AdmissionLane, operation: BrowserOperation) => {
      const key = operation === "close-page" ? "closure" : "recovery";
      const previous = page[key];

      if (previous !== undefined) {
        if (key === "closure" && !previous.retired && !page.retired) previous.revoked = false;

        return previous;
      }

      const lane: AdmissionLane = {
        pageId: page.pageId,
        generation: page.generation,
        pending: [],
        native: { work: new Set() },
        revision: page.revision,
        revoked: false,
        retired: false,
      };

      page[key] = lane;
      retained.add(lane);

      return lane;
    },
    acquire: (lane: AdmissionLane, pending: PendingAdmission, queueMillis: number) => {
      if (lane.revoked) return Effect.fail(error(pending.operation, Reasons.Stale.make({})));
      if (available(lane) && lane.pending.length === 0) {
        lane.holder = pending.token;

        return Effect.void;
      }
      if (queueMillis <= 0) return Effect.fail(error(pending.operation, Reasons.Busy.make({})));

      if (pending.reserved && lane.pending.length >= 1)
        return Effect.fail(error(pending.operation, Reasons.Busy.make({})));

      const scope =
        pendingCount >= maximumSession
          ? "session"
          : lane.pageId === undefined
            ? "registry"
            : "page";

      if (
        !pending.reserved &&
        (pendingCount >= maximumSession || lane.pending.length >= maximumPage)
      )
        return Effect.fail(
          error(
            pending.operation,
            Reasons.QueueFull.make({
              scope,
              maximum: scope === "session" ? maximumSession : maximumPage,
              observed: (scope === "session" ? pendingCount : lane.pending.length) + 1,
            }),
          ),
        );
      lane.pending.push(pending);
      if (!pending.reserved) pendingCount++;

      return Deferred.await(pending.result);
    },
    cancel,
    release,
    forget,
    revoke,
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
        revoke(lane, reason);
      }
      registry.active?.controller.abort();
      const pending = registry.pending.splice(0);

      pendingCount -= pending.filter((waiter) => !waiter.reserved).length;
      for (const waiter of pending)
        Deferred.doneUnsafe(waiter.result, Effect.fail(error(waiter.operation, reason)));
      for (const lane of retained) forget(lane);
    },
    retainNative: (
      lane: AdmissionLane,
      operation: BrowserOperation,
      connection?: object,
      occupies: () => boolean = () => true,
    ) => {
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

      lane.native.work.add(token);
      native.set(token, { lane, occupies, ...(connection === undefined ? {} : { connection }) });

      return () => {
        if (!native.delete(token)) return;
        lane.native.work.delete(token);
        for (const waiting of [registry, ...retained])
          if (waiting.native === lane.native) next(waiting);
        forget(lane);
        settled();
      };
    },
    retirePage: (pageId: string) => {
      for (const lane of retained) {
        if (lane.pageId !== pageId) continue;
        for (const token of lane.native.work) native.delete(token);
        lane.native.work.clear();
        const setup = lane.native.stopSetupPending;

        lane.native.stopSetupPending = undefined;
        lane.native.stopSetupConnection = undefined;
        if (setup !== undefined) Deferred.doneUnsafe(setup, Effect.void);
        lane.revoked = true;
        lane.retired = true;
        forget(lane);
        next(lane);
      }
      pages.delete(pageId);
      settled();
    },
    retire: () => {
      native.clear();
      for (const lane of [registry, ...retained]) {
        lane.native.work.clear();
        const setup = lane.native.stopSetupPending;

        lane.native.stopSetupPending = undefined;
        lane.native.stopSetupConnection = undefined;
        if (setup !== undefined) Deferred.doneUnsafe(setup, Effect.void);
        forget(lane);
      }
      settled();
    },
    retireConnection: (connection: object) => {
      for (const lane of [registry, ...retained]) {
        // Only the setup's own connection may release it, even when that retirement arrives
        // after a successor connection has used the same page.
        if (lane.native.stopSetupConnection !== connection) continue;
        const setup = lane.native.stopSetupPending;

        lane.native.stopSetupPending = undefined;
        lane.native.stopSetupConnection = undefined;
        if (setup !== undefined) Deferred.doneUnsafe(setup, Effect.void);
        forget(lane);
      }
      for (const [token, lease] of native) {
        if (lease.connection !== connection) continue;
        native.delete(token);
        lease.lane.native.work.delete(token);
        for (const waiting of [registry, ...retained])
          if (waiting.native === lease.lane.native) next(waiting);
        forget(lease.lane);
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
