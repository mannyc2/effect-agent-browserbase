import { expect, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Scope } from "effect";
import { TestClock } from "effect/testing";

import { Reasons } from "../src/Errors.ts";
import * as Plan from "../src/Plan.ts";
import * as Testing from "../src/Testing.ts";

const origin = "https://record.test";

const script: Testing.Script = {
  documents: [
    {
      url: `${origin}/`,
      title: "Sign in",
      text: "Sign in.",
      controls: [{ id: "name", kind: "input", label: "Name", inputType: "text" }],
    },
  ],
};

it.effect("a recorded plan names its input slots, so it replays without the literal", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* Testing.open(script);
      const page = browser.initialPage;

      yield* page.navigate({ url: `${origin}/` });

      const ran = yield* page.run({
        version: 1,
        steps: [
          {
            id: "name",
            action: {
              _tag: "Fill",
              target: { _tag: "Descriptor", descriptor: { kind: "input", label: "Name" } },
              value: { _tag: "Literal", value: "secret-literal" },
            },
          },
        ],
      });

      const recorded = yield* Plan.recorded(ran);
      const slots = Plan.inputSlots(recorded);

      expect(slots).toEqual([
        { name: expect.any(String), stepId: "name", path: ["value"], kind: "value" },
      ]);
      expect(JSON.stringify(yield* Plan.encode(recorded))).not.toContain("secret-literal");

      const [slot] = slots;

      if (slot === undefined) return;
      yield* page.run(recorded, { inputs: { [slot.name]: "replayed" } });
      expect((yield* browser.control.document.values).get("name")).toBe("replayed");
    }),
  ),
);

it.effect("a settled navigation records what it asked for as one Navigate step", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* Testing.open(script);
      const page = browser.initialPage;
      const gate = yield* browser.control.gate;

      yield* browser.control.next("navigate", { _tag: "Hold", gate, dispatched: true });

      const operation = yield* page.startNavigation({ url: `${origin}/`, timeoutMillis: 5000 });

      yield* gate.reached;

      // Recording joins `completed`; abandoning that join leaves the navigation loading.
      const abandoned = yield* Plan.recordedNavigation(operation).pipe(
        Effect.forkChild({ startImmediately: true }),
      );

      yield* Fiber.interrupt(abandoned);
      const recording = yield* Plan.recordedNavigation(operation).pipe(Effect.forkChild);

      yield* gate.open;
      const recorded = yield* Fiber.join(recording);

      expect(recorded).toEqual({
        version: 1,
        steps: [
          {
            id: "navigate",
            action: { _tag: "Navigate", url: `${origin}/`, timeoutMillis: 5000 },
            resolution: { _tag: "Strict" },
          },
        ],
      });
      expect(yield* Plan.decode(yield* Plan.encode(recorded))).toEqual(recorded);
      expect(
        (yield* Plan.recordedNavigation(operation, { id: "browser_navigate" })).steps[0]?.id,
      ).toBe("browser_navigate");
      expect(
        yield* Plan.recordedNavigation(operation, { id: "not an id" }).pipe(Effect.flip),
      ).toMatchObject({ stepId: "not an id", reason: "IncompleteCapture" });

      const ran = yield* page.run(recorded);

      expect(ran.steps[0]?.receipt).toEqual({ url: `${origin}/` });
      expect(
        (yield* browser.control.calls).filter((call) => call.operation === "navigate"),
      ).toHaveLength(2);
    }),
  ),
);

it.effect.each([
  ["stopped", "Interrupted"],
  ["failed", "Provider"],
  ["timed-out", "Timeout"],
  ["abandoned", "Stale"],
] as const)("a %s navigation is refused Unacknowledged", ([ending, reason]) =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* Testing.open(script, {
        automation: { actionTimeoutMillis: 5_000 },
      });

      const gate = yield* browser.control.gate;

      yield* browser.control.next(
        "navigate",
        ending === "failed"
          ? { _tag: "Fail", reason: Reasons.Provider.make({}), outcome: "unknown" }
          : { _tag: "Hold", gate, dispatched: true },
      );

      // Its own scope, so the abandoned navigation can leave it unsettled.
      const scope = yield* Scope.make();

      const operation = yield* browser.initialPage
        .startNavigation({ url: `${origin}/` })
        .pipe(Scope.provide(scope));

      if (ending !== "failed") yield* gate.reached;
      if (ending === "stopped") yield* operation.stop;
      if (ending === "timed-out") yield* TestClock.adjust("5 seconds");
      if (ending === "abandoned") yield* Scope.close(scope, Exit.void);

      expect(yield* operation.completed.pipe(Effect.flip)).toMatchObject({
        reason: { _tag: reason },
        outcome: "unknown",
      });
      expect(yield* Plan.recordedNavigation(operation).pipe(Effect.flip)).toMatchObject({
        _tag: "RecordingIncomplete",
        stepId: "navigate",
        reason: "Unacknowledged",
      });
      yield* Scope.close(scope, Exit.void);
    }),
  ),
);
