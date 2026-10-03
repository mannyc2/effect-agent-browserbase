import { expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import * as Plan from "../src/Plan.ts";
import * as Testing from "../src/Testing.ts";

const point = { x: 40, y: 50 };

const script: Testing.Script = {
  documents: [
    {
      url: "https://point.test/",
      text: "Fixed layout",
      controls: [
        {
          id: "toggle",
          kind: "input",
          inputType: "checkbox",
          label: "Canvas region",
          facts: { box: { x: 20, y: 30, width: 80, height: 60 } },
        },
      ],
    },
  ],
};

it.effect(
  "a point press stays on its Page, carries actual coordinates and retires its references",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const browser = yield* Testing.open(script);
        const page = browser.initialPage;
        const observed = yield* page.observe();
        const peer = yield* browser.createPage();

        yield* browser.selectPage(peer);
        expect(yield* page.pointerClick(point)).toMatchObject({
          kind: "click",
          position: point,
          target: page.identity,
        });
        expect(
          (yield* page.observe()).controls.find((control) => control.elementId === "toggle")
            ?.checked,
        ).toBe(true);
        expect(
          yield* page
            .clickElement({ observationId: observed.observationId, elementId: "toggle" })
            .pipe(Effect.flip),
        ).toMatchObject({ reason: { _tag: "Stale" }, outcome: "undispatched" });

        const presses = (yield* page.timeline.snapshot()).events.filter(
          (event) => event.event._tag === "Press",
        );

        expect(presses).toMatchObject([
          { target: { pageId: page.identity.pageId }, event: { _tag: "Press", position: point } },
        ]);
        expect((yield* peer.wheel({ deltaX: 0, deltaY: 0 })).position).toBeNull();
      }),
    ),
);

it.effect("point recording preserves coordinates and button/count without resolving a node", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* Testing.open(script);
      const page = browser.initialPage;

      const action = {
        _tag: "PointerClick" as const,
        at: point,
        button: "right" as const,
        clickCount: 2 as const,
      };

      const ran = yield* page.run(
        { version: 1, steps: [{ id: "canvas", action }] },
        { policy: { admit: () => false }, coordinatePolicy: { admit: () => true } },
      );

      const recorded = yield* Plan.recorded(ran);

      expect(recorded.steps[0]?.action).toEqual(action);
      expect(yield* Plan.decode(yield* Plan.encode(recorded))).toEqual(recorded);
      expect(
        (yield* browser.control.calls).filter((call) => call.operation === "resolve"),
      ).toHaveLength(0);
      yield* page.run(recorded);
      expect(
        (yield* page.observe()).controls.find((control) => control.elementId === "toggle")?.checked,
      ).toBe(false);
    }),
  ),
);

it.effect("an element admission policy does not implicitly authorize coordinate plan input", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* Testing.open(script);
      const page = browser.initialPage;

      const plan = {
        version: 1 as const,
        steps: [{ id: "point", action: { _tag: "PointerClick" as const, at: point } }],
      };

      for (const admit of [() => false, () => true]) {
        const failure = yield* page.run(plan, { policy: { admit } }).pipe(Effect.flip);

        expect(failure).toMatchObject({
          error: { reason: { _tag: "Denied" }, outcome: "undispatched" },
        });
      }
      expect(
        (yield* browser.control.calls).filter((call) => call.operation === "pointer-click"),
      ).toHaveLength(0);
      expect((yield* page.observe()).controls[0]?.checked).toBe(false);
      yield* page.run(plan, {
        policy: { admit: () => false },
        coordinatePolicy: { admit: () => true },
      });
      expect((yield* page.observe()).controls[0]?.checked).toBe(true);
    }),
  ),
);

it.effect(
  "coordinate policies and viewport bounds refuse before input, with the Page still usable",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const browser = yield* Testing.open(script);
        const page = browser.initialPage;

        for (const admit of [
          () => false,
          () => {
            throw new Error("Host refusal");
          },
        ])
          expect(
            yield* page.pointerClick(point, { coordinatePolicy: { admit } }).pipe(Effect.flip),
          ).toMatchObject({ reason: { _tag: "Denied" }, outcome: "undispatched" });
        expect(yield* page.pointerClick({ x: 16384, y: 0 }).pipe(Effect.flip)).toMatchObject({
          reason: { _tag: "NotVisible" },
          outcome: "undispatched",
        });
        expect(
          yield* page
            .run(
              { version: 1, steps: [{ id: "point", action: { _tag: "PointerClick", at: point } }] },
              { coordinatePolicy: { admit: () => false } },
            )
            .pipe(Effect.flip),
        ).toMatchObject({ error: { reason: { _tag: "Denied" }, outcome: "undispatched" } });
        const invalidOptions = { coordinatePolicy: { admit: true } };

        // @ts-expect-error Invalid host configuration must be refused before driver entry.
        const invalid = yield* page.pointerClick(point, invalidOptions).pipe(Effect.flip);

        expect(invalid).toMatchObject({
          reason: { _tag: "Configuration" },
          outcome: "undispatched",
        });
        expect(
          (yield* page.observe()).controls.find((control) => control.elementId === "toggle")
            ?.checked,
        ).toBe(false);
        yield* page.pointerClick(point, {
          coordinatePolicy: { admit: (sample) => sample.x === 40 },
        });
        expect(
          (yield* page.observe()).controls.find((control) => control.elementId === "toggle")
            ?.checked,
        ).toBe(true);
      }),
    ),
);

it.effect("an unresolved point click is contained on its exact Page and never replayed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* Testing.open(script);
      const page = browser.initialPage;
      const peer = yield* browser.createPage();
      const gate = yield* browser.control.gate;

      yield* browser.control.next("pointer-click", { _tag: "Hold", gate, dispatched: true });

      const pending = yield* page
        .pointerClick(point, { timeoutMillis: 50 })
        .pipe(Effect.flip, Effect.forkChild);

      yield* gate.reached;
      yield* TestClock.adjust(51);
      expect(yield* Fiber.join(pending)).toMatchObject({
        outcome: "unknown",
        containment: { _tag: "PageClosed" },
      });
      yield* peer.pointerClick(point);
      expect(
        (yield* browser.control.calls).filter((call) => call.operation === "pointer-click"),
      ).toHaveLength(2);
      yield* gate.open;
    }),
  ),
);
