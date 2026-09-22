import { expect, it } from "@effect/vitest";
import { Effect, Exit, Scope, Stream } from "effect";
import * as BrowserTools from "effect-agent-browser/tools";
import type { BrowserSession } from "effect-browser/browser";
import { InputReceipt, Observation, SessionStatus, Target } from "effect-browser/browser-data";
import { BrowserError, Reasons, type BrowserReason } from "effect-browser/errors";
import { Toolkit } from "effect/unstable/ai";

import { scriptedSession } from "./fixtures/ScriptedSession.ts";

const reference = { observationId: "observation-1", elementId: "element-1" };

const requests = [
  ["browser_navigate", { url: "https://example.test/" }, "navigate"],
  ["browser_inspect", {}, "observe"],
  ["browser_click", reference, "click"],
  ["browser_fill", { reference, value: "PRIVATE-INPUT" }, "fill"],
  ["browser_scroll", { deltaX: 0, deltaY: 1 }, "scroll"],
  ["browser_pointer_move", { to: { x: 1, y: 2 } }, "pointer-move"],
  ["browser_hover", reference, "hover"],
  ["browser_wheel", { deltaX: 0, deltaY: 1 }, "wheel"],
  ["browser_press", { reference, key: "Enter" }, "press"],
  ["browser_type", { reference, text: "PRIVATE-TEXT" }, "type"],
] as const;

const allTools = Toolkit.merge(
  BrowserTools.toolkit,
  BrowserTools.nativeToolkit,
  BrowserTools.keyboardToolkit,
);

it.effect(
  "tool diagnostics read current owner usability without changing recorded model failures",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let state = SessionStatus.make({
          phase: "open",
          reason: null,
          generation: 1,
          busy: false,
          unresolvedDispatch: false,
        });

        let reads = 0;
        let actions = 0;

        const browser = scriptedSession({
          status: Effect.sync(() => {
            reads++;

            return Object.freeze(SessionStatus.make({ ...state }));
          }),
          observe: () =>
            Effect.suspend(() => {
              actions++;

              return Effect.fail(
                BrowserError.make({
                  operation: "observe",
                  reason: Reasons.Timeout.make({}),
                  outcome: "unknown",
                }),
              );
            }),
        });

        const scope = yield* Scope.fork(yield* Scope.Scope, "sequential");
        const host = yield* BrowserTools.makeHost(browser).pipe(Scope.provide(scope));
        const tools = yield* BrowserTools.toolkit.pipe(Effect.provide(host.handlers));

        const result = yield* Stream.runCollect(
          yield* tools.handle("browser_inspect", {}, "one-timeout"),
        );

        expect(result).toMatchObject([
          { isFailure: true, encodedResult: { reason: "timeout", outcome: "unknown" } },
        ]);
        expect(JSON.stringify(result)).not.toContain("unresolvedDispatch");
        const recovered = yield* host.toolFailures;

        expect(recovered.status).toMatchObject({ phase: "open", unresolvedDispatch: false });
        state = SessionStatus.make({
          phase: "closed",
          reason: "expired",
          generation: 2,
          busy: false,
          unresolvedDispatch: true,
        });
        yield* Scope.close(scope, Exit.void);
        const closed = yield* host.toolFailures;

        expect(closed.status).toEqual(state);
        expect(closed.failures).toEqual(recovered.failures);
        expect(recovered.status.phase).toBe("open");
        expect(Object.isFrozen(closed.status)).toBe(true);
        expect(reads).toBe(2);
        expect(actions).toBe(1);
      }),
    ),
);

it.effect(
  "all ten host handlers retain ordinary error facts and call IDs before compact projection",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const originals: BrowserError[] = [];

        const refuse = (operation: BrowserError["operation"]) => () =>
          Effect.suspend(() => {
            const error = BrowserError.make({
              operation,
              reason: Reasons.RateLimited.make({ retryAfterMillis: 250 }),
              outcome: "undispatched",
            });

            originals.push(error);

            return Effect.fail(error);
          });

        const browser = scriptedSession({
          startNavigation: refuse("navigate"),
          observe: refuse("observe"),
          clickElement: refuse("click"),
          fillElement: refuse("fill"),
          scroll: refuse("scroll"),
          pointerMove: refuse("pointer-move"),
          hoverElement: refuse("hover"),
          wheel: refuse("wheel"),
          pressElement: refuse("press"),
          typeElement: refuse("type"),
        });

        const host = yield* BrowserTools.makeHost(browser);
        const tools = yield* allTools.pipe(Effect.provide(host.layer));

        for (const [name, request, operation] of requests) {
          const results = yield* Stream.runCollect(yield* tools.handle(name, request, name));

          expect(results).toHaveLength(1);
          expect(results[0]?.encodedResult).toEqual({
            _tag: "BrowserToolFailure",
            reason: "busy",
            outcome: "undispatched",
          });
          const snapshot = yield* host.toolFailures;

          expect(snapshot.failures).toHaveLength(originals.length);
          expect(snapshot.failures.at(-1)).toEqual({
            error: {
              _tag: "BrowserError",
              operation,
              reason: { _tag: "RateLimited", retryAfterMillis: 250 },
              outcome: "undispatched",
            },
            toolCallId: name,
            toolCallIdOmitted: false,
          });
          expect(yield* host.run(Effect.succeed("usable"))).toBe("usable");
        }
        expect(originals).toHaveLength(10);
        expect((yield* host.toolFailures).dropped).toBe(0);
      }),
    ),
);

const projections: ReadonlyArray<
  readonly [BrowserReason, BrowserTools.BrowserToolFailure["reason"]]
> = [
  [Reasons.Stale.make({}), "stale"],
  [Reasons.TargetChanged.make({}), "stale"],
  [Reasons.Resized.make({}), "stale"],
  [Reasons.Interrupted.make({}), "stale"],
  [Reasons.Busy.make({}), "busy"],
  [Reasons.Active.make({}), "busy"],
  [Reasons.RateLimited.make({ retryAfterMillis: 123 }), "busy"],
  [Reasons.Denied.make({}), "denied"],
  [Reasons.Authorization.make({}), "denied"],
  [Reasons.UnsafeUrl.make({}), "denied"],
  [Reasons.NotFound.make({}), "not-found"],
  [Reasons.Ambiguous.make({}), "ambiguous"],
  [Reasons.NotVisible.make({}), "not-visible"],
  [Reasons.NotFocused.make({}), "not-focused"],
  [Reasons.Limit.make({ dimension: "pages", maximum: 1, observed: 2 }), "limit"],
  [Reasons.Timeout.make({}), "timeout"],
  [Reasons.Closed.make({}), "closed"],
  [Reasons.Expired.make({}), "closed"],
  [Reasons.Disconnected.make({}), "closed"],
  [Reasons.UnregisteredSession.make({}), "closed"],
  [Reasons.Configuration.make({ path: "PRIVATE-PATH" }), "failed"],
  [Reasons.Unsupported.make({}), "failed"],
  [Reasons.Malformed.make({ path: "PRIVATE-PATH" }), "failed"],
  [Reasons.Transport.make({ status: 503 }), "failed"],
  [Reasons.Provider.make({ status: 500 }), "failed"],
  [Reasons.Disabled.make({}), "failed"],
  [Reasons.Failed.make({}), "failed"],
  [Reasons.ContentType.make({}), "failed"],
  [Reasons.Timestamp.make({}), "failed"],
  [Reasons.ContextLease.make({}), "failed"],
];

it.effect(
  "direct handlers project every host reason while preserving all three dispatch outcomes",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let error = BrowserError.make({
          operation: "observe",
          reason: Reasons.Busy.make({}),
          outcome: "undispatched",
        });

        const browser = scriptedSession({
          observe: () => Effect.suspend(() => Effect.fail(error)),
        });

        const tools = yield* BrowserTools.toolkit.pipe(
          Effect.provide(BrowserTools.handlers(browser)),
        );

        expect(projections.map(([reason]) => reason._tag).sort()).toEqual(
          Object.keys(Reasons).sort(),
        );

        for (const [reason, projected] of projections) {
          for (const outcome of ["undispatched", "rejected", "unknown"] as const) {
            error = BrowserError.make({ operation: "observe", reason, outcome });
            const results = yield* Stream.runCollect(yield* tools.handle("browser_inspect", {}));

            expect(results[0]?.isFailure).toBe(true);
            expect(results[0]?.encodedResult).toEqual({
              _tag: "BrowserToolFailure",
              reason: projected,
              outcome,
            });
          }
        }
      }),
    ),
);

it.effect(
  "failure snapshots bound retained entries and IDs, copy facts, and remain readable after host closure",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let calls = 0;
        const reason = Reasons.Provider.make({ status: 503 });
        const error = BrowserError.make({ operation: "observe", reason, outcome: "rejected" });

        const browser = scriptedSession({
          observe: () =>
            Effect.suspend(() => {
              calls++;

              return Effect.fail(error);
            }),
        });

        const scope = yield* Scope.fork(yield* Scope.Scope, "sequential");
        const host = yield* BrowserTools.makeHost(browser).pipe(Scope.provide(scope));
        const tools = yield* BrowserTools.toolkit.pipe(Effect.provide(host.handlers));

        yield* Stream.runCollect(yield* tools.handle("browser_inspect", {}, "first"));
        const first = yield* host.toolFailures;

        expect(Reflect.set(reason, "status", 500)).toBe(true);
        expect(first.failures[0]?.error.reason).toEqual({ _tag: "Provider", status: 503 });

        for (let index = 1; index <= 33; index++) {
          const id =
            index === 31
              ? "x".repeat(256)
              : index === 32
                ? "x".repeat(257)
                : index === 33
                  ? undefined
                  : `call-${index}`;

          yield* Stream.runCollect(yield* tools.handle("browser_inspect", {}, id));
        }
        const final = yield* host.toolFailures;

        expect(final.failures).toHaveLength(32);
        expect(final.dropped).toBe(2);
        expect(final.failures[0]?.toolCallId).toBe("call-2");
        expect(final.failures.at(-3)).toMatchObject({
          toolCallId: "x".repeat(256),
          toolCallIdOmitted: false,
        });
        expect(final.failures.at(-2)).toMatchObject({
          toolCallId: undefined,
          toolCallIdOmitted: true,
        });
        expect(final.failures.at(-1)).toMatchObject({
          toolCallId: undefined,
          toolCallIdOmitted: false,
        });
        expect(first.failures).toHaveLength(1);
        expect(first.dropped).toBe(0);
        for (const value of [
          final,
          final.failures,
          final.failures[0],
          final.failures[0]?.error,
          final.failures[0]?.error.reason,
        ])
          expect(Object.isFrozen(value)).toBe(true);

        yield* Scope.close(scope, Exit.void);
        expect(yield* host.toolFailures).toEqual(final);
        expect(calls).toBe(34);
      }),
    ),
);

it.effect(
  "malformed typed results are recorded once before projection without replay or receipt callbacks",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const target = Target.make({ generation: 1, pageId: "page", frameId: "frame" });

        const receipt = InputReceipt.make({
          target,
          kind: "pointer-move",
          position: null,
          startedMonotonicNanos: 1n,
          completedMonotonicNanos: 2n,
        });

        const observation = Observation.make({
          target,
          observationId: "observation",
          revision: 0,
          scope: "document",
          url: "https://example.test/",
          text: "",
          controls: [],
          controlsTruncated: false,
          textTruncated: false,
          viewport: {
            width: 1,
            height: 1,
            clippedText: 0,
            coveredText: 0,
            uncertainText: 0,
            unreachableControls: 0,
            exhausted: false,
          },
        });

        Reflect.set(receipt, "kind", "PRIVATE-MALFORMED-RECEIPT");
        Reflect.set(observation, "scope", "PRIVATE-MALFORMED-OBSERVATION");
        let starts = 0;
        let stops = 0;
        let inputs = 0;
        const invalidAction = () => Effect.succeed({ url: "PRIVATE-MALFORMED-URL" });
        const invalidInput = () => Effect.succeed(receipt);

        const browser = scriptedSession({
          startNavigation: () =>
            Effect.sync(() => {
              starts++;

              return {
                target,
                completed: invalidAction(),
                stop: Effect.sync(() => {
                  stops++;
                }),
              };
            }),
          observe: () => Effect.succeed(observation),
          clickElement: invalidAction,
          fillElement: invalidAction,
          scroll: invalidAction,
          pointerMove: invalidInput,
          hoverElement: invalidInput,
          wheel: invalidInput,
          pressElement: invalidInput,
          typeElement: invalidInput,
        });

        const host = yield* BrowserTools.makeHost(browser, {
          onInput: () =>
            Effect.sync(() => {
              inputs++;
            }),
        });

        const tools = yield* allTools.pipe(Effect.provide(host.layer));

        for (const [name, request] of requests) {
          const results = yield* Stream.runCollect(yield* tools.handle(name, request, name));

          expect(results[0]?.encodedResult).toEqual({
            _tag: "BrowserToolFailure",
            reason: "failed",
            outcome: "unknown",
          });
        }
        const snapshot = yield* host.toolFailures;

        expect(snapshot.failures).toHaveLength(10);
        expect(snapshot.failures.map((entry) => entry.toolCallId)).toEqual(
          requests.map(([name]) => name),
        );
        expect(
          snapshot.failures.every(
            (entry) => entry.error.reason._tag === "Malformed" && entry.error.outcome === "unknown",
          ),
        ).toBe(true);
        expect(JSON.stringify(snapshot)).not.toContain("PRIVATE-");
        expect(starts).toBe(1);
        expect(stops).toBe(0);
        expect(inputs).toBe(0);
        expect(yield* host.run(Effect.succeed(true))).toBe(true);
      }),
    ),
);

it.effect(
  "navigation completion retains its original failure once and does not stop an already settled operation",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const error = BrowserError.make({
          operation: "navigate",
          reason: Reasons.Interrupted.make({}),
          outcome: "unknown",
        });

        let stops = 0;

        const browser: BrowserSession = scriptedSession({
          startNavigation: () =>
            Effect.succeed({
              target: Target.make({ generation: 1, pageId: "page", frameId: "frame" }),
              completed: Effect.fail(error),
              stop: Effect.sync(() => {
                stops++;
              }),
            }),
        });

        const host = yield* BrowserTools.makeHost(browser);
        const tools = yield* BrowserTools.toolkit.pipe(Effect.provide(host.handlers));

        const results = yield* Stream.runCollect(
          yield* tools.handle("browser_navigate", { url: "https://example.test/" }, "completed"),
        );

        expect(results[0]?.encodedResult).toEqual({
          _tag: "BrowserToolFailure",
          reason: "stale",
          outcome: "unknown",
        });
        const snapshot = yield* host.toolFailures;

        expect(snapshot.failures).toHaveLength(1);
        expect(snapshot.failures[0]).toMatchObject({
          error: { reason: { _tag: "Interrupted" }, outcome: "unknown" },
          toolCallId: "completed",
        });
        expect(stops).toBe(0);
      }),
    ),
);
