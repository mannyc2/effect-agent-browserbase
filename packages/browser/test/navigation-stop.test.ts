import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";

import { dispatchNavigationStop } from "../src/internal/browser/Actions.ts";
import type { Ticket } from "../src/internal/browser/Owner.ts";
import { makeNavigationStop } from "../src/internal/browser/Session.ts";

const ticket = () => {
  let dispatched = false;

  return {
    value: {
      signal: new AbortController().signal,
      deadline: 10000,
      generation: 0,
      get dispatched() {
        return dispatched;
      },
      remainingMillis: () => 1000,
      check: () => {},
      dispatch: () => {
        dispatched = true;
      },
    } satisfies Ticket,
    dispatched: () => dispatched,
  };
};

it("rechecks navigation ownership after asynchronous stop setup before dispatch", async () => {
  const t = ticket();
  let pending = true;
  let stopCalls = 0;
  let dispatchCalls = 0;
  let opened!: () => void;
  let release!: () => void;

  const opening = new Promise<void>((resolve) => {
    opened = resolve;
  });

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const stopping = dispatchNavigationStop(
    t.value,
    () => pending,
    () => {
      dispatchCalls++;
    },
    async () => {
      opened();
      await gate;

      return {
        stop: async () => {
          stopCalls++;
        },
        close: async () => {},
      };
    },
  );

  await opening;
  pending = false;
  release();

  await expect(stopping).resolves.toBe("settled");
  expect(t.dispatched()).toBe(false);
  expect(dispatchCalls).toBe(0);
  expect(stopCalls).toBe(0);
});

it.effect("shares one cached stop attempt across concurrent and repeated callers", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let attempts = 0;
    let confirms = 0;

    const attempt = Effect.sync(() => {
      attempts++;
    }).pipe(
      Effect.andThen(Deferred.succeed(started, undefined)),
      Effect.andThen(Deferred.await(release)),
      Effect.as<"dispatched">("dispatched"),
    );

    const stop = yield* makeNavigationStop<never, never>(
      () => false,
      attempt,
      () => {
        confirms++;
      },
    );

    const first = yield* Effect.forkChild(stop);

    yield* Deferred.await(started);
    const second = yield* Effect.forkChild(stop);

    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
    yield* stop;

    expect(attempts).toBe(1);
    expect(confirms).toBe(1);
  }),
);

it.effect("completed navigation stop is a no-op without entering native ownership", () =>
  Effect.gen(function* () {
    let attempts = 0;

    const stop = yield* makeNavigationStop<never, never>(
      () => true,
      Effect.sync(() => {
        attempts++;

        return "dispatched" as const;
      }),
      () => {},
    );

    yield* stop;
    yield* stop;
    expect(attempts).toBe(0);
  }),
);
