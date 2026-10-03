import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Redacted, Stream, Tracer } from "effect";
import { FetchHttpClient } from "effect/http";

import { BrowserbaseClient } from "../src/Client.ts";

// Existing streaming cases prove transfer bounds. This public transport seam additionally
// proves tracing covers setup and finalizers once per subscription without exporting payloads.
it.effect(
  "stream tracing preserves independent subscriptions, cancellation and private results",
  () => {
    const spans: Tracer.NativeSpan[] = [];
    const endings: Array<{ readonly span: Tracer.NativeSpan; readonly aborted: number }> = [];
    const body = new TextEncoder().encode("PRIVATE-STREAM-BODY");
    let aborted = 0;
    let fetches = 0;
    let pending = false;

    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        const end = span.end.bind(span);

        span.end = (time, exit) => {
          endings.push({ span, aborted });
          end(time, exit);
        };
        spans.push(span);

        return span;
      },
    });

    const fetch: typeof globalThis.fetch = async (input, init) => {
      fetches++;
      const request = new Request(input, init);

      expect(request.headers.get("x-bb-api-key")).toBe("PRIVATE-API-KEY");
      expect(request.headers.get("traceparent")).toBeNull();
      expect(request.headers.get("tracestate")).toBeNull();

      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            request.signal.addEventListener(
              "abort",
              () => {
                aborted++;
                if (pending) controller.error(new Error("PRIVATE-ABORT-DIAGNOSTIC"));
              },
              { once: true },
            );
            controller.enqueue(body);
            if (!pending) controller.close();
          },
        }),
        { headers: { "content-type": "application/octet-stream" } },
      );
    };

    const parent = Tracer.externalSpan({
      traceId: "11111111111111111111111111111111",
      spanId: "2222222222222222",
      sampled: false,
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const client = yield* BrowserbaseClient;

        const source = client.bytes("/v1/downloads/file?secret=PRIVATE-URL", 100, [
          "application/octet-stream",
        ]);

        for (let subscription = 0; subscription < 2; subscription++) {
          const chunks = yield* Stream.runCollect(source);

          expect(Array.from(chunks).flatMap((chunk) => [...chunk])).toEqual([...body]);
          expect(aborted).toBe(subscription + 1);
        }

        const rejected = yield* Stream.runCollect(
          client.bytes("/v1/downloads/file", 0, ["application/octet-stream"]),
        ).pipe(Effect.result);

        expect(rejected).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "ClientError", operation: "provider-read", reason: "configuration" },
        });
        expect(fetches).toBe(2);

        pending = true;
        const entered = yield* Deferred.make<void>();

        const consumer = yield* Stream.runForEach(source, () =>
          Deferred.succeed(entered, undefined),
        ).pipe(Effect.forkChild);

        yield* Deferred.await(entered);
        yield* Fiber.interrupt(consumer);
        const cancelled = yield* Fiber.await(consumer);

        expect(Exit.isFailure(cancelled)).toBe(true);
        expect(aborted).toBe(3);
        expect(fetches).toBe(3);

        const transfers = spans.filter((span) => span.name === "BrowserbaseClient.bytes");

        expect(transfers).toHaveLength(4);
        expect(transfers.map((span) => span.attributes.get("browser.status"))).toEqual([
          "success",
          "success",
          "failure",
          "interrupted",
        ]);
        expect(transfers[2]?.attributes.get("browser.reason")).toBe("configuration");
        expect(
          endings.filter(({ span }) => transfers.includes(span)).map(({ aborted: count }) => count),
        ).toEqual([1, 2, 2, 3]);
        for (const span of transfers) {
          expect(span.parent).toMatchObject({
            value: { spanId: parent.spanId, traceId: parent.traceId },
          });
          expect(span.sampled).toBe(false);
          expect(endings.filter((entry) => entry.span === span)).toHaveLength(1);
          expect(span.status._tag).toBe("Ended");
          if (span.status._tag === "Ended" && span.attributes.get("browser.status") === "success")
            expect(span.status.exit).toEqual(Exit.void);
        }
        expect(
          JSON.stringify(
            spans.map((span) => ({
              attributes: [...span.attributes],
              events: span.events,
              status: span.status,
            })),
            (_, value: unknown) => (typeof value === "bigint" ? String(value) : value),
          ),
        ).not.toContain("PRIVATE-");
      }),
    ).pipe(
      Effect.provide(
        BrowserbaseClient.layer({
          projectId: "project-1",
          apiKey: Redacted.make("PRIVATE-API-KEY"),
        }),
      ),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
      Effect.withParentSpan(parent),
      Effect.withTracer(tracer),
    );
  },
);
