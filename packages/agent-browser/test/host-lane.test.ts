import { expect, it } from "@effect/vitest";
import { Context, Deferred, Effect, Exit, Fiber, Layer, Scope, Stream } from "effect";
import * as BrowserTools from "effect-agent-browser/tools";
import { ActionResult, InputReceipt, NavigationResult, Target } from "effect-browser/browser-data";
import { BrowserError, InitializationError, Reasons } from "effect-browser/errors";
import { TestClock } from "effect/testing";
import { Toolkit } from "effect/unstable/ai";

import { scriptedSession } from "./fixtures/ScriptedSession.ts";

const allTools = Toolkit.merge(
  BrowserTools.toolkit,
  BrowserTools.nativeToolkit,
  BrowserTools.keyboardToolkit,
  BrowserTools.selectionToolkit,
);

type Ready = Toolkit.WithHandler<Toolkit.Tools<typeof allTools>>;
const url = "https://example.test/";
const target = Target.make({ generation: 1, pageId: "page-1", frameId: "frame-1" });
const reference = { observationId: "observed-1", elementId: "element-1" };
const result = ActionResult.make({ url });

const receipt = (kind: InputReceipt["kind"]) =>
  InputReceipt.make({
    target,
    kind,
    position: null,
    startedMonotonicNanos: 0n,
    completedMonotonicNanos: 1n,
  });

const scroll = (tools: Ready, id = "scroll") =>
  tools
    .handle("browser_scroll", { deltaX: 0, deltaY: 1 }, id)
    .pipe(Effect.flatMap(Stream.runCollect));

const pointer = (tools: Ready, id = "pointer") =>
  tools
    .handle("browser_pointer_move", { to: { x: 1, y: 2 } }, id)
    .pipe(Effect.flatMap(Stream.runCollect));

const press = (tools: Ready, id = "press") =>
  tools
    .handle("browser_press", { reference, key: "Enter" }, id)
    .pipe(Effect.flatMap(Stream.runCollect));

it.effect("one host sequences all four handler layers across independent programs", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const calls: string[] = [];
      let active = 0;
      let peak = 0;

      const operation = <A>(name: string, value: A) =>
        Effect.gen(function* () {
          calls.push(name);
          peak = Math.max(peak, ++active);
          if (name === "scroll") {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          }

          return value;
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              active--;
            }),
          ),
        );

      const browser = scriptedSession({
        scroll: () => operation("scroll", result),
        pointerMove: () => operation("pointer", receipt("pointer-move")),
        pressElement: () => operation("press", receipt("press")),
        selectOption: () => operation("select-option", result),
      });

      const host = yield* BrowserTools.makeHost(browser);
      const tools = yield* allTools.pipe(Effect.provide(host.layer));
      const first = yield* host.run(scroll(tools)).pipe(Effect.forkScoped);

      yield* Deferred.await(entered);
      const second = yield* pointer(tools).pipe(Effect.forkScoped);
      const third = yield* host.run(press(tools)).pipe(Effect.forkScoped);

      const fourth = yield* tools
        .handle("browser_select_option", { reference, options: ["option-1"] }, "select")
        .pipe(Effect.flatMap(Stream.runCollect), Effect.forkScoped);

      yield* TestClock.adjust(1);
      expect(calls).toEqual(["scroll"]);
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(first)).toMatchObject([{ isFailure: false }]);
      expect(yield* Fiber.join(second)).toMatchObject([{ isFailure: false }]);
      expect(yield* Fiber.join(third)).toMatchObject([{ isFailure: false }]);
      expect(yield* Fiber.join(fourth)).toMatchObject([{ isFailure: false }]);
      expect(calls.slice().sort()).toEqual(["pointer", "press", "scroll", "select-option"]);
      expect(peak).toBe(1);
      expect(active).toBe(0);
    }),
  ),
);

it.effect("capacity includes the active call, and cancelling a waiter returns its slot", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let calls = 0;

      const browser = scriptedSession({
        scroll: () =>
          Effect.gen(function* () {
            calls++;
            if (calls === 1) {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            }

            return result;
          }),
      });

      const host = yield* BrowserTools.makeHost(browser);
      const tools = yield* allTools.pipe(Effect.provide(host.layer));
      const first = yield* scroll(tools, "active").pipe(Effect.forkScoped);

      yield* Deferred.await(entered);

      const waiters: Array<
        Fiber.Fiber<
          Effect.Success<ReturnType<typeof scroll>>,
          Effect.Error<ReturnType<typeof scroll>>
        >
      > = [];

      for (let i = 0; i < 31; i++) {
        waiters.push(yield* scroll(tools, `waiting-${i}`).pipe(Effect.forkScoped));
        yield* TestClock.adjust(1);
      }
      expect(yield* scroll(tools, "overflow")).toMatchObject([
        { isFailure: true, encodedResult: { reason: "busy", outcome: "undispatched" } },
      ]);
      const cancelled = waiters.pop();

      expect(cancelled).toBeDefined();
      if (cancelled !== undefined) yield* Fiber.interrupt(cancelled);
      const replacement = yield* scroll(tools, "replacement").pipe(Effect.forkScoped);

      yield* TestClock.adjust(1);
      expect(calls).toBe(1);
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(first)).toMatchObject([{ isFailure: false }]);
      for (const waiter of waiters)
        expect(yield* Fiber.join(waiter)).toMatchObject([{ isFailure: false }]);
      expect(yield* Fiber.join(replacement)).toMatchObject([{ isFailure: false }]);
      expect(calls).toBe(32);
      expect(yield* scroll(tools, "after")).toMatchObject([{ isFailure: false }]);
      expect(calls).toBe(33);
    }),
  ),
);

it.effect("an expired queue wait sends nothing and cannot time out the active handler", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let calls = 0;

      const browser = scriptedSession({
        scroll: () =>
          Effect.gen(function* () {
            calls++;
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);

            return result;
          }),
      });

      const host = yield* BrowserTools.makeHost(browser);
      const tools = yield* allTools.pipe(Effect.provide(host.layer));
      const active = yield* scroll(tools).pipe(Effect.forkScoped);

      yield* Deferred.await(entered);
      const waiter = yield* scroll(tools, "expires").pipe(Effect.forkScoped);

      yield* TestClock.adjust(30_001);
      expect(yield* Fiber.join(waiter)).toMatchObject([
        { isFailure: true, encodedResult: { reason: "timeout", outcome: "undispatched" } },
      ]);
      expect(calls).toBe(1);
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(active)).toMatchObject([{ isFailure: false }]);
      expect(yield* scroll(tools, "after-expiry")).toMatchObject([{ isFailure: false }]);
      expect(calls).toBe(2);
    }),
  ),
);

it.effect(
  "a late-admitted call keeps its ordinary execution lifetime beyond the queue deadline",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstEntered = yield* Deferred.make<void>();
        const firstRelease = yield* Deferred.make<void>();
        const secondEntered = yield* Deferred.make<void>();
        const secondRelease = yield* Deferred.make<void>();
        let calls = 0;

        const browser = scriptedSession({
          scroll: () =>
            Effect.gen(function* () {
              const first = ++calls === 1;

              yield* Deferred.succeed(first ? firstEntered : secondEntered, undefined);
              yield* Deferred.await(first ? firstRelease : secondRelease);

              return result;
            }),
        });

        const host = yield* BrowserTools.makeHost(browser);
        const tools = yield* allTools.pipe(Effect.provide(host.layer));
        const first = yield* scroll(tools).pipe(Effect.forkScoped);

        yield* Deferred.await(firstEntered);
        const second = yield* scroll(tools, "late-admission").pipe(Effect.forkScoped);

        yield* TestClock.adjust(29_999);
        yield* Deferred.succeed(firstRelease, undefined);
        yield* Deferred.await(secondEntered);
        yield* TestClock.adjust(60_000);
        yield* Deferred.succeed(secondRelease, undefined);
        expect(yield* Fiber.join(first)).toMatchObject([{ isFailure: false }]);
        expect(yield* Fiber.join(second)).toMatchObject([{ isFailure: false }]);
        expect(calls).toBe(2);
      }),
    ),
);

it.effect("closing a raw-layer host joins its active call and cancels every accepted waiter", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      let calls = 0;
      let finalizers = 0;
      let browserCloses = 0;

      const browser = scriptedSession({
        closeChecked: Effect.sync(() => {
          browserCloses++;
        }),
        scroll: () =>
          Effect.gen(function* () {
            calls++;
            yield* Deferred.succeed(entered, undefined);

            return yield* Effect.never;
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                finalizers++;
              }),
            ),
          ),
      });

      const scope = yield* Scope.fork(yield* Scope.Scope, "sequential");
      const host = yield* BrowserTools.makeHost(browser).pipe(Scope.provide(scope));
      const tools = yield* allTools.pipe(Effect.provide(host.layer));
      const first = yield* scroll(tools).pipe(Effect.forkScoped);

      yield* Deferred.await(entered);
      const waiting = yield* scroll(tools, "waiting").pipe(Effect.forkScoped);

      yield* TestClock.adjust(1);
      yield* Scope.close(scope, Exit.void);
      expect(Exit.isFailure(yield* Fiber.await(first))).toBe(true);
      expect(Exit.isFailure(yield* Fiber.await(waiting))).toBe(true);
      expect(calls).toBe(1);
      expect(finalizers).toBe(1);
      expect(browserCloses).toBe(0);
      expect(yield* scroll(tools, "closed")).toMatchObject([
        { isFailure: true, encodedResult: { reason: "closed", outcome: "undispatched" } },
      ]);
    }),
  ),
);

it.effect("a browser failure wakes raw-layer waiters without dispatch or cause projection", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const failure = yield* Deferred.make<never, InitializationError>();
      const entered = yield* Deferred.make<void>();

      const original = InitializationError.make({
        operation: "register",
        step: "private-binding",
        reason: "native",
      });

      let calls = 0;

      const browser = scriptedSession({
        failure: Deferred.await(failure),
        scroll: () =>
          Effect.gen(function* () {
            calls++;
            yield* Deferred.succeed(entered, undefined);

            return yield* Effect.never;
          }),
      });

      const host = yield* BrowserTools.makeHost(browser);
      const tools = yield* allTools.pipe(Effect.provide(host.layer));
      const first = yield* scroll(tools).pipe(Effect.forkScoped);

      yield* Deferred.await(entered);
      const waiter = yield* scroll(tools, "waiting").pipe(Effect.forkScoped);

      yield* TestClock.adjust(1);
      yield* Deferred.fail(failure, original);
      expect(yield* Fiber.join(waiter)).toMatchObject([
        { isFailure: true, encodedResult: { reason: "failed", outcome: "undispatched" } },
      ]);
      expect(yield* host.failure.pipe(Effect.flip)).toBe(original);
      expect(calls).toBe(1);
      yield* Fiber.interrupt(first);
      expect(yield* scroll(tools, "faulted")).toMatchObject([
        { isFailure: true, encodedResult: { reason: "failed", outcome: "undispatched" } },
      ]);
    }),
  ),
);

class CallbackValue extends Context.Service<CallbackValue, { readonly value: string }>()(
  "test/host-lane/CallbackValue",
) {}

const callerValue = Context.Reference<string>("test/host-lane/CallerValue", {
  defaultValue: () => "absent",
});

it.effect(
  "callback and finalizer reentry fail immediately while captured and per-call services survive",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const seen: string[] = [];
        let scrolls = 0;
        let tools: Ready | undefined;
        let captured: Ready | undefined;

        const browser = scriptedSession({
          pointerMove: () =>
            Effect.gen(function* () {
              seen.push(yield* callerValue);

              return receipt("pointer-move");
            }),
          scroll: () =>
            Effect.sync(() => {
              scrolls++;

              return result;
            }),
        });

        const host = yield* BrowserTools.makeHost(browser, {
          onInput: (): Effect.Effect<
            void,
            Effect.Error<ReturnType<typeof scroll>>,
            CallbackValue | Scope.Scope
          > =>
            Effect.gen(function* () {
              seen.push((yield* CallbackValue).value);
              expect(tools).toBeDefined();
              if (tools === undefined) return yield* Effect.die("Host toolkit was not initialized");
              const current = tools;

              // Captures this invocation's Context. Later use must not look like live reentry.
              captured = yield* allTools.pipe(Effect.provide(host.layer));
              yield* Effect.addFinalizer(() =>
                scroll(current, "finalizer").pipe(
                  Effect.tap((value) =>
                    Effect.sync(() =>
                      expect(value).toMatchObject([
                        {
                          isFailure: true,
                          encodedResult: { reason: "busy", outcome: "undispatched" },
                        },
                      ]),
                    ),
                  ),
                  Effect.orDie,
                ),
              );
              expect(yield* scroll(current, "callback")).toMatchObject([
                { isFailure: true, encodedResult: { reason: "busy", outcome: "undispatched" } },
              ]);
            }),
        }).pipe(Effect.provideService(CallbackValue, { value: "captured" }));

        tools = yield* allTools.pipe(Effect.provide(host.layer));
        expect(
          yield* pointer(tools).pipe(
            Effect.provideService(callerValue, "per-call"),
            Effect.provideService(CallbackValue, { value: "caller-override" }),
          ),
        ).toMatchObject([{ isFailure: false }]);
        expect(seen).toEqual(["per-call", "captured"]);
        expect(scrolls).toBe(0);
        expect(captured).toBeDefined();
        if (captured !== undefined)
          expect(yield* scroll(captured, "after-callback")).toMatchObject([{ isFailure: false }]);
        expect(scrolls).toBe(1);
      }),
    ),
);

it.effect(
  "nested hosts preserve enclosing reentry markers while independent callers still queue",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const innerEntered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let outerTools: Ready | undefined;
        let innerTools: Ready | undefined;
        let scrolls = 0;

        const browser = scriptedSession({
          pointerMove: () => Effect.succeed(receipt("pointer-move")),
          scroll: () =>
            Effect.sync(() => {
              scrolls++;

              return result;
            }),
        });

        const outer = yield* BrowserTools.makeHost(browser, {
          onInput: () =>
            Effect.gen(function* () {
              if (innerTools === undefined) return yield* Effect.die("Inner toolkit missing");
              expect(yield* pointer(innerTools, "inner")).toMatchObject([{ isFailure: false }]);
            }),
        });

        const inner = yield* BrowserTools.makeHost(browser, {
          onInput: () =>
            Effect.gen(function* () {
              if (outerTools === undefined) return yield* Effect.die("Outer toolkit missing");
              expect(yield* scroll(outerTools, "enclosing-host")).toMatchObject([
                { isFailure: true, encodedResult: { reason: "busy", outcome: "undispatched" } },
              ]);
              yield* Deferred.succeed(innerEntered, undefined);
              yield* Deferred.await(release);
            }),
        });

        outerTools = yield* allTools.pipe(Effect.provide(outer.layer));
        innerTools = yield* allTools.pipe(Effect.provide(inner.layer));
        const active = yield* pointer(outerTools).pipe(Effect.forkScoped);

        yield* Deferred.await(innerEntered);
        const independent = yield* scroll(outerTools, "independent").pipe(Effect.forkScoped);

        yield* TestClock.adjust(1);
        expect(scrolls).toBe(0);
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(active)).toMatchObject([{ isFailure: false }]);
        expect(yield* Fiber.join(independent)).toMatchObject([{ isFailure: false }]);
        expect(scrolls).toBe(1);
      }),
    ),
);

for (const cancel of [false, true])
  it.effect(
    `navigation keeps its lane through callback finalization and stop cleanup (cancel=${cancel})`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const completed = yield* Deferred.make<NavigationResult, BrowserError>();
          const callbackEntered = yield* Deferred.make<void>();
          const finalizerEntered = yield* Deferred.make<void>();
          const finalizerRelease = yield* Deferred.make<void>();
          const stopEntered = yield* Deferred.make<void>();
          const stopRelease = yield* Deferred.make<void>();
          const order: string[] = [];
          let stops = 0;
          let callbackTools: Ready | undefined;

          const stopped = BrowserError.make({
            operation: "navigate",
            reason: Reasons.Interrupted.make({}),
            outcome: "unknown",
          });

          const browser = scriptedSession({
            startNavigation: () =>
              Effect.gen(function* () {
                order.push("navigate");
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => {
                    order.push("operation-finalized");
                  }),
                );

                return {
                  target,
                  completed: Deferred.await(completed),
                  stop: Effect.gen(function* () {
                    stops++;
                    order.push("stop");
                    yield* Deferred.succeed(stopEntered, undefined);
                    yield* Deferred.await(stopRelease);
                    yield* Deferred.fail(completed, stopped);
                    order.push("stopped");
                  }),
                };
              }),
            scroll: () =>
              Effect.sync(() => {
                order.push("scroll");

                return result;
              }),
          });

          const host = yield* BrowserTools.makeHost(browser, {
            onNavigation: () =>
              Effect.gen(function* () {
                if (callbackTools === undefined)
                  return yield* Effect.die("Navigation toolkit missing");
                const tools = callbackTools;

                expect(yield* scroll(tools, "navigation-reentry")).toMatchObject([
                  { isFailure: true, encodedResult: { reason: "busy", outcome: "undispatched" } },
                ]);
                yield* Effect.addFinalizer(() =>
                  Effect.gen(function* () {
                    expect(yield* scroll(tools, "navigation-finalizer-reentry")).toMatchObject([
                      {
                        isFailure: true,
                        encodedResult: { reason: "busy", outcome: "undispatched" },
                      },
                    ]);
                    order.push("callback-finalizer");
                    yield* Deferred.succeed(finalizerEntered, undefined);
                    yield* Deferred.await(finalizerRelease);
                    order.push("callback-finalized");
                  }).pipe(Effect.orDie),
                );
                yield* Deferred.succeed(callbackEntered, undefined);

                return yield* Effect.never;
              }),
          });

          const tools = yield* allTools.pipe(Effect.provide(host.layer));

          callbackTools = tools;

          const navigation = yield* tools
            .handle("browser_navigate", { url }, "navigation")
            .pipe(Effect.flatMap(Stream.runCollect), Effect.forkScoped);

          yield* Deferred.await(callbackEntered);
          const waiter = yield* scroll(tools).pipe(Effect.forkScoped);

          yield* TestClock.adjust(1);

          const interrupting = cancel
            ? yield* Fiber.interrupt(navigation).pipe(Effect.forkScoped)
            : undefined;

          if (!cancel) yield* Deferred.succeed(completed, NavigationResult.make({ url }));
          yield* Deferred.await(finalizerEntered);
          expect(order).not.toContain("scroll");
          yield* Deferred.succeed(finalizerRelease, undefined);
          if (cancel) {
            yield* Deferred.await(stopEntered);
            expect(order).not.toContain("scroll");
            yield* Deferred.succeed(stopRelease, undefined);
          }
          if (interrupting !== undefined) yield* Fiber.join(interrupting);
          else expect(yield* Fiber.join(navigation)).toMatchObject([{ isFailure: false }]);
          expect(yield* Fiber.join(waiter)).toMatchObject([{ isFailure: false }]);
          expect(order.indexOf("callback-finalized")).toBeLessThan(order.indexOf("scroll"));
          expect(order.indexOf("operation-finalized")).toBeLessThan(order.indexOf("scroll"));
          expect(stops).toBe(cancel ? 1 : 0);
          if (cancel) expect(order.indexOf("stopped")).toBeLessThan(order.indexOf("scroll"));
        }),
      ),
  );

it.effect("a queued stale reference is refused once and is never refreshed or replayed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let valid = true;
      let exactCalls = 0;

      const browser = scriptedSession({
        scroll: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            valid = false;

            return result;
          }),
        pressElement: () =>
          Effect.suspend(() => {
            exactCalls++;

            return valid
              ? Effect.succeed(receipt("press"))
              : Effect.fail(
                  BrowserError.make({
                    operation: "press",
                    reason: Reasons.Stale.make({}),
                    outcome: "undispatched",
                  }),
                );
          }),
      });

      const host = yield* BrowserTools.makeHost(browser);
      const tools = yield* allTools.pipe(Effect.provide(host.layer));
      const first = yield* scroll(tools).pipe(Effect.forkScoped);

      yield* Deferred.await(entered);
      const waiter = yield* press(tools).pipe(Effect.forkScoped);

      yield* TestClock.adjust(1);
      expect(exactCalls).toBe(0);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      expect(yield* Fiber.join(waiter)).toMatchObject([
        { isFailure: true, encodedResult: { reason: "stale", outcome: "undispatched" } },
      ]);
      expect(exactCalls).toBe(1);
      expect((yield* host.toolFailures).failures).toHaveLength(1);
    }),
  ),
);

it.effect("plain handler layers remain caller-managed and unsequenced", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let active = 0;
      let peak = 0;

      const browser = scriptedSession({
        scroll: () =>
          Effect.gen(function* () {
            peak = Math.max(peak, ++active);
            if (active === 2) yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            active--;

            return result;
          }),
      });

      const tools = yield* allTools.pipe(
        Effect.provide(
          Layer.mergeAll(
            BrowserTools.handlers(browser),
            BrowserTools.nativeHandlers(browser),
            BrowserTools.keyboardHandlers(browser),
            BrowserTools.selectionHandlers(browser),
          ),
        ),
      );

      const first = yield* scroll(tools).pipe(Effect.forkScoped);
      const second = yield* scroll(tools).pipe(Effect.forkScoped);

      yield* Deferred.await(entered);
      expect(peak).toBe(2);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      expect(active).toBe(0);
    }),
  ),
);
