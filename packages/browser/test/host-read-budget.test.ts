import { expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import {
  ControlFacts,
  ObservedElement,
  ViewportRect,
} from "../src/BrowserData.ts";
import { fixture, gate } from "./fixtures/ScriptedOwner.ts";

const reference = ObservedElement.make({ observationId: "observed", elementId: "button" });

const facts = ControlFacts.make({
  kind: "button",
  label: "Act",
  disabled: false,
  editable: false,
  box: ViewportRect.make({ x: 0, y: 0, width: 20, height: 20 }),
  placement: "inside",
  hitTest: "self",
  mainFrame: true,
});

it.effect(
  "checkpoint and control facts share a host allowance independently of model actions",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let checkpoints = 0;
        let factReads = 0;

        const f = yield* fixture({
          maxActions: 2,
          maxHostReads: 3,
          onConnect: async (driver) => ({
            ...driver,
            checkpoint: async (...args) => {
              checkpoints++;

              return driver.checkpoint(...args);
            },
            controlFacts: async (_reference, ticket) => {
              ticket.check();
              factReads++;

              return facts;
            },
          }),
        });

        const session = yield* (yield* f.acquisition).connect;

        yield* session.checkpoint({ picture: false });
        expect(yield* session.controlFacts(reference)).toEqual(facts);
        yield* session.operations.click("#act");
        expect(yield* session.operations.readText()).toBe("initial");
        // Model actions are exhausted, while one independently charged host sample remains.
        yield* session.checkpoint({ picture: true });
        expect(yield* Effect.result(session.controlFacts(reference))).toMatchObject({
          _tag: "Failure",
          failure: {
            reason: { _tag: "Limit", dimension: "host-reads", maximum: 3, observed: 3 },
            outcome: "undispatched",
          },
        });
        expect(yield* Effect.result(session.observe())).toMatchObject({
          _tag: "Failure",
          failure: {
            reason: { _tag: "Limit", dimension: "actions", maximum: 2, observed: 2 },
            outcome: "undispatched",
          },
        });
        expect({ checkpoints, factReads, clicks: f.state.clicks }).toEqual({
          checkpoints: 2,
          factReads: 1,
          clicks: 1,
        });
        expect(yield* session.status).toMatchObject({
          phase: "open",
          reason: null,
          busy: false,
          unresolvedDispatch: false,
        });
        expect(yield* session.diagnostics).toMatchObject({
          records: [],
          total: 0,
          dropped: 0,
          truncated: false,
        });
        expect(f.state.releases).toBe(0);
      }),
    ),
);

it.effect("host reads retain permit and deadline bounds without claiming uncertain input", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const entered = gate<void>();
      const continueRead = gate<void>();
      const retired = gate<void>();
      let nativeReads = 0;

      const f = yield* fixture({
        actionMillis: 100,
        lifetimeMillis: 10000,
        maxHostReads: 1,
        onConnect: async (driver) => ({
          ...driver,
          checkpoint: async (...args) => {
            nativeReads++;
            entered.resolve();
            try {
              await continueRead.promise;

              return await driver.checkpoint(...args);
            } finally {
              retired.resolve();
            }
          },
        }),
      });

      const session = yield* (yield* f.acquisition).connect;

      const sampling = yield* Effect.forkChild(
        session.checkpoint({ picture: false }).pipe(Effect.result),
      );

      yield* Effect.promise(() => entered.promise);
      expect(yield* session.status).toMatchObject({
        phase: "open",
        busy: true,
        unresolvedDispatch: false,
      });
      expect(yield* Effect.result(session.controlFacts(reference))).toMatchObject({
        _tag: "Failure",
        failure: { reason: { _tag: "Busy" }, outcome: "undispatched" },
      });
      yield* TestClock.adjust(100);
      expect(yield* Fiber.join(sampling)).toMatchObject({
        _tag: "Failure",
        failure: { reason: { _tag: "Timeout" }, outcome: "undispatched" },
      });
      continueRead.resolve();
      yield* Effect.promise(() => retired.promise);
      expect(yield* Effect.result(session.checkpoint({ picture: false }))).toMatchObject({
        _tag: "Failure",
        failure: {
          reason: { _tag: "Limit", dimension: "host-reads", observed: 1 },
          outcome: "undispatched",
        },
      });
      yield* session.operations.click("#act");
      expect(nativeReads).toBe(1);
      expect(f.state.clicks).toBe(1);
      expect(yield* session.status).toMatchObject({
        phase: "open",
        reason: null,
        unresolvedDispatch: false,
      });
    }),
  ),
);
