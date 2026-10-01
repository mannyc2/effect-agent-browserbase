import { expect, it } from "@effect/vitest";
import { Effect, Exit, Stream, Tracer } from "effect";
import * as Tools from "effect-agent-browser/tools";
import * as Browser from "effect-browser/browser";
import { Reasons } from "effect-browser/errors";
import * as Testing from "effect-browser/testing";

// The tracing audit at main d63463e found the follow-up reading failure is intentionally
// absorbed into an Unavailable result. The public result already has regression coverage;
// retain this narrow integration proof that telemetry preserves each native operation's outcome.
it.effect(
  "successful input and an unavailable follow-up observation have distinct terminal evidence",
  () => {
    const spans: Tracer.NativeSpan[] = [];

    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);

        spans.push(span);

        return span;
      },
    });

    return Browser.scoped(
      Testing.open({
        documents: [
          {
            url: "https://privacy.test/?PRIVATE-URL",
            text: "PRIVATE-PAGE",
            controls: [{ id: "go", kind: "button", label: "Go" }],
          },
        ],
      }),
      (browser) =>
        Effect.gen(function* () {
          const seen = yield* browser.observe();
          const host = yield* Tools.makeHost(browser);
          const toolkit = yield* Tools.observedToolkit.pipe(Effect.provide(host.observedHandlers));

          yield* browser.control.next("observe", {
            _tag: "Fail",
            reason: Reasons.Timeout.make({}),
            outcome: "undispatched",
          });
          const before = spans.length;

          const result = yield* Stream.runCollect(
            yield* toolkit.handle(
              "browser_click_and_inspect",
              { observationId: seen.observationId, elementId: "go" },
              "PRIVATE-CALL-ID",
            ),
          );

          expect(result).toMatchObject([
            {
              isFailure: false,
              encodedResult: {
                action: { url: seen.url },
                observation: {
                  _tag: "Unavailable",
                  failure: { reason: "timeout", outcome: "undispatched" },
                },
              },
            },
          ]);
          expect((yield* host.toolFailures).failures).toMatchObject([
            {
              error: { operation: "observe", reason: { _tag: "Timeout" }, outcome: "undispatched" },
            },
          ]);
          const callSpans = spans.slice(before);
          const input = callSpans.find((span) => span.name === "Browser.click");
          const observation = callSpans.find((span) => span.name === "Browser.observe");

          expect(input?.status).toMatchObject({ _tag: "Ended", exit: Exit.void });
          expect(observation?.status).toMatchObject({ _tag: "Ended", exit: { _tag: "Failure" } });
          expect(observation?.attributes.get("browser.outcome")).toBe("undispatched");
          expect(
            JSON.stringify(
              callSpans.map((entry) => ({
                attributes: [...entry.attributes],
                events: entry.events,
                status: entry.status,
              })),
              (_, value: unknown) => (typeof value === "bigint" ? String(value) : value),
            ),
          ).not.toContain("PRIVATE-");
          expect(
            (yield* browser.control.calls).filter((call) => call.operation === "click"),
          ).toHaveLength(1);
        }),
    ).pipe(Effect.withTracer(tracer));
  },
);
