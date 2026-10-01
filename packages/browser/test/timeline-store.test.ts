import { expect, it } from "@effect/vitest";
import { Clock, Effect } from "effect";

import { makeStore } from "../src/internal/timeline/Store.ts";
import { TimelineDefaults } from "../src/TimelineData.ts";

const lifecycle = (phase: "acquiring" | "open" | "paused" | "detached") => ({
  target: null,
  correlation: null,
  event: { _tag: "Lifecycle" as const, phase },
});

it.effect("a subscriber resumes exactly after its cursor once the ring has wrapped", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const clock = yield* Clock.Clock;

      const store = makeStore({
        clock,
        originNanos: clock.monotonicTimeNanosUnsafe(),
        identity: { storeId: "store", clockId: "clock" },
        limits: { ...TimelineDefaults, maxEvents: 4 },
      });

      for (const phase of ["acquiring", "open", "paused"] as const) store.append(lifecycle(phase));
      const subscription = yield* store.subscribe({ from: store.cursor(2n) });

      expect((yield* subscription.pull).map((event) => event.sequence)).toEqual([3n]);
      // Three more appends evict the two oldest and wrap the ring's storage.
      for (const phase of ["open", "paused", "detached"] as const) store.append(lifecycle(phase));
      expect((yield* subscription.pull).map((event) => event.sequence)).toEqual([4n, 5n, 6n]);
    }),
  ),
);
