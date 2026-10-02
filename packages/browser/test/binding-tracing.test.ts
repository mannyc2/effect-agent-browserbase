import { expect, it } from "@effect/vitest";
import { Effect, Option, Schema, Tracer } from "effect";

import * as Bootstrap from "../src/Bootstrap.ts";
import * as Testing from "../src/Testing.ts";

// Bindings.ts / BindingRunner.ts on main d63463e capture acquisition ParentSpan as execution
// ancestry. A native page callback has no authenticated Effect caller; its owner should be a link.
for (const sampled of [true, false]) {
  it.effect(
    `page binding starts autonomous work linked to its ${sampled ? "sampled" : "unsampled"} acquisition`,
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
          const browser = yield* Testing.open(
            { documents: [{ url: "https://binding-trace.test/", text: "" }] },
            {
              bootstrap: Bootstrap.binding({
                name: "readSettings",
                origins: ["https://binding-trace.test"],
                input: Schema.Finite,
                output: Schema.Finite,
                handle: (value) =>
                  Effect.succeed(value).pipe(
                    Effect.withSpan("test.binding-handler", {}, { captureStackTrace: false }),
                  ),
              }),
            },
          ).pipe(
            Effect.withSpan("test.binding-acquisition", { sampled }, { captureStackTrace: false }),
          );

          yield* browser.initialPage.navigate({ url: "https://binding-trace.test/" });

          const unrelated = Tracer.externalSpan({
            traceId: "33333333333333333333333333333333",
            spanId: "4444444444444444",
          });

          expect(
            yield* browser.control
              .invoke("readSettings", 7)
              .pipe(Effect.withParentSpan(unrelated, { captureStackTrace: false })),
          ).toEqual({ ok: true, output: 7 });
          const acquisition = spans.find((span) => span.name === "test.binding-acquisition");
          const ownedAcquisition = spans.find((span) => span.name === "Browser.acquire");
          const binding = spans.find((span) => span.name === "Browser.binding");
          const handler = spans.find((span) => span.name === "test.binding-handler");

          expect(acquisition).toBeDefined();
          expect(ownedAcquisition).toBeDefined();
          expect(binding).toBeDefined();
          expect(handler).toBeDefined();
          if (
            acquisition === undefined ||
            ownedAcquisition === undefined ||
            binding === undefined ||
            handler === undefined
          )
            return yield* Effect.die("Missing binding trace evidence");
          expect(ownedAcquisition.traceId).toBe(acquisition.traceId);
          expect(Option.isNone(binding.parent)).toBe(true);
          expect(binding.traceId).not.toBe(acquisition.traceId);
          expect(binding.traceId).not.toBe(unrelated.traceId);
          expect(binding.sampled).toBe(sampled);
          expect(binding.links).toMatchObject([
            {
              span: { traceId: ownedAcquisition.traceId, spanId: ownedAcquisition.spanId, sampled },
            },
          ]);
          expect(handler.traceId).toBe(binding.traceId);
          expect(handler.sampled).toBe(sampled);
          expect(binding.status._tag).toBe("Ended");
        }),
      ).pipe(Effect.withTracer(tracer));
    },
  );
}
