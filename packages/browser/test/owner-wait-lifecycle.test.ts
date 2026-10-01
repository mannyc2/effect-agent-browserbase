import { expect, it } from "@effect/vitest";
import { Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";

import { Reasons } from "../src/Errors.ts";
import { failure } from "../src/internal/browser/NativeCalls.ts";
import type { WaitTicket } from "../src/internal/browser/Owner.ts";
import { fixture, gate } from "./fixtures/ScriptedOwner.ts";

const busy = {
  _tag: "Failure",
  failure: { reason: { _tag: "Busy" }, outcome: "undispatched" },
};

const reference = { observationId: "original", elementId: "button" };

it.effect("a pending wait releases admission for host reads while excluding conflicting work", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const entered = gate<void>();
      const admissionReleased = gate<void>();
      const finish = gate<void>();
      let waitTicket: WaitTicket | undefined;
      let nativeWaits = 0;
      let holds = 0;
      let observationReads = 0;
      const inputs: string[] = [];

      const f = yield* fixture({
        maxActions: 3,
        maxHostReads: 1,
        onConnect: async (driver) => ({
          ...driver,
          documentReadiness: async (ticket, target) => {
            ticket.signal.addEventListener("abort", () => admissionReleased.resolve(), {
              once: true,
            });

            return driver.documentReadiness(ticket, target);
          },
          click: async (_selector, ticket, capture, _policy, target) => {
            ticket.dispatch();
            inputs.push(target.pageId);

            return {
              url: "https://example.test/",
              input: await capture(async () => {}, { position: null }),
            };
          },
          observe: async (...args) => {
            observationReads++;

            return driver.observe(...args);
          },
          pageControl: {
            state: async (page) => ({ ...page, state: "running" }),
            checkTarget: async () => {},
            suspend: async (page) => {
              holds++;

              return { ...page, suspensionId: "hold" };
            },
            resume: async () => {
              holds++;
            },
          },
          waitFor: async (_selector, _state, ticket, target) => {
            nativeWaits++;
            waitTicket = ticket;
            expect(target).toEqual({ pageId: "page-1", frameId: "frame-1" });
            entered.resolve();
            try {
              await finish.promise;
              ticket.check();
            } finally {
              ticket.retire();
            }
          },
        }),
      });

      const session = yield* (yield* f.acquisition).connect;
      const first = (yield* session.listPages())[0];

      expect(first).toBeDefined();
      if (first === undefined) return;
      // The scout's page is a real second page, opened before the wait begins.
      const second = yield* session.createPage();

      const waiting = yield* Effect.forkChild(
        session.initialPage().controls.waitFor("#ready", "visible"),
      );

      yield* Effect.promise(() => entered.promise);
      // Native polling begins before the short guard returns. Cross that admission boundary once.
      yield* Effect.promise(() => admissionReleased.promise);
      expect(waitTicket?.signal.aborted).toBe(false);
      yield* session.initialPage().controls.checkpoint({ picture: false });
      expect(yield* session.listPages()).toHaveLength(2);
      expect(yield* session.status).toMatchObject({
        phase: "open",
        busy: true,
        unresolvedDispatch: false,
      });
      expect(yield* Effect.result(session.initialPage().controls.observe())).toMatchObject(busy);
      expect(
        yield* Effect.result(session.initialPage().controls.operations.click("#act")),
      ).toMatchObject(busy);
      expect(
        yield* Effect.result(
          session.initialPage().controls.operations.navigate("https://example.test/next"),
        ),
      ).toMatchObject(busy);
      expect(
        yield* Effect.result(session.initialPage().controls.pageControl.suspend(first)),
      ).toMatchObject(busy);
      expect(
        yield* Effect.result(
          session.initialPage().controls.pageControl.resume({
            pageId: "page-1",
            targetId: "target-1",
            suspensionId: "x",
          }),
        ),
      ).toMatchObject(busy);
      expect(
        yield* Effect.result(session.initialPage().controls.waitFor("#other", "attached")),
      ).toMatchObject(busy);
      const scout = yield* session.page(second).pipe(Effect.map((page) => page.controls));

      yield* scout.operations.click("#scout");
      yield* session.selectPage(second);
      expect(waitTicket?.signal.aborted).toBe(false);
      yield* session.selectPage(first);
      finish.resolve();
      yield* Fiber.join(waiting);
      yield* session.initialPage().controls.operations.click("#act");
      expect(inputs).toEqual(["page-2", "page-1"]);
      expect({ nativeWaits, holds, observationReads }).toEqual({
        nativeWaits: 1,
        holds: 0,
        observationReads: 0,
      });
      expect(yield* session.status).toMatchObject({
        phase: "open",
        busy: false,
        unresolvedDispatch: false,
      });
    }),
  ),
);

it.effect(
  "canceling a pure wait releases its barrier but keeps uncancellable native capacity",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const entered = gate<void>();
        const finish = gate<void>();
        const retired = gate<void>();
        let calls = 0;
        let original: WaitTicket | undefined;

        const f = yield* fixture({
          onConnect: async (driver) => ({
            ...driver,
            waitForElement: async (_ref, _state, ticket) => {
              calls++;
              if (calls === 1) {
                original = ticket;
                entered.resolve();
                await finish.promise;
              }
              ticket.retire();
              retired.resolve();
              ticket.check();
            },
          }),
        });

        const session = yield* (yield* f.acquisition).connect;

        const waiting = yield* Effect.forkChild(
          session.initialPage().controls.waitForElement({ reference, state: "enabled" }),
        );

        yield* Effect.promise(() => entered.promise);
        yield* Fiber.interrupt(waiting);
        expect(Exit.hasInterrupts(yield* Fiber.await(waiting))).toBe(true);
        expect(original?.signal.aborted).toBe(true);
        yield* session
          .initialPage()
          .controls.observe(undefined, { admission: { queue: "1 second" } });
        yield* session.initialPage().controls.operations.click("#act");
        for (let i = 0; i < 3; i++)
          expect(
            yield* Effect.result(
              session.initialPage().controls.waitForElement({ reference, state: "hidden" }),
            ),
          ).toMatchObject(busy);
        expect(calls).toBe(1);
        expect(yield* session.status).toMatchObject({
          phase: "open",
          busy: true,
          unresolvedDispatch: false,
        });
        finish.resolve();
        yield* Effect.promise(() => retired.promise);
        yield* session.initialPage().controls.waitForElement({ reference, state: "hidden" });
        expect(calls).toBe(2);
        expect(yield* session.status).toMatchObject({
          phase: "open",
          busy: false,
          unresolvedDispatch: false,
        });
      }),
    ),
);

it.effect("the wait deadline includes readiness and cannot widen host policy", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const preparing = gate<void>();
      const ready = gate<void>();
      const entered = gate<void>();
      const finish = gate<void>();
      const retired = gate<void>();
      let remaining = 0;

      const f = yield* fixture({
        actionMillis: 100,
        onConnect: async (driver) => ({
          ...driver,
          documentReadiness: async (ticket, target) => {
            preparing.resolve();
            await ready.promise;

            return driver.documentReadiness(ticket, target);
          },
          waitForElement: async (_ref, _state, ticket) => {
            remaining = ticket.remainingMillis();
            entered.resolve();
            await finish.promise;
            ticket.retire();
            retired.resolve();
          },
        }),
      });

      const session = yield* (yield* f.acquisition).connect;

      const waiting = yield* Effect.forkChild(
        session
          .initialPage()
          .controls.waitForElement({ reference, state: "visible", timeoutMillis: 60000 })
          .pipe(Effect.result),
      );

      yield* Effect.promise(() => preparing.promise);
      yield* TestClock.adjust(40);
      ready.resolve();
      yield* Effect.promise(() => entered.promise);
      expect(remaining).toBe(60);
      yield* TestClock.adjust(60);
      expect(yield* Fiber.join(waiting)).toMatchObject({
        _tag: "Failure",
        failure: { reason: { _tag: "Timeout" }, outcome: "undispatched" },
      });
      expect(yield* session.status).toMatchObject({ phase: "open", unresolvedDispatch: false });
      finish.resolve();
      yield* Effect.promise(() => retired.promise);
    }),
  ),
);

it.effect("canceled readiness retains capacity until settlement and cannot start a late wait", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const entered = gate<void>();
      const finish = gate<void>();
      const readyRetired = gate<void>();
      let waits = 0;

      const f = yield* fixture({
        onConnect: async (driver) => ({
          ...driver,
          documentReadiness: async (ticket, target) => {
            entered.resolve();
            try {
              await finish.promise;

              return await driver.documentReadiness(ticket, target);
            } finally {
              readyRetired.resolve();
            }
          },
          waitFor: async (_selector, _state, ticket) => {
            waits++;
            ticket.retire();
          },
        }),
      });

      const session = yield* (yield* f.acquisition).connect;

      const waiting = yield* Effect.forkChild(
        session.initialPage().controls.waitFor("#ready", "attached"),
      );

      yield* Effect.promise(() => entered.promise);
      yield* Fiber.interrupt(waiting);
      yield* session.listPages();
      expect(
        yield* Effect.result(session.initialPage().controls.waitFor("#next", "visible")),
      ).toMatchObject(busy);
      finish.resolve();
      yield* Effect.promise(() => readyRetired.promise);
      // Let the raw readiness caller execute its retirement finally before the next admission.
      yield* Effect.yieldNow;
      yield* session.initialPage().controls.waitFor("#next", "visible");
      expect(waits).toBe(1);
    }),
  ),
);

it.effect("closing a wait and a concurrent host read prevents either from succeeding late", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const waitingEntered = gate<void>();
      const readEntered = gate<void>();
      const finishWait = gate<void>();
      const finishRead = gate<void>();
      const waitRetired = gate<void>();
      const readRetired = gate<void>();

      const f = yield* fixture({
        onConnect: async (driver, events) => ({
          ...driver,
          waitFor: async (_selector, _state, ticket) => {
            waitingEntered.resolve();
            await finishWait.promise;
            ticket.retire();
            waitRetired.resolve();
          },
          checkpoint: async (...args) => {
            readEntered.resolve();
            try {
              await finishRead.promise;

              return await driver.checkpoint(...args);
            } finally {
              readRetired.resolve();
            }
          },
          disconnect: async () => {
            await driver.disconnect();
            events.retired?.();
          },
        }),
      });

      const session = yield* (yield* f.acquisition).connect;

      const waiting = yield* Effect.forkChild(
        session.initialPage().controls.waitFor("#ready", "visible").pipe(Effect.result),
      );

      yield* Effect.promise(() => waitingEntered.promise);

      const reading = yield* Effect.forkChild(
        session.initialPage().controls.checkpoint({ picture: false }).pipe(Effect.result),
      );

      yield* Effect.promise(() => readEntered.promise);
      yield* session.close;
      expect((yield* Fiber.join(waiting))._tag).toBe("Failure");
      expect((yield* Fiber.join(reading))._tag).toBe("Failure");
      finishWait.resolve();
      finishRead.resolve();
      yield* Effect.promise(() => Promise.all([waitRetired.promise, readRetired.promise]));
      expect(yield* session.status).toMatchObject({
        phase: "closed",
        busy: false,
        unresolvedDispatch: false,
      });
      expect({ closes: f.state.localCloses, releases: f.state.releases }).toEqual({
        closes: 1,
        releases: 1,
      });
    }),
  ),
);

it.effect("a held page refuses wait admission without starting native polling", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let calls = 0;

      const f = yield* fixture({
        onConnect: async (driver) => ({
          ...driver,
          pageControl: {
            state: async (page) => ({ ...page, state: "suspended" }),
            suspend: async (page) => ({ ...page, suspensionId: "existing" }),
            resume: async () => {},
            checkTarget: async () => {
              throw failure(Reasons.Busy.make({}), "undispatched");
            },
          },
          waitFor: async (_selector, _state, ticket) => {
            calls++;
            ticket.retire();
          },
        }),
      });

      const session = yield* (yield* f.acquisition).connect;

      expect(
        yield* Effect.result(session.initialPage().controls.waitFor("#ready", "visible")),
      ).toMatchObject(busy);
      expect(calls).toBe(0);
      expect(yield* session.status).toMatchObject({
        phase: "open",
        busy: false,
        unresolvedDispatch: false,
      });
    }),
  ),
);

it.effect("a handoff refuses a pending pure wait instead of draining it into uncertainty", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const entered = gate<void>();
      const admissionReleased = gate<void>();
      const finish = gate<void>();

      const f = yield* fixture({
        onConnect: async (driver) => ({
          ...driver,
          documentReadiness: async (ticket, target) => {
            ticket.signal.addEventListener("abort", () => admissionReleased.resolve(), {
              once: true,
            });

            return driver.documentReadiness(ticket, target);
          },
          // The condition never holds, and the native wait outlives every caller.
          waitFor: async (_selector, _state, ticket) => {
            entered.resolve();
            try {
              await finish.promise;
            } finally {
              ticket.retire();
            }
          },
        }),
      });

      const session = yield* (yield* f.acquisition).connect;

      const waiting = yield* Effect.forkChild(
        session.initialPage().controls.waitFor("#never", "visible"),
      );

      yield* Effect.promise(() => entered.promise);
      // The wait's own admission ends once native polling starts.
      yield* Effect.promise(() => admissionReleased.promise);
      const handoff = yield* session.beginHandoff(Effect.succeed("view"));

      expect(handoff.view).toBe("view");
      expect(yield* session.status).toMatchObject({
        phase: "paused",
        reason: "handoff",
        unresolvedDispatch: false,
      });
      expect(yield* Fiber.join(waiting).pipe(Effect.flip)).toMatchObject({
        reason: { _tag: "Stale" },
        outcome: "undispatched",
      });
      finish.resolve();
    }),
  ),
);

it.effect("a handoff that cannot drain in time fails and leaves automation running", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const loaded = gate<string>();

      const f = yield* fixture({
        lifetimeMillis: 20000,
        onNavigate: (_url, pageId) => ({
          pageId,
          settled: loaded.promise,
          stop: async () => "settled",
        }),
      });

      const session = yield* (yield* f.acquisition).connect;

      const navigation = yield* session
        .initialPage()
        .controls.operations.startNavigation("https://example.test/slow");

      // The navigation is still loading, so the drain cannot finish before its bound.
      const handoff = yield* Effect.forkChild(session.beginHandoff(Effect.succeed("view")));

      yield* TestClock.adjust(3000);
      const refused = yield* Fiber.join(handoff).pipe(Effect.flip);

      expect(refused).toMatchObject({
        operation: "handoff",
        reason: { _tag: "Timeout" },
        outcome: "undispatched",
        containment: { _tag: "NotRequired" },
      });
      expect(yield* session.status).toMatchObject({ phase: "open", reason: null });
      loaded.resolve("https://example.test/slow");
      expect(yield* navigation.completed).toBe("https://example.test/slow");
      yield* session.initialPage().controls.operations.click("#act");
      expect(f.state.clicks).toBe(1);
    }),
  ),
);
