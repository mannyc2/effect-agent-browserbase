import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Schema, Scope, Stream } from "effect";
import * as Tools from "effect-agent-browser/tools";
import { InputReceipt, Observation, Target } from "effect-browser/browser-data";
import { BrowserError, Reasons } from "effect-browser/errors";
import { TestClock } from "effect/testing";
import { Toolkit } from "effect/unstable/ai";

import { scriptedSession } from "./fixtures/ScriptedSession.ts";

const url = "https://example.test/";
const target = Target.make({ generation: 1, pageId: "page", frameId: "frame" });
const reference = { observationId: "old", elementId: "element-1" };

const observation = (text = "fresh", id = "fresh") =>
  Observation.make({
    target,
    observationId: id,
    revision: 1,
    scope: "document",
    url,
    text,
    controls: [],
    controlsTruncated: false,
    textTruncated: false,
    viewport: {
      width: 640,
      height: 480,
      clippedText: 0,
      coveredText: 0,
      uncertainText: 0,
      unreachableControls: 0,
      exhausted: false,
    },
  });

const receipt = (kind: InputReceipt["kind"]) =>
  InputReceipt.make({
    target,
    kind,
    position: null,
    startedMonotonicNanos: 0n,
    completedMonotonicNanos: 1n,
  });

const variants = Toolkit.merge(
  Tools.observedToolkit,
  Tools.observedNativeToolkit,
  Tools.observedKeyboardToolkit,
  Tools.observedSelectionToolkit,
);

const calls = [
  ["browser_navigate_and_inspect", { url }],
  ["browser_click_and_inspect", reference],
  ["browser_fill_and_inspect", { reference, value: "PRIVATE-VALUE" }],
  ["browser_scroll_and_inspect", { deltaX: 0, deltaY: 1 }],
  ["browser_select_option_and_inspect", { reference, options: ["option"] }],
  ["browser_pointer_move_and_inspect", { to: { x: 1, y: 1 } }],
  ["browser_hover_and_inspect", reference],
  ["browser_wheel_and_inspect", { deltaX: 0, deltaY: 1 }],
  ["browser_press_and_inspect", { reference, key: "Enter" }],
  ["browser_type_and_inspect", { reference, text: "PRIVATE-TEXT" }],
] as const;

it.effect(
  "each observed variant preserves one action and fresh evidence without changing ordinary tool schemas",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let actions = 0;
        let reads = 0;

        const acted = <A>(value: A) =>
          Effect.sync(() => {
            actions++;

            return value;
          });

        const browser = scriptedSession({
          navigate: () => acted({ url }),
          clickElement: () => acted({ url }),
          fillElement: () => acted({ url }),
          scroll: () => acted({ url }),
          selectOption: () => acted({ url }),
          pointerMove: () => acted(receipt("pointer-move")),
          hoverElement: () => acted(receipt("hover")),
          wheel: () => acted(receipt("wheel")),
          pressElement: () => acted(receipt("press")),
          typeElement: () => acted(receipt("type")),
          observe: () => Effect.sync(() => observation("fresh", `fresh-${++reads}`)),
        });

        const ready = yield* variants.pipe(Effect.provide(Tools.observedHandlers(browser)));

        for (const [index, [name, params]] of calls.entries()) {
          const results = yield* Stream.runCollect(yield* ready.handle(name, params));

          expect(results).toMatchObject([
            {
              isFailure: false,
              encodedResult: {
                observation: {
                  _tag: "Available",
                  observation: { observationId: `fresh-${index + 1}` },
                },
              },
            },
          ]);
          expect(actions).toBe(index + 1);
          expect(reads).toBe(index + 1);
          expect(JSON.stringify(results)).not.toContain("PRIVATE-");
        }
        expect(Object.keys(Tools.toolkit.tools)).toEqual([
          "browser_navigate",
          "browser_inspect",
          "browser_click",
          "browser_fill",
          "browser_scroll",
        ]);
        expect(Tools.toolkit.tools.browser_click.id).not.toBe(
          Tools.observedToolkit.tools.browser_click_and_inspect.id,
        );
        const ordinary = yield* Tools.toolkit.pipe(Effect.provide(Tools.handlers(browser)));

        expect(
          yield* Stream.runCollect(yield* ordinary.handle("browser_click", reference)),
        ).toMatchObject([{ isFailure: false, encodedResult: { url } }]);
        expect(reads).toBe(calls.length);
      }),
    ),
);

it.effect(
  "recoverable follow-up errors preserve action success and original host diagnostics",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const reason of [
          Reasons.Timeout.make({}),
          Reasons.Limit.make({ dimension: "actions", maximum: 1, observed: 1 }),
          Reasons.Provider.make({ status: 503 }),
        ]) {
          let actions = 0;
          let reads = 0;

          const error = BrowserError.make({
            operation: "observe",
            reason,
            outcome: "undispatched",
          });

          const browser = scriptedSession({
            clickElement: () =>
              Effect.sync(() => {
                actions++;

                return { url };
              }),
            observe: () =>
              Effect.suspend(() => {
                reads++;

                return Effect.fail(error);
              }),
          });

          const host = yield* Tools.makeHost(browser);
          const ready = yield* Tools.observedToolkit.pipe(Effect.provide(host.observedHandlers));

          const result = yield* Stream.runCollect(
            yield* ready.handle("browser_click_and_inspect", reference, "once"),
          );

          expect(result).toMatchObject([
            {
              isFailure: false,
              encodedResult: {
                action: { url },
                observation: { _tag: "Unavailable", failure: { outcome: "undispatched" } },
              },
            },
          ]);
          expect(actions).toBe(1);
          expect(reads).toBe(1);
          expect((yield* host.toolFailures).failures).toMatchObject([
            {
              error: { operation: "observe", reason, outcome: "undispatched" },
              toolCallId: "once",
            },
          ]);
          const pending = yield* host.failure.pipe(Effect.exit, Effect.forkScoped);

          yield* TestClock.adjust(1);
          expect(pending.pollUnsafe()).toBeUndefined();
          yield* Fiber.interrupt(pending);
          expect(JSON.stringify(result)).not.toContain("503");
        }
      }),
    ),
);

it.effect(
  "the encoded envelope is bounded after successful input, including action URL and JSON overhead",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const maximum = 50 * 1024;
        const large = observation("x".repeat(48 * 1024));

        expect(
          new TextEncoder().encode(JSON.stringify(Schema.encodeSync(Observation)(large))).length,
        ).toBeLessThan(maximum);
        const longUrl = url + "a".repeat(4000);
        let actions = 0;

        const host = yield* Tools.makeHost(
          scriptedSession({
            clickElement: () =>
              Effect.sync(() => {
                actions++;

                return { url: longUrl };
              }),
            observe: () => Effect.succeed(large),
          }),
          { maxTextBytes: 65536, observedResultMaxBytes: maximum },
        );

        const ready = yield* Tools.observedToolkit.pipe(Effect.provide(host.observedHandlers));

        const results = yield* Stream.runCollect(
          yield* ready.handle("browser_click_and_inspect", reference, "large"),
        );

        expect(results).toMatchObject([
          {
            isFailure: false,
            encodedResult: {
              action: { url: longUrl },
              observation: { _tag: "Unavailable", failure: { reason: "limit" } },
            },
          },
        ]);
        expect(
          new TextEncoder().encode(JSON.stringify(results[0]?.encodedResult)).length,
        ).toBeLessThanOrEqual(maximum);
        expect(actions).toBe(1);
        const failure = (yield* host.toolFailures).failures[0]?.error;

        expect(failure?.reason).toMatchObject({
          _tag: "Limit",
          dimension: "returned-bytes",
          maximum,
        });
        if (failure?.reason._tag === "Limit")
          expect(failure.reason.observed).toBeGreaterThan(maximum);
      }),
    ),
);

it.effect(
  "invalid observation-result budgets refuse before input and ordinary action failure never triggers inspection",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let actions = 0;
        let reads = 0;

        const browser = scriptedSession({
          clickElement: () =>
            Effect.suspend(() => {
              actions++;

              return Effect.fail(
                BrowserError.make({
                  operation: "click",
                  reason: Reasons.Stale.make({}),
                  outcome: "undispatched",
                }),
              );
            }),
          observe: () =>
            Effect.sync(() => {
              reads++;

              return observation();
            }),
        });

        for (const maximum of [0, 51199, 1024 * 1024 + 1, NaN, Infinity, null]) {
          // @ts-expect-error Explicit null is an untyped invalid host input, not omission.
          const host = yield* Tools.makeHost(browser, { observedResultMaxBytes: maximum });
          const ready = yield* Tools.observedToolkit.pipe(Effect.provide(host.observedHandlers));

          expect(
            yield* Stream.runCollect(yield* ready.handle("browser_click_and_inspect", reference)),
          ).toMatchObject([
            { isFailure: true, encodedResult: { reason: "failed", outcome: "undispatched" } },
          ]);
          expect(actions).toBe(0);
          expect(reads).toBe(0);
        }
        const host = yield* Tools.makeHost(browser);
        const ready = yield* Tools.observedToolkit.pipe(Effect.provide(host.observedHandlers));

        expect(
          yield* Stream.runCollect(yield* ready.handle("browser_click_and_inspect", reference)),
        ).toMatchObject([
          { isFailure: true, encodedResult: { reason: "stale", outcome: "undispatched" } },
        ]);
        expect(actions).toBe(1);
        expect(reads).toBe(0);
      }),
    ),
);

it.effect("the invocation lane spans the fresh read and queued input cannot overtake it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const order: string[] = [];

      const browser = scriptedSession({
        clickElement: () =>
          Effect.sync(() => {
            order.push("click");

            return { url };
          }),
        observe: () =>
          Effect.gen(function* () {
            order.push("observe-start");
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            order.push("observe-end");

            return observation();
          }),
        scroll: () =>
          Effect.sync(() => {
            order.push("scroll");

            return { url };
          }),
      });

      const host = yield* Tools.makeHost(browser);

      const ready = yield* Toolkit.merge(Tools.toolkit, Tools.observedToolkit).pipe(
        Effect.provide(host.layer),
      );

      const first = yield* ready
        .handle("browser_click_and_inspect", reference)
        .pipe(Effect.flatMap(Stream.runCollect), Effect.forkScoped);

      yield* Deferred.await(entered);

      const next = yield* ready
        .handle("browser_scroll", { deltaX: 0, deltaY: 1 })
        .pipe(Effect.flatMap(Stream.runCollect), Effect.forkScoped);

      yield* TestClock.adjust(1);
      expect(order).toEqual(["click", "observe-start"]);
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(first)).toMatchObject([{ isFailure: false }]);
      expect(yield* Fiber.join(next)).toMatchObject([{ isFailure: false }]);
      expect(order).toEqual(["click", "observe-start", "observe-end", "scroll"]);
    }),
  ),
);

it.effect(
  "host closure during a follow-up read preserves cancellation and prevents queued late input",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Scope.fork(yield* Scope.Scope, "sequential");
        const entered = yield* Deferred.make<void>();
        let actions = 0;
        let readsFinalized = 0;
        let laterInput = 0;

        const browser = scriptedSession({
          clickElement: () =>
            Effect.sync(() => {
              actions++;

              return { url };
            }),
          observe: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Effect.sync(() => {
                  readsFinalized++;
                }),
              ),
            ),
          scroll: () =>
            Effect.sync(() => {
              laterInput++;

              return { url };
            }),
        });

        const host = yield* Tools.makeHost(browser).pipe(Scope.provide(scope));

        const ready = yield* Toolkit.merge(Tools.toolkit, Tools.observedToolkit).pipe(
          Effect.provide(host.layer),
        );

        const first = yield* ready
          .handle("browser_click_and_inspect", reference)
          .pipe(Effect.flatMap(Stream.runCollect), Effect.exit, Effect.forkScoped);

        yield* Deferred.await(entered);

        const queued = yield* ready
          .handle("browser_scroll", { deltaX: 0, deltaY: 1 })
          .pipe(Effect.flatMap(Stream.runCollect), Effect.exit, Effect.forkScoped);

        yield* TestClock.adjust(1);
        yield* Scope.close(scope, Exit.void);
        expect(Exit.isFailure(yield* Fiber.join(first))).toBe(true);
        expect(Exit.isFailure(yield* Fiber.join(queued))).toBe(true);
        expect(actions).toBe(1);
        expect(readsFinalized).toBe(1);
        expect(laterInput).toBe(0);
      }),
    ),
);

it.effect(
  "input callback cleanup precedes follow-up inspection, and callback failure is never successful observed input",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const order: string[] = [];

        const browser = scriptedSession({
          pointerMove: () =>
            Effect.sync(() => {
              order.push("input");

              return receipt("pointer-move");
            }),
          observe: () =>
            Effect.sync(() => {
              order.push("observe");

              return observation();
            }),
        });

        const host = yield* Tools.makeHost(browser, {
          onInput: () =>
            Effect.addFinalizer(() =>
              Effect.sync(() => {
                order.push("callback-finalizer");
              }),
            ),
        });

        const ready = yield* Tools.observedNativeToolkit.pipe(
          Effect.provide(host.observedHandlers),
        );

        expect(
          yield* Stream.runCollect(
            yield* ready.handle("browser_pointer_move_and_inspect", { to: { x: 0, y: 0 } }),
          ),
        ).toMatchObject([{ isFailure: false }]);
        expect(order).toEqual(["input", "callback-finalizer", "observe"]);

        const failing = yield* Tools.makeHost(browser, {
          onInput: () => Effect.fail("PRIVATE-CALLBACK"),
        });

        const failedTools = yield* Tools.observedNativeToolkit.pipe(
          Effect.provide(failing.observedHandlers),
        );

        const result = yield* Stream.runCollect(
          yield* failedTools.handle("browser_pointer_move_and_inspect", { to: { x: 0, y: 0 } }),
        );

        expect(result).toMatchObject([
          { isFailure: true, encodedResult: { reason: "failed", outcome: "unknown" } },
        ]);
        expect(JSON.stringify(result)).not.toContain("PRIVATE-CALLBACK");
        expect(order.filter((item) => item === "observe")).toHaveLength(1);
        expect(yield* failing.failure.pipe(Effect.flip)).toBe("PRIVATE-CALLBACK");
      }),
    ),
);
