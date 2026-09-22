import { expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import * as Bootstrap from "../../packages/browser/src/Bootstrap.ts";
import { ObservedElement } from "../../packages/browser/src/BrowserData.ts";
import { makeBindings } from "../../packages/browser/src/internal/browser/Bindings.ts";
import type { Driver } from "../../packages/browser/src/internal/browser/Driver.ts";
import { makeSession } from "../../packages/browser/src/internal/browser/PublicSession.ts";
import { fixture, gate } from "./fixtures/ScriptedProvider.ts";

const reference = ObservedElement.make({
  observationId: "observation-test",
  elementId: "element-0",
});

/** Script only native completion; the public schema, session owner and fences are real. */
const open = Effect.fnUntraced(function* (selectOption: Driver["selectOption"]) {
  const bindings = yield* makeBindings(Bootstrap.empty);

  const f = yield* fixture({
    lifetimeMillis: 10000,
    actionMillis: 100,
    connectBindings: bindings.connect,
    onConnect: async (driver) => ({ ...driver, selectOption }),
  });

  return makeSession(yield* (yield* f.acquisition).rawConnect, bindings);
});

it.effect(
  "selection rejects unbounded, duplicate and label/value objects before native admission",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let calls = 0;

        const session = yield* open(async () => {
          calls++;

          return "https://example.test/";
        });

        for (const options of [
          [],
          ["element-1", "element-1"],
          Array.from({ length: 65 }, (_, i) => `element-${i}`),
          [{ label: "Duplicate" }],
          [{ value: "PRIVATE-VALUE" }],
          ["#option"],
          "element-1",
        ]) {
          // Exercise untyped callers at the actual public boundary.
          expect(
            yield* Effect.result(session.selectOption(reference, options as never)),
          ).toMatchObject({
            _tag: "Failure",
            failure: {
              operation: "select-option",
              reason: { _tag: "Configuration" },
              outcome: "undispatched",
            },
          });
        }
        expect(calls).toBe(0);
        expect((yield* session.status).phase).toBe("open");
      }),
    ),
);

it.effect.each(["before", "after"] as const)(
  "selection timeout %s dispatch keeps accurate outcomes and fences late native work",
  (position) =>
    Effect.scoped(
      Effect.gen(function* () {
        const entered = gate<void>();
        const release = gate<void>();
        const retired = gate<void>();
        let dispatches = 0;

        const session = yield* open(async (_target, _options, ticket) => {
          try {
            if (position === "after") {
              ticket.dispatch();
              dispatches++;
            }
            entered.resolve();
            await release.promise;
            if (position === "before") {
              ticket.dispatch();
              dispatches++;
            }
            ticket.check();

            return "https://example.test/";
          } finally {
            retired.resolve();
          }
        });

        const selecting = yield* session
          .selectOption(reference, ["element-1"])
          .pipe(Effect.result, Effect.forkChild);

        yield* Effect.promise(() => entered.promise);
        expect(yield* Effect.result(session.selectOption(reference, ["element-2"]))).toMatchObject({
          _tag: "Failure",
          failure: { reason: { _tag: "Busy" }, outcome: "undispatched" },
        });
        yield* TestClock.adjust(100);
        expect(yield* Fiber.join(selecting)).toMatchObject({
          _tag: "Failure",
          failure: {
            operation: "select-option",
            reason: { _tag: "Timeout" },
            outcome: position === "before" ? "undispatched" : "unknown",
          },
        });
        release.resolve();
        yield* Effect.promise(() => retired.promise);
        expect(dispatches).toBe(position === "before" ? 0 : 1);
        expect((yield* session.status).phase).toBe(position === "before" ? "open" : "uncertain");
        if (position === "before") expect((yield* session.readText({})).text).toBe("initial");
        else
          expect(
            yield* Effect.result(session.selectOption(reference, ["element-1"])),
          ).toMatchObject({
            _tag: "Failure",
            failure: { reason: { _tag: "Closed" }, outcome: "undispatched" },
          });
      }),
    ),
);

it.effect("closing a session cancels selection admission before any late dispatch", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const entered = gate<void>();
      const release = gate<void>();
      const retired = gate<void>();
      let dispatches = 0;

      const session = yield* open(async (_target, _options, ticket) => {
        entered.resolve();
        await release.promise;
        try {
          ticket.dispatch();
          dispatches++;

          return "https://example.test/";
        } finally {
          retired.resolve();
        }
      });

      const selecting = yield* session
        .selectOption(reference, ["element-1"])
        .pipe(Effect.result, Effect.forkChild);

      yield* Effect.promise(() => entered.promise);
      yield* session.closeChecked;
      expect(yield* Fiber.join(selecting)).toMatchObject({
        _tag: "Failure",
        failure: { operation: "select-option", outcome: "undispatched" },
      });
      release.resolve();
      yield* Effect.promise(() => retired.promise);
      expect(dispatches).toBe(0);
      expect((yield* session.status).phase).toBe("closed");
    }),
  ),
);
