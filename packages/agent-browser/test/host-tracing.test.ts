import { expect, it } from "@effect/vitest";
import { Context, Effect, Exit, Option, Scope, Stream, Tracer } from "effect";
import * as BrowserTools from "effect-agent-browser/tools";
import * as Testing from "effect-browser/testing";

class CallbackValue extends Context.Service<CallbackValue, { readonly value: string }>()(
  "test/host-tracing/CallbackValue",
) {}

const reaches = (span: Tracer.Span, target: Tracer.AnySpan, spans: ReadonlyArray<Tracer.Span>) => {
  let parent = Option.getOrUndefined(span.parent);

  for (let remaining = spans.length + 1; parent !== undefined && remaining > 0; remaining--) {
    if (parent.traceId === target.traceId && parent.spanId === target.spanId) return true;

    const recorded = spans.find(
      (candidate) => candidate.traceId === parent?.traceId && candidate.spanId === parent.spanId,
    );

    parent = recorded === undefined ? undefined : Option.getOrUndefined(recorded.parent);
  }

  return false;
};

// Host.ts on main d63463e substitutes its complete acquisition Context for callbacks. Public
// results cannot reveal wrong ancestry or a disabled caller unexpectedly exporting callback work.
// Existing host-lane regressions cover cancellation, reentry, and callback/finalizer ordering.
for (const mode of ["external", "ended", "unsampled", "disabled", "disabled-parent"] as const) {
  it.effect(
    `input callback keeps ${mode} caller tracing with captured services and its own scope`,
    () => {
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
          const browser = yield* Testing.open({
            documents: [{ url: "https://trace.test/", text: "" }],
          });

          const outer = yield* Scope.Scope;
          let callbackScope: Scope.Scope | undefined;
          let service: string | undefined;
          let finalized = 0;

          const host = yield* BrowserTools.makeHost(browser, browser.initialPage, {
            onInput: Effect.fn("test.input-callback")(function* () {
              callbackScope = yield* Scope.Scope;
              service = (yield* CallbackValue).value;
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  finalized++;
                }),
              );
            }),
          }).pipe(
            Effect.provideService(CallbackValue, { value: "acquired" }),
            Effect.withSpan("test.host-acquisition", {}, { captureStackTrace: false }),
            Effect.withTracerEnabled(true),
          );

          const tools = yield* BrowserTools.nativeToolkit.pipe(Effect.provide(host.layer));

          const external = Tracer.externalSpan({
            traceId: "11111111111111111111111111111111",
            spanId: "2222222222222222",
            sampled: mode !== "unsampled",
          });

          const ended = yield* Effect.makeSpan("test.ended-caller", { parent: external });

          ended.end(0n, Exit.void);

          const disabled = yield* Effect.makeSpan("test.disabled-parent", {
            parent: external,
            annotations: Context.make(Tracer.DisablePropagation, true),
          });

          const parent =
            mode === "ended" ? ended : mode === "disabled-parent" ? disabled : external;

          const result = yield* tools
            .handle("browser_pointer_move", { to: { x: 1, y: 2 } }, "trace-call")
            .pipe(
              Effect.flatMap(Stream.runCollect),
              Effect.provideService(CallbackValue, { value: "caller" }),
              Effect.withParentSpan(parent, { captureStackTrace: false }),
              Effect.withTracerEnabled(mode !== "disabled"),
            );

          expect(result).toMatchObject([{ isFailure: false }]);
          expect(service).toBe("acquired");
          expect(callbackScope).toBeDefined();
          expect(callbackScope).not.toBe(outer);
          expect(finalized).toBe(1);
          const callbacks = spans.filter((span) => span.name === "test.input-callback");

          if (mode === "disabled") {
            expect(callbacks).toHaveLength(0);
          } else {
            expect(callbacks).toHaveLength(1);
            const callback = callbacks[0];

            if (callback === undefined) return yield* Effect.die("Missing callback trace");
            expect(callback.traceId).toBe(external.traceId);
            expect(callback.sampled).toBe(mode !== "unsampled");
            expect(reaches(callback, mode === "ended" ? ended : external, spans)).toBe(true);
          }
        }),
      ).pipe(Effect.withTracer(tracer));
    },
  );
}
