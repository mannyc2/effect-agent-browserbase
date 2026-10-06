// A run's traces: exported over OTLP when the environment asks for it, and each unit's own spans
// collected, so its record can say where its time went and its recording can keep them.
import { Effect, Layer, Option, Tracer } from "effect";
import { FetchHttpClient } from "effect/http";
import { Otlp, OtlpSerialization } from "effect/observability";

/**
 * Export over OTLP/HTTP to `OTEL_EXPORTER_OTLP_ENDPOINT` the signals named by
 * `OTEL_TRACES_EXPORTER=otlp` (and the logs and metrics variables). Unset, it exports nothing.
 */
export const layer = Otlp.layerFromConfig({
  resource: { serviceName: "effect-browser-bench" },
}).pipe(Layer.provide(OtlpSerialization.layerJson), Layer.provide(FetchHttpClient.layer));

export interface Collected {
  /** The tracer already installed, also keeping every span it starts. */
  readonly tracer: Tracer.Tracer;
  readonly spans: ReadonlyArray<Tracer.Span>;
}

/** Keep the spans of whatever runs with the returned tracer, still exporting them as before. */
export const collect: Effect.Effect<Collected> = Effect.map(Effect.tracer, (installed) => {
  const spans: Array<Tracer.Span> = [];

  const tracer = Tracer.make({
    span: (options) => {
      const span = installed.span(options);

      spans.push(span);

      return span;
    },
    ...(installed.context === undefined ? {} : { context: installed.context }),
  });

  return { tracer, spans };
});

const seconds = (span: Tracer.Span) =>
  span.status._tag === "Ended" ? Number(span.status.endTime - span.status.startTime) / 1e9 : 0;

const openers = new Set(["Chromium.open", "Browserbase.open", "Latency.open"]);

// Looks at a page outside any tool call: the agent's observation after each turn, an arm's own
// picture or outline, and a moment's capture.
const looks = new Set([
  "Page.observe",
  "Page.screenshot",
  "Page.snapshot",
  "Page.currentFrame",
  "Moment.capture",
]);

const isTool = (span: Tracer.Span) =>
  span.attributes.get("gen_ai.operation.name") === "execute_tool";

/**
 * Where a unit's time went: opening its browser, running the model's tool calls, and looking at
 * the page between them. Each counts its outermost spans only. Model requests are timed by the
 * budget; the rest of a unit is the fixture, grading, closing the browser and the bench itself.
 */
export const phases = (spans: ReadonlyArray<Tracer.Span>) => {
  const byId = new Map(spans.map((span) => [span.spanId, span]));

  const parentOf = (span: Tracer.Span) =>
    Option.getOrUndefined(
      Option.flatMapNullishOr(span.parent, (parent) => byId.get(parent.spanId)),
    );

  const within = (span: Tracer.Span, inside: (ancestor: Tracer.Span) => boolean) => {
    for (let ancestor = parentOf(span); ancestor !== undefined; ancestor = parentOf(ancestor))
      if (inside(ancestor)) return true;

    return false;
  };

  const total = (counts: (span: Tracer.Span) => boolean, inside = counts) =>
    spans
      .filter((span) => counts(span) && !within(span, inside))
      .reduce((sum, span) => sum + seconds(span), 0);

  const opens = (span: Tracer.Span) => openers.has(span.name);
  const look = (span: Tracer.Span) => looks.has(span.name);

  return {
    setupSeconds: total(opens),
    toolSeconds: total(isTool),
    observeSeconds: total(look, (span) => look(span) || isTool(span)),
  };
};

export type Phases = ReturnType<typeof phases>;

export const noPhases: Phases = { setupSeconds: 0, toolSeconds: 0, observeSeconds: 0 };

/** The trace a unit's spans belong to: its root's. */
export const traceOf = (spans: ReadonlyArray<Tracer.Span>): string | null =>
  spans.find((span) => Option.isNone(span.parent))?.traceId ?? null;

/** One finished span, timed on a recording's host clock. */
export interface Timed {
  readonly id: string;
  readonly parent: string | null;
  readonly name: string;
  readonly start: number;
  readonly end: number;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly failed: boolean;
}

/**
 * The finished spans, oldest first, with epoch nanoseconds moved onto a host monotonic clock that
 * read `host` milliseconds when the epoch clock read `epoch` nanoseconds.
 */
export const timed = (
  spans: ReadonlyArray<Tracer.Span>,
  at: { readonly epoch: bigint; readonly host: number },
): ReadonlyArray<Timed> =>
  spans
    .flatMap((span) =>
      span.status._tag === "Ended"
        ? [
            {
              id: span.spanId,
              parent: Option.getOrNull(Option.map(span.parent, (parent) => parent.spanId)),
              name: span.name,
              start: at.host + Number(span.status.startTime - at.epoch) / 1e6,
              end: at.host + Number(span.status.endTime - at.epoch) / 1e6,
              attributes: Object.fromEntries(
                [...span.attributes].filter(([key]) => !key.startsWith("code.")),
              ),
              failed: span.status.exit._tag === "Failure",
            },
          ]
        : [],
    )
    .toSorted((left, right) => left.start - right.start);
