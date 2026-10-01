import { expect, it } from "@effect/vitest";
import { Effect, Exit, Option, Tracer } from "effect";
import { TestClock } from "effect/testing";

import * as Browser from "../src/Browser.ts";
import * as Testing from "../src/Testing.ts";

// A direct API caller has no application parent. Explicit owned-execution ancestry must still
// win over an ambient root default; ordinary successful navigation performs no recovery work.
it.effect("navigation recovery belongs to its owned execution for an untraced caller", () => {
  const spans: Tracer.NativeSpan[] = [];
  const ends: string[] = [];
  const creations: Array<{ readonly name: string; readonly root: boolean }> = [];
  const url = "https://navigation-trace.test/";

  const tracer = Tracer.make({
    span: (options) => {
      creations.push({ name: options.name, root: options.root });
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);

      span.end = (time, exit) => {
        ends.push(span.spanId);
        end(time, exit);
      };
      spans.push(span);

      return span;
    },
  });

  return Browser.scoped(
    Testing.open({ documents: [{ url, text: "" }] }, { automation: { actionTimeoutMillis: 5000 } }),
    (browser) =>
      Effect.gen(function* () {
        yield* browser.navigate({ url });
        expect(spans.filter((span) => span.name === "Browser.navigation.recovery")).toEqual([]);

        const gate = yield* browser.control.gate;

        yield* browser.control.next("navigate", { _tag: "Hold", gate, dispatched: true });
        const operation = yield* browser.startNavigation({ url });

        yield* gate.reached;
        yield* TestClock.adjust("5 seconds");
        const result = yield* operation.completed.pipe(Effect.result);

        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { operation: "navigate", reason: { _tag: "Timeout" }, outcome: "unknown" },
        });
        expect((yield* browser.status).phase).toBe("open");
        const execution = spans.filter((span) => span.name === "Browser.navigation").at(-1);
        const recoveries = spans.filter((span) => span.name === "Browser.navigation.recovery");

        expect(execution).toBeDefined();
        expect(recoveries).toHaveLength(1);
        expect(creations.find((entry) => entry.name === "Browser.navigation.recovery")?.root).toBe(
          false,
        );
        const recovery = recoveries[0];

        if (execution === undefined || recovery === undefined)
          return yield* Effect.die("Missing navigation tracing evidence");
        expect(Option.isNone(execution.parent)).toBe(true);
        expect(recovery.parent).toMatchObject({
          value: {
            traceId: execution.traceId,
            spanId: execution.spanId,
            sampled: execution.sampled,
          },
        });
        expect(recovery.traceId).toBe(execution.traceId);
        expect(recovery.sampled).toBe(execution.sampled);
        expect(execution.status).toMatchObject({ _tag: "Ended", exit: { _tag: "Failure" } });
        expect(recovery.status).toMatchObject({ _tag: "Ended", exit: Exit.void });
        expect(ends.filter((id) => id === execution.spanId)).toHaveLength(1);
        expect(ends.filter((id) => id === recovery.spanId)).toHaveLength(1);
        yield* gate.open;
      }),
  ).pipe(Effect.withTracer(tracer));
});
