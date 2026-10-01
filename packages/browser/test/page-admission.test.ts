import { expect, it } from "@effect/vitest";
import { Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";

import type { OperationOptions, Page } from "../src/Browser.ts";
import * as Testing from "../src/Testing.ts";

// #94 requires bounded FIFO admission. The native workflow cannot deterministically place
// cancellation and both deadlines at ownership transfer, so these use the public scripted owner.
const script: Testing.Script = {
  documents: [
    {
      url: "https://admission.test/",
      text: "Ready",
      controls: [
        { id: "first", kind: "button", label: "First" },
        { id: "second", kind: "button", label: "Second" },
        { id: "third", kind: "button", label: "Third" },
        { id: "barge", kind: "button", label: "Barge" },
      ],
    },
  ],
};

const queuedClick = (page: Page, selector: string, options: OperationOptions) =>
  page.click({ selector }, options);

it.effect("same-Page queued calls transfer admission FIFO without a fail-fast caller barging", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* Testing.open(script);
      const page = browser.initialPage;
      const holderGate = yield* browser.control.gate;
      const firstGate = yield* browser.control.gate;

      yield* browser.control.next("read-text", {
        _tag: "Hold",
        gate: holderGate,
        dispatched: false,
      });
      const holder = yield* page.readText({}).pipe(Effect.forkScoped);

      yield* holderGate.reached;
      yield* browser.control.next("click", {
        _tag: "Hold",
        gate: firstGate,
        dispatched: false,
      });

      const first = yield* queuedClick(page, "#first", {
        admission: { queue: "1 second" },
      }).pipe(Effect.forkScoped);

      yield* TestClock.adjust(0);
      expect(first.pollUnsafe()).toBeUndefined();

      const second = yield* queuedClick(page, "#second", {
        admission: { queue: "1 second" },
      }).pipe(Effect.forkScoped);

      yield* TestClock.adjust(0);
      expect(second.pollUnsafe()).toBeUndefined();

      const third = yield* queuedClick(page, "#third", {
        admission: { queue: "1 second" },
      }).pipe(Effect.forkScoped);

      yield* TestClock.adjust(0);
      expect(third.pollUnsafe()).toBeUndefined();
      yield* holderGate.open;
      yield* Fiber.join(holder);
      expect(yield* page.click({ selector: "#barge" }).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { reason: { _tag: "Busy" }, outcome: "undispatched" },
      });
      yield* firstGate.reached;
      yield* firstGate.open;
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      yield* Fiber.join(third);
      expect(
        (yield* browser.control.calls)
          .filter((call) => call.operation === "click")
          .map((call) => call.selector),
      ).toEqual(["#first", "#second", "#third"]);
      expect(yield* browser.status).toMatchObject({
        phase: "open",
        actions: { used: 4 },
        unresolvedDispatch: false,
      });
    }),
  ),
);

it.effect("canceling queued work sends nothing and charges nothing before a successor enters", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* Testing.open(script);
      const page = browser.initialPage;
      const holderGate = yield* browser.control.gate;

      yield* browser.control.next("read-text", {
        _tag: "Hold",
        gate: holderGate,
        dispatched: false,
      });
      const holder = yield* page.readText({}).pipe(Effect.forkScoped);

      yield* holderGate.reached;

      const canceled = yield* queuedClick(page, "#first", {
        admission: { queue: "1 second" },
      }).pipe(Effect.forkScoped);

      yield* TestClock.adjust(0);
      expect(canceled.pollUnsafe()).toBeUndefined();
      yield* Fiber.interrupt(canceled);
      expect(Exit.hasInterrupts(yield* Fiber.await(canceled))).toBe(true);
      expect((yield* browser.status).actions.used).toBe(1);
      expect((yield* browser.control.calls).map((call) => call.operation)).toEqual(["read-text"]);

      const successor = yield* queuedClick(page, "#second", {
        admission: { queue: "1 second" },
      }).pipe(Effect.forkScoped);

      yield* TestClock.adjust(0);
      expect(successor.pollUnsafe()).toBeUndefined();
      yield* holderGate.open;
      yield* Fiber.join(holder);
      yield* Fiber.join(successor);
      expect(
        (yield* browser.control.calls)
          .filter((call) => call.operation === "click")
          .map((call) => call.selector),
      ).toEqual(["#second"]);
      expect((yield* browser.status).actions.used).toBe(2);
    }),
  ),
);

it.effect.each([
  { ending: "queue allowance", queue: 10, operation: 30, reason: "QueueExpired" },
  { ending: "operation deadline", queue: 30, operation: 10, reason: "Timeout" },
])(
  "the $ending expires queued work without native dispatch or an action charge",
  ({ queue, operation, reason }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const browser = yield* Testing.open(script);
        const page = browser.initialPage;
        const holderGate = yield* browser.control.gate;

        yield* browser.control.next("read-text", {
          _tag: "Hold",
          gate: holderGate,
          dispatched: false,
        });
        const holder = yield* page.readText({}).pipe(Effect.forkScoped);

        yield* holderGate.reached;

        const queued = yield* queuedClick(page, "#first", {
          timeoutMillis: operation,
          admission: { queue },
        }).pipe(Effect.forkScoped);

        yield* TestClock.adjust(10);
        const failure = yield* Fiber.join(queued).pipe(Effect.flip);

        expect(failure).toMatchObject({
          operation: "click",
          reason: { _tag: reason },
          outcome: "undispatched",
        });
        expect((yield* browser.status).actions.used).toBe(1);
        expect((yield* browser.control.calls).map((call) => call.operation)).toEqual(["read-text"]);
        yield* holderGate.open;
        yield* Fiber.join(holder);
        yield* page.click({ selector: "#second" });
        expect((yield* browser.status).actions.used).toBe(2);
      }),
    ),
);

it.effect(
  "a full Page queue refuses without charge and canceled entries return caller capacity",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const browser = yield* Testing.open(script);
        const page = browser.initialPage;
        const holderGate = yield* browser.control.gate;

        yield* browser.control.next("read-text", {
          _tag: "Hold",
          gate: holderGate,
          dispatched: false,
        });
        const holder = yield* page.readText({}).pipe(Effect.forkScoped);

        yield* holderGate.reached;

        const pending = yield* Effect.forEach(Array.from({ length: 32 }), () =>
          queuedClick(page, "#first", { admission: { queue: "1 second" } }).pipe(Effect.forkScoped),
        );

        yield* TestClock.adjust(0);
        expect(pending.every((fiber) => fiber.pollUnsafe() === undefined)).toBe(true);
        expect(
          yield* queuedClick(page, "#barge", { admission: { queue: "1 second" } }).pipe(
            Effect.flip,
          ),
        ).toMatchObject({
          operation: "click",
          reason: { _tag: "QueueFull", scope: "page", maximum: 32, observed: 33 },
          outcome: "undispatched",
        });
        expect((yield* browser.status).actions.used).toBe(1);
        expect((yield* browser.control.calls).map((call) => call.operation)).toEqual(["read-text"]);
        yield* Effect.forEach(pending, Fiber.interrupt, { discard: true });

        const successor = yield* queuedClick(page, "#second", {
          admission: { queue: "1 second" },
        }).pipe(Effect.forkScoped);

        yield* TestClock.adjust(0);
        expect(successor.pollUnsafe()).toBeUndefined();
        yield* holderGate.open;
        yield* Fiber.join(holder);
        yield* Fiber.join(successor);
        expect(
          (yield* browser.control.calls)
            .filter((call) => call.operation === "click")
            .map((call) => call.selector),
        ).toEqual(["#second"]);
        expect((yield* browser.status).actions.used).toBe(2);
      }),
    ),
);

it.effect("an operation's deadline includes its queue wait and never restarts at admission", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* Testing.open(script);
      const page = browser.initialPage;
      const holderGate = yield* browser.control.gate;
      const nativeGate = yield* browser.control.gate;

      yield* browser.control.next("read-text", {
        _tag: "Hold",
        gate: holderGate,
        dispatched: false,
      });
      const holder = yield* page.readText({}).pipe(Effect.forkScoped);

      yield* holderGate.reached;
      yield* browser.control.next("click", {
        _tag: "Hold",
        gate: nativeGate,
        dispatched: false,
      });

      const queued = yield* queuedClick(page, "#first", {
        timeoutMillis: 100,
        admission: { queue: 200 },
      }).pipe(Effect.forkScoped);

      yield* TestClock.adjust(60);
      expect(queued.pollUnsafe()).toBeUndefined();
      yield* holderGate.open;
      yield* Fiber.join(holder);
      yield* nativeGate.reached;
      yield* TestClock.adjust(39);
      expect(queued.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust(1);
      expect(yield* Fiber.join(queued).pipe(Effect.flip)).toMatchObject({
        operation: "click",
        reason: { _tag: "Timeout" },
        outcome: "undispatched",
      });
      expect((yield* browser.status).actions.used).toBe(2);
      yield* nativeGate.open;
      expect(
        (yield* browser.control.calls).filter((call) => call.operation === "click"),
      ).toMatchObject([{ selector: "#first", dispatched: false, settled: "failed" }]);
    }),
  ),
);

it.effect(
  "admitted native work may outlast its queue allowance within the operation deadline",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const browser = yield* Testing.open(script);
        const page = browser.initialPage;
        const holderGate = yield* browser.control.gate;
        const nativeGate = yield* browser.control.gate;

        yield* browser.control.next("read-text", {
          _tag: "Hold",
          gate: holderGate,
          dispatched: false,
        });
        const holder = yield* page.readText({}).pipe(Effect.forkScoped);

        yield* holderGate.reached;
        yield* browser.control.next("click", {
          _tag: "Hold",
          gate: nativeGate,
          dispatched: false,
        });

        const queued = yield* queuedClick(page, "#first", {
          timeoutMillis: 100,
          admission: { queue: 20 },
        }).pipe(Effect.forkScoped);

        yield* TestClock.adjust(5);
        expect(queued.pollUnsafe()).toBeUndefined();
        yield* holderGate.open;
        yield* Fiber.join(holder);
        yield* nativeGate.reached;
        yield* TestClock.adjust(25);
        expect(queued.pollUnsafe()).toBeUndefined();
        yield* nativeGate.open;
        yield* Fiber.join(queued);
        expect(
          (yield* browser.control.calls).filter((call) => call.operation === "click"),
        ).toMatchObject([{ selector: "#first", dispatched: true, settled: "completed" }]);
        expect(yield* browser.status).toMatchObject({
          phase: "open",
          actions: { used: 2 },
          unresolvedDispatch: false,
        });
      }),
    ),
);
