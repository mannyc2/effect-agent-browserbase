import { expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Redacted, Tracer } from "effect";
import { FetchHttpClient } from "effect/http";

import { BrowserbaseClient } from "../src/Client.ts";
import { BrowserbaseProjects } from "../src/Projects.ts";

const privateName = "PRIVATE-PROJECT-NAME";

const project = {
  id: "project-1",
  name: privateName,
  ownerId: "PRIVATE-OWNER-ID",
  defaultTimeout: 300,
  concurrency: 25,
  createdAt: "2026-09-21T00:00:00.000Z",
  updatedAt: "2026-09-21T00:00:00.000Z",
};

const layers = BrowserbaseProjects.layer.pipe(
  Layer.provide(
    BrowserbaseClient.layer({ projectId: project.id, apiKey: Redacted.make("PRIVATE-API-KEY") }),
  ),
);

// The tracing audit at main d63463e reproduced project metadata in raw span-end exits,
// and throwing tracers preventing requests or replacing their typed outcomes. These failures
// require controlled tracer behavior at the public service boundary; ordinary E2E cannot force it.
it.effect("project tracing excludes response metadata from its terminal Exit", () => {
  const spans: Tracer.NativeSpan[] = [];

  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);

      spans.push(span);

      return span;
    },
  });

  return Effect.gen(function* () {
    const projects = yield* BrowserbaseProjects;
    const result = yield* projects.retrieve;

    expect(result.name).toBe(privateName);
    const span = spans.find((candidate) => candidate.name === "BrowserbaseProjects.retrieve");

    expect(span?.status).toMatchObject({ _tag: "Ended", exit: Exit.void });
    expect(
      JSON.stringify(
        spans.map((entry) => ({
          attributes: [...entry.attributes],
          events: entry.events,
          status: entry.status,
        })),
        (_, value: unknown) => (typeof value === "bigint" ? String(value) : value),
      ),
    ).not.toContain("PRIVATE-");
  }).pipe(
    Effect.provide(layers),
    Effect.provideService(FetchHttpClient.Fetch, async () => Response.json(project)),
    Effect.withTracer(tracer),
  );
});

for (const throwing of ["start", "end"] as const) {
  it.effect(
    `a tracer throwing on ${throwing} preserves project results and typed rejection`,
    () => {
      let fetches = 0;
      let attempts = 0;
      let reject = false;

      const tracer = Tracer.make({
        span: (options) => {
          attempts++;
          if (throwing === "start") throw new Error("PRIVATE-EXPORTER-START");
          const span = new Tracer.NativeSpan(options);

          span.end = () => {
            throw new Error("PRIVATE-EXPORTER-END");
          };

          return span;
        },
      });

      return Effect.gen(function* () {
        const projects = yield* BrowserbaseProjects;
        const success = yield* projects.retrieve.pipe(Effect.exit);

        expect(success).toMatchObject({ _tag: "Success", value: { name: privateName } });
        reject = true;
        const failed = yield* projects.retrieve.pipe(Effect.result);

        expect(failed).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "ProjectError",
            operation: "project-retrieve",
            reason: "provider",
            status: 400,
          },
        });
        expect(fetches).toBe(2);
        expect(attempts).toBeGreaterThan(0);
      }).pipe(
        Effect.provide(layers),
        Effect.provideService(FetchHttpClient.Fetch, async () => {
          fetches++;

          return reject ? new Response(null, { status: 400 }) : Response.json(project);
        }),
        Effect.withTracer(tracer),
      );
    },
  );
}
