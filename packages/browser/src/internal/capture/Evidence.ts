import { Cause, Effect, Queue, Schema, Stream } from "effect";

import type { CapturedFrame } from "../../CaptureData.ts";
import {
  type Baseline,
  type Event,
  ObservationError,
  ObservationOptions,
  type Observe,
  receipt,
} from "../../CaptureEvidence.ts";

// Metadata is bounded independently of image storage. IDs are ASCII and at most 256 chars;
// native clocks and numeric fields fit comfortably inside this conservative per-event budget.
const EventReservation = 4096;
const MaxObservers = 16;

interface Observer {
  readonly queue: Queue.Queue<Event, ObservationError | Cause.Done>;
  readonly capacity: number;
  pending: number;
  active: boolean;
}

export const makeEvidence = (sourceId: string) =>
  Effect.sync(() => {
    let baseline: Baseline = Object.freeze({
      sourceId,
      revision: 0,
      latest: null,
      phase: "open",
      reason: null,
    });

    // Keep ended queues in the reservation count until drained/disposed. A caller cannot
    // accumulate bounded-but-unconsumed queues by repeatedly overflowing observers.
    const observers = new Set<Observer>();

    const error = (reason: ObservationError["reason"], afterRevision = baseline.revision) =>
      new ObservationError({ sourceId, reason, afterRevision });

    const publish = (event: Event) => {
      for (const observer of observers) {
        if (!observer.active) continue;
        if (observer.pending >= observer.capacity) {
          observer.active = false;
          Queue.failCauseUnsafe(observer.queue, Cause.fail(error("overflow", event.revision - 1)));
          continue;
        }
        observer.pending++;
        Queue.offerUnsafe(observer.queue, event);
      }
    };

    const observe: Observe = Effect.fnUntraced(function* (options = {}) {
      const decoded = yield* Schema.decodeEffect(ObservationOptions)(options, {
        onExcessProperty: "error",
      }).pipe(Effect.mapError(() => error("configuration")));

      const capacity = Math.min(
        decoded.maxEvents ?? 64,
        Math.floor((decoded.maxBufferedBytes ?? 256 * 1024) / EventReservation),
      );

      const queue = yield* Queue.make<Event, ObservationError | Cause.Done>({ capacity });
      const observer: Observer = { queue, capacity, pending: 0, active: true };

      const dispose = Effect.sync(() => {
        observer.active = false;
        observers.delete(observer);
        Queue.shutdownUnsafe(queue);
      });

      const initial = yield* Effect.acquireRelease(
        Effect.suspend(() => {
          if (observers.size >= MaxObservers) return Effect.fail(error("limit"));
          observers.add(observer);
          if (baseline.phase === "ended") {
            observer.active = false;
            Queue.endUnsafe(queue);
          }

          return Effect.succeed(baseline);
        }),
        () => dispose,
      );

      let consumed = false;

      const events = Stream.unwrap(
        Effect.suspend(() => {
          if (consumed) return Effect.fail(error("already-consumed"));
          consumed = true;

          return Effect.succeed(
            Stream.fromEffectRepeat(
              Queue.take(queue).pipe(Effect.tap(() => Effect.sync(() => observer.pending--))),
            ).pipe(Stream.ensuring(dispose)),
          );
        }),
      );

      return { baseline: initial, events };
    });

    return {
      observe,
      frame: (frame: CapturedFrame): void => {
        if (baseline.phase === "ended") return;
        const value = receipt(sourceId, frame);
        const revision = baseline.revision + 1;

        baseline = Object.freeze({ ...baseline, revision, latest: value });
        publish(Object.freeze({ _tag: "Frame", revision, receipt: value }));
      },
      end: (reason: string): void => {
        if (baseline.phase === "ended") return;
        const revision = baseline.revision + 1;

        baseline = Object.freeze({ ...baseline, revision, phase: "ended", reason });
        publish(Object.freeze({ _tag: "Ended", sourceId, revision, reason }));
        for (const observer of observers) {
          if (!observer.active) continue;
          observer.active = false;
          Queue.endUnsafe(observer.queue);
        }
      },
    };
  });
