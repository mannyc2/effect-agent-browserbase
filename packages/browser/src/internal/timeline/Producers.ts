import type { Clock } from "effect";

import type { Correlation, EvidenceTarget, Payload, Stamp } from "../../TimelineData.ts";
import type { CaptureMetadata } from "../browser/Association.ts";
import type { NativeCachedPage } from "../browser/Driver.ts";
import type { ObserveTicket, TicketObserver } from "../browser/Owner.ts";
import type { AppendInput, makeStore } from "./Store.ts";

export type Store = ReturnType<typeof makeStore>;

/** Refusing an external fact must never change the native operation's original outcome. */
export const publish = (store: Store, input: AppendInput) => {
  const result = store.append(input);

  if (result._tag === "Refused" && result.reason !== "Closed")
    return store.append({
      target: null,
      correlation: null,
      event: { _tag: "MetadataOmitted", reason: result.reason, originalTag: null },
    });

  return result;
};

export const stamp = (store: Store, originNanos: bigint, nanos: bigint): Stamp => ({
  clockId: store.now().clockId,
  offsetNanos: nanos - originNanos,
});

export const cachedTarget = (page: NativeCachedPage, generation: number): EvidenceTarget => ({
  generation,
  pageId: page.pageId,
  frameId: page.frameId,
  document: page.documentEpoch,
});

export const observeTickets =
  (configuration: {
    readonly store: () => Store;
    readonly clock: Clock.Clock;
    readonly originNanos: bigint;
    readonly cachedPages: () => readonly NativeCachedPage[];
    readonly retain: (pageId: string | undefined) => () => void;
  }): ObserveTicket =>
  (facts) => {
    // One closure per original admitted ticket, with no registry of historical stores.
    const store = configuration.store();
    const scope = facts.scope;

    const pageId =
      scope === undefined || scope === "all" || scope === "none" ? undefined : scope.pageId;

    const release = configuration.retain(pageId);

    const target: EvidenceTarget | null =
      pageId === undefined
        ? null
        : {
            generation: facts.generation,
            pageId,
            frameId: null,
            document: null,
          };

    const correlation = facts.correlation();

    const append = (event: Payload, actualTarget: EvidenceTarget | null = target) =>
      publish(store, { target: actualTarget, correlation, event });

    let ordinal = 0;
    let picture: { readonly at: Stamp; readonly target: EvidenceTarget } | undefined;
    const at = (nanos: bigint) => stamp(store, configuration.originNanos, nanos);

    const interval = (start: bigint, end: bigint) => ({
      start: at(start),
      end: at(end),
      qualification: "native-call-interval" as const,
    });

    const actualTarget = (value: {
      readonly generation?: number;
      readonly pageId: string;
      readonly frameId: string;
    }): EvidenceTarget => ({
      generation: value.generation ?? facts.generation,
      pageId: value.pageId,
      frameId: value.frameId,
      // A receipt's target grants frame attribution, not a document sampling guarantee.
      document: null,
    });

    const observer: TicketObserver = {
      phase: (phase, mutation) => {
        const ticket = facts.ticket();

        if (ticket === undefined) return;
        if (phase === "Dispatched") ordinal++;
        append({
          _tag: phase,
          operation: facts.operation,
          operationId: facts.operationId,
          nativeOrdinal: ordinal,
          mutation,
          late:
            ticket.phase === "Terminal" ||
            ticket.signal.aborted ||
            Number(configuration.clock.monotonicTimeNanosUnsafe()) / 1_000_000 >= ticket.deadline,
        });
      },
      picture: (boundary) => {
        const captured: EvidenceTarget = {
          generation: facts.generation,
          ...boundary.target,
          document: boundary.documentEpoch,
        };

        const now = store.now();

        if (boundary.phase === "Requested") picture = { at: now, target: captured };
        else if (picture !== undefined) {
          const requested = picture;

          picture = undefined;
          append(
            {
              _tag: "Picture",
              operationId: facts.operationId,
              mediaType: "image/png",
              nativeRequest: requested.at,
              nativeReturn: now,
              qualification: "native-call-interval",
              requestDocument: requested.target.document,
              returnDocument: boundary.documentEpoch,
            },
            {
              ...requested.target,
              document:
                requested.target.document === boundary.documentEpoch
                  ? boundary.documentEpoch
                  : null,
            },
          );
        }
      },
      input: (receipt, keys) => {
        const timing = interval(receipt.startedMonotonicNanos, receipt.completedMonotonicNanos);
        const correlation = { operationId: facts.operationId, interval: timing };
        let event: Payload | undefined;

        switch (receipt.kind) {
          case "pointer-move":
          case "hover":
            event = {
              _tag: "Pointer",
              kind: receipt.kind,
              position: receipt.position,
              ...correlation,
            };
            break;
          case "click":
            event = { _tag: "Press", position: receipt.position, ...correlation };
            break;
          case "wheel":
            event = { _tag: "Scroll", kind: "wheel", delta: receipt.delta ?? null, ...correlation };
            break;
          case "press":
          case "type":
            if (keys === undefined) return;
            event = { _tag: "Keys", kind: receipt.kind, ...keys, ...correlation };
            break;
        }
        append(
          event ?? { _tag: "MetadataOmitted", reason: "Malformed", originalTag: null },
          actualTarget(receipt.target),
        );
      },
      scroll: (value) =>
        append(
          {
            _tag: "Scroll",
            operationId: facts.operationId,
            kind: "scroll",
            delta: null,
            interval: interval(value.startedMonotonicNanos, value.completedMonotonicNanos),
          },
          actualTarget(value.target),
        ),
      settled: (evidence, value) =>
        append(
          {
            _tag: "Settled",
            operationId: facts.operationId,
            quietMillis: evidence.quietMillis,
            withinMillis: evidence.withinMillis,
            signals: evidence.signals,
          },
          actualTarget(value),
        ),
      finished: (summary) => {
        if (summary.containment._tag !== "NotRequired")
          append({ _tag: "Contained", containment: summary.containment });
        if (summary.kind === "Cancelled")
          append({ _tag: "Cancelled", operationId: facts.operationId, outcome: summary.outcome });
        else if (summary.kind === "Failed")
          append({
            _tag: "Failed",
            operationId: facts.operationId,
            operation: facts.operation,
            reason: summary.error?.reason._tag ?? "Failed",
            outcome: summary.outcome,
          });
        release();
      },
    };

    return observer;
  };

export const captureMetadata =
  (store: Store, originNanos: bigint) =>
  (value: CaptureMetadata): void => {
    // Capture document/boundary numbers name receipt attribution, never native document epochs.
    const target: EvidenceTarget = { ...value.target, document: null };

    const common = {
      captureId: value.captureId,
      captureBoundary: value.captureBoundary,
      captureDocument: value.captureDocument,
    };

    const at = (nanos: bigint) => stamp(store, originNanos, nanos);
    let event: Payload;

    switch (value._tag) {
      case "FirstFrame":
        event = {
          _tag: "FirstFrame",
          ...common,
          frameSequence: value.frameSequence,
          sourceTimeMillis: value.sourceTimeMillis,
          sourceClock: value.sourceClock,
          received: at(value.receivedMonotonicNanos),
          width: value.width,
          height: value.height,
          viewportWidth: value.viewportWidth,
          viewportHeight: value.viewportHeight,
          qualification: "received-boundary-attribution",
        };
        break;
      case "CaptureBoundary":
        event = {
          _tag: "CaptureBoundary",
          ...common,
          sameDocument: value.sameDocument,
          afterSequence: value.afterSequence,
          observed: at(value.observedMonotonicNanos),
          qualification: "received-boundary-attribution",
          url: value.url,
          urlQualification: value.urlQualification,
        };
        break;
      case "Capture":
        event = {
          _tag: "Capture",
          ...common,
          phase: value.phase,
          observed: at(value.observedMonotonicNanos),
          qualification: value.qualification,
          reason: value.reason,
          nativeStop: value.nativeStop,
          received: value.received,
          delivered: value.delivered,
          discarded: value.discarded,
          overflow: value.overflow,
          late: value.late,
          duplicates: value.duplicates,
          rejected: value.rejected,
          upstreamDrops: value.upstreamDrops,
          latePhase: value.latePhase,
        };
        break;
    }
    publish(store, { target, correlation: null, event });
  };

export const planPublisher =
  (store: Store, target: EvidenceTarget | null) =>
  (correlation: Correlation, event: Payload): void => {
    publish(store, { target, correlation, event });
  };
