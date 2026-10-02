import { expect, it } from "@effect/vitest";
import { Context, Effect, Exit, Layer, Option, Scope, Tracer } from "effect";
import { interactiveLayer } from "effect-agent-browser/adapter";
import { InteractiveBrowser, InteractiveBrowserPolicy } from "effect-agent/interactive-browser";
import * as Testing from "effect-browser/testing";

class OpenerValue extends Context.Service<OpenerValue, { readonly value: number }>()(
  "test/adapter-tracing/OpenerValue",
) {}

// Adapter.ts on main d63463e restores the caller Scope but retains Layer acquisition ParentSpan.
// The existing native adapter test proves captured services and two Chromium caller lifetimes;
// this public service seam exposes the independent tracing failure without another browser run.
it.effect.each(["ended", "minimum"] as const)(
  "framework acquisition keeps %s caller tracing and its execution scope with captured services",
  (mode) => {
    const spans: Tracer.Span[] = [];

    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);

        spans.push(span);

        return span;
      },
    });

    return Effect.scoped(
      Effect.gen(function* () {
        let value: number | undefined;
        let openerScope: Scope.Scope | undefined;
        let finalized = 0;

        const context = yield* Layer.build(
          interactiveLayer({
            implementation: "scripted-tracing",
            open: Effect.fn("test.framework-open")(function* () {
              value = (yield* OpenerValue).value;
              openerScope = yield* Scope.Scope;
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  finalized++;
                }),
              );

              return yield* Testing.open({
                documents: [{ url: "https://adapter-trace.test/", text: "" }],
              });
            }),
          }),
        ).pipe(
          Effect.provideService(OpenerValue, { value: 7 }),
          Effect.withSpan("test.framework-acquisition", {}, { captureStackTrace: false }),
          Effect.provideService(Tracer.MinimumTraceLevel, "All"),
        );

        const browser = Context.get(context, InteractiveBrowser);

        const external = Tracer.externalSpan({
          traceId: "55555555555555555555555555555555",
          spanId: "6666666666666666",
        });

        const caller = yield* Effect.makeSpan("test.framework-caller", { parent: external });

        caller.end(0n, Exit.void);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const executionScope = yield* Scope.Scope;

            yield* browser.open(
              InteractiveBrowserPolicy.make({
                network: { _tag: "Unrestricted" },
                maxActions: 10,
                maxElapsedMillis: 60_000,
                maxReturnedBytes: 1024,
              }),
            );
            expect(value).toBe(7);
            expect(openerScope).toBe(executionScope);
            expect(finalized).toBe(0);
          }),
        ).pipe(
          Effect.provideService(OpenerValue, { value: 99 }),
          Effect.withParentSpan(caller, { captureStackTrace: false }),
          Effect.provideService(Tracer.MinimumTraceLevel, mode === "minimum" ? "None" : "All"),
        );
        expect(finalized).toBe(1);
        const opened = spans.find((span) => span.name === "test.framework-open");

        expect(opened).toBeDefined();
        if (opened === undefined) return yield* Effect.die("Missing framework opener trace");
        expect(opened.traceId).toBe(external.traceId);
        expect(opened.sampled).toBe(mode !== "minimum");
        let parent = Option.getOrUndefined(opened.parent);
        let found = false;

        for (let remaining = spans.length + 1; parent !== undefined && remaining > 0; remaining--) {
          if (parent.traceId === caller.traceId && parent.spanId === caller.spanId) {
            found = true;
            break;
          }

          const recorded = spans.find(
            (span) => span.traceId === parent?.traceId && span.spanId === parent.spanId,
          );

          parent = recorded === undefined ? undefined : Option.getOrUndefined(recorded.parent);
        }
        expect(found).toBe(true);
      }),
    ).pipe(Effect.withTracer(tracer));
  },
);
