/**
 * The browser's bounded event history and replay cursors. Readers share the same records and
 * wakeup generation, so a delayed reader cannot block input or retain an unbounded private queue.
 */
import { Cause, Deferred, Effect, Stream } from "effect";

import { type BrowserError, EventHistoryExpired } from "../../BrowserError.ts";
import { type BrowserEvent, RecordedEvent } from "../../BrowserEvent.ts";
import { refuse, undispatched } from "../page/context.ts";

/** The owning Browser validates capacity and closes this timeline with its scope. */
export const make = (capacity: number) => {
  const records = Array.from<RecordedEvent | undefined>({ length: capacity });
  let start = 0;
  let size = 0;
  let sequence = 0;
  let closed = false;
  let changed = Deferred.makeUnsafe<void>();

  const wake = () => {
    const previous = changed;

    changed = Deferred.makeUnsafe<void>();
    Deferred.doneUnsafe(previous, Effect.void);
  };

  const publish = (event: BrowserEvent): number => {
    // Native callbacks may finish after their owning scope. They must not revive closed readers.
    if (closed) return sequence;
    sequence += 1;
    const recorded = new RecordedEvent({ sequence, event });

    records[(start + size) % capacity] = recorded;
    if (size < capacity) size++;
    else start = (start + 1) % capacity;
    wake();

    return sequence;
  };

  const stream = (after?: number): Stream.Stream<RecordedEvent, BrowserError> =>
    Stream.unwrap(
      Effect.sync(() => {
        // This runs for each subscription, rather than when the reusable stream is constructed.
        let cursor = after ?? sequence;

        if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > sequence)
          return Stream.fromEffect(
            refuse(
              "events",
              "the event cursor must be a nonnegative integer no greater than the latest sequence",
            ),
          );

        return Stream.fromEffectRepeat(
          Effect.gen(function* () {
            while (true) {
              const oldest = sequence - size + 1;

              if (cursor < oldest - 1)
                return yield* undispatched(
                  "events",
                  new EventHistoryExpired({ after: cursor, oldest, latest: sequence }),
                );

              const next =
                cursor < sequence ? records[(start + cursor - oldest + 1) % capacity] : undefined;

              if (next !== undefined) {
                cursor = next.sequence;

                return next;
              }
              if (closed) return yield* Cause.done();
              // Capture the generation in the same synchronous read as the empty history check.
              // A publish before await completes this exact Deferred, so no wakeup can be missed.
              const waiting = changed;

              yield* Deferred.await(waiting);
            }
          }),
        );
      }),
    );

  return {
    publish,
    sequence: () => sequence,
    recent: Effect.sync(() =>
      Array.from({ length: size }, (_, index) => records[(start + index) % capacity]).filter(
        (record): record is RecordedEvent => record !== undefined,
      ),
    ),
    stream,
    close: Effect.sync(() => {
      if (closed) return;
      closed = true;
      wake();
    }),
  };
};
