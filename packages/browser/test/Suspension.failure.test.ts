// Independent native regressions for script-mutation acknowledgements and guards that finish
// during a handoff. These paths do not use the keyboard's explicit reply tracking.
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Scope } from "effect";

import * as Chromium from "../src/Chromium.ts";

const owner = Effect.gen(function* () {
  const scope = yield* Scope.make();

  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));

  return scope;
});

describe("Input suspension failure boundaries", () => {
  it.live("retains a canceled script mutation until its native acknowledgement arrives", () =>
    Effect.gen(function* () {
      const browser = yield* Chromium.open();
      const create = browser.context.newCDPSession.bind(browser.context);
      const arrived = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();

      browser.context.newCDPSession = async (target) => {
        const session = await create(target);
        const send = session.send.bind(session);

        session.send = (method, params) => {
          const reply = send(method, params);

          const selection =
            method === "Runtime.evaluate" &&
            params !== undefined &&
            "expression" in params &&
            typeof params.expression === "string" &&
            params.expression.includes("globalThis.__effectBrowser.select(");

          return selection
            ? reply.then(async (result) => {
                arrived.resolve();
                await release.promise;

                return result;
              })
            : reply;
        };

        return session;
      };
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          release.resolve();
          browser.context.newCDPSession = create;
        }),
      );
      const page = yield* browser.newPage();

      yield* Effect.promise(() =>
        page.playwright.setContent(
          '<select aria-label="Choice"><option>One</option><option>Two</option></select>',
        ),
      );
      const [choice] = yield* page.find({ role: "combobox", name: "Choice" });
      const action = yield* page.select(choice?.ref ?? "", ["Two"]).pipe(Effect.forkChild);

      yield* Effect.promise(() => arrived.promise);
      assert.strictEqual(
        yield* Effect.promise(() => page.playwright.locator("select").inputValue()),
        "Two",
      );
      yield* Fiber.interrupt(action);
      const held = yield* owner;
      const stopping = yield* browser.suspend().pipe(Scope.provide(held), Effect.forkChild);

      yield* Effect.sleep("30 millis");
      assert.isUndefined(stopping.pollUnsafe(), "cancellation must retain the unanswered mutation");
      yield* Effect.sync(() => release.resolve());
      const stopped = yield* Fiber.join(stopping);

      const actionRecord = (yield* browser.recentEvents).findLast(
        (event) => event._tag === "Action",
      );

      assert.strictEqual(
        actionRecord?._tag === "Action" ? actionRecord.error : undefined,
        "interrupted",
      );
      assert.isTrue(actionRecord?._tag === "Action" && actionRecord.dispatched);
      assert.isAtMost(actionRecord?.at ?? Infinity, stopped.at);
      assert.strictEqual((yield* Effect.flip(page.press("a"))).reason._tag, "Suspended");
    }).pipe(Effect.scoped),
  );

  it.live("refuses input whose pending guard approves after suspension has acquired", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const allow = yield* Deferred.make<void>();

      const browser = yield* Chromium.open({
        guard: () =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(allow))),
      });

      const page = yield* browser.newPage();

      yield* Effect.promise(() => page.playwright.setContent("<input autofocus>"));
      const action = yield* page.press("a").pipe(Effect.flip, Effect.forkChild);

      yield* Deferred.await(entered);
      const held = yield* owner;

      yield* browser.suspend({ drain: 0 }).pipe(Scope.provide(held));
      yield* Deferred.succeed(allow, undefined);
      const error = yield* Fiber.join(action);

      assert.strictEqual(error.reason._tag, "Suspended");
      assert.isFalse(error.dispatched);
      assert.strictEqual(
        yield* Effect.promise(() => page.playwright.locator("input").inputValue()),
        "",
      );
    }).pipe(Effect.scoped),
  );
});
