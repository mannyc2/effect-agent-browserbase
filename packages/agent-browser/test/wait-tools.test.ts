import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Scope, Stream } from "effect";
import * as Tools from "effect-agent-browser/tools";
import { BrowserError, Reasons } from "effect-browser/errors";
import { TestClock } from "effect/testing";
import { Toolkit } from "effect/unstable/ai";

import { scriptedSession } from "./fixtures/ScriptedSession.ts";

const reference = { observationId: "observed", elementId: "control" };

it.effect(
  "wait tools pass only bounded exact-node conditions and preserve native refusal facts",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let calls = 0;

        const error = BrowserError.make({
          operation: "wait",
          reason: Reasons.Timeout.make({}),
          outcome: "undispatched",
        });

        const browser = scriptedSession({
          waitForElement: (request) =>
            Effect.suspend(() => {
              calls++;
              expect(request).toEqual({ reference, state: "enabled", timeoutMillis: 100 });

              return Effect.fail(error);
            }),
        });

        const host = yield* Tools.makeHost(browser);
        const ready = yield* Tools.waitToolkit.pipe(Effect.provide(host.waitHandlers));

        const result = yield* Stream.runCollect(
          yield* ready.handle(
            "browser_wait_for",
            { reference, state: "enabled", timeoutMillis: 100 },
            "wait-once",
          ),
        );

        expect(result).toMatchObject([
          { isFailure: true, encodedResult: { reason: "timeout", outcome: "undispatched" } },
        ]);
        expect(calls).toBe(1);
        expect((yield* host.toolFailures).failures).toMatchObject([
          {
            error: { operation: "wait", reason: { _tag: "Timeout" }, outcome: "undispatched" },
            toolCallId: "wait-once",
          },
        ]);
        for (const request of [
          { selector: "#replacement", state: "visible" },
          { reference, state: "javascript", script: "PRIVATE" },
          { reference, state: "enabled", timeoutMillis: 0 },
          { reference, state: "enabled", timeoutMillis: 60001 },
        ]) {
          expect(
            // @ts-expect-error Negative runtime coverage deliberately violates the declared Tool request.
            yield* Stream.runCollect(yield* ready.handle("browser_wait_for", request)),
          ).toMatchObject([{ isFailure: true }]);
        }
        expect(calls).toBe(1);
        expect(Tools.toolkit.tools).not.toHaveProperty("browser_wait_for");
      }),
    ),
);

it.effect(
  "wait and mutation tools share one host invocation lane while direct reads stay outside",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let inputs = 0;
        let reads = 0;

        const browser = scriptedSession({
          waitForElement: () =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
          pages: Effect.sync(() => {
            reads++;

            return [];
          }),
          scroll: () =>
            Effect.sync(() => {
              inputs++;

              return { url: "https://example.test/" };
            }),
        });

        const host = yield* Tools.makeHost(browser);

        const ready = yield* Toolkit.merge(Tools.waitToolkit, Tools.toolkit).pipe(
          Effect.provide(host.layer),
        );

        const wait = yield* ready
          .handle("browser_wait_for", { reference, state: "hidden" })
          .pipe(Effect.flatMap(Stream.runCollect), Effect.forkScoped);

        yield* Deferred.await(entered);

        const input = yield* ready
          .handle("browser_scroll", { deltaX: 0, deltaY: 1 })
          .pipe(Effect.flatMap(Stream.runCollect), Effect.forkScoped);

        yield* TestClock.adjust(1);
        expect(yield* browser.pages).toEqual([]);
        expect(reads).toBe(1);
        expect(inputs).toBe(0);
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(wait)).toMatchObject([
          { isFailure: false, encodedResult: { satisfied: true } },
        ]);
        expect(yield* Fiber.join(input)).toMatchObject([{ isFailure: false }]);
        expect(inputs).toBe(1);
      }),
    ),
);

it.effect(
  "closing a raw handler host cancels its active wait and queued tool without late calls",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Scope.fork(yield* Scope.Scope, "sequential");
        const entered = yield* Deferred.make<void>();
        let waits = 0;
        let cancellations = 0;
        let inputs = 0;

        const browser = scriptedSession({
          waitForElement: () =>
            Effect.sync(() => {
              waits++;
            }).pipe(
              Effect.andThen(Deferred.succeed(entered, undefined)),
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Effect.sync(() => {
                  cancellations++;
                }),
              ),
            ),
          scroll: () =>
            Effect.sync(() => {
              inputs++;

              return { url: "https://example.test/" };
            }),
        });

        const host = yield* Tools.makeHost(browser).pipe(Scope.provide(scope));

        const ready = yield* Toolkit.merge(Tools.waitToolkit, Tools.toolkit).pipe(
          Effect.provide(host.layer),
        );

        const waiting = yield* ready
          .handle("browser_wait_for", { reference, state: "visible" })
          .pipe(Effect.flatMap(Stream.runCollect), Effect.exit, Effect.forkScoped);

        yield* Deferred.await(entered);

        const queued = yield* ready
          .handle("browser_scroll", { deltaX: 0, deltaY: 1 })
          .pipe(Effect.flatMap(Stream.runCollect), Effect.exit, Effect.forkScoped);

        yield* TestClock.adjust(1);
        yield* Scope.close(scope, Exit.void);
        expect(Exit.isFailure(yield* Fiber.join(waiting))).toBe(true);
        expect(Exit.isFailure(yield* Fiber.join(queued))).toBe(true);
        expect(waits).toBe(1);
        expect(cancellations).toBe(1);
        expect(inputs).toBe(0);
        expect(
          yield* Stream.runCollect(
            yield* ready.handle("browser_wait_for", { reference, state: "visible" }),
          ),
        ).toMatchObject([
          { isFailure: true, encodedResult: { reason: "closed", outcome: "undispatched" } },
        ]);
        expect(waits).toBe(1);
      }),
    ),
);
