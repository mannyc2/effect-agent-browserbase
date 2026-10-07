// A run's traces: exported over OTLP when the environment asks for it, and each unit's own spans
// collected, so its record can say where its time went and its recording can keep them.
import { Context, Effect, Exit, Layer, Option, Schema, Tracer } from "effect";
import { FetchHttpClient } from "effect/http";
import { Otlp, OtlpSerialization } from "effect/observability";

import type { Command } from "./Latency.ts";

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
  "Page.frame",
  "Moment.capture",
]);

const isTool = (span: Tracer.Span) =>
  span.attributes.get("gen_ai.operation.name") === "execute_tool";

/**
 * Where a unit's time went: opening its browser, running the model's tool calls, and looking at
 * the page between them. Each counts its outermost spans only. Model requests are timed by the
 * budget; the rest of a unit is the fixture, grading, closing the browser and the bench itself.
 */
export const phases = (spans: ReadonlyArray<Tracer.Span>): Phases => {
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

/** Seconds opening the browser, in the model's tool calls, and looking at the page outside them. */
export const Phases = Schema.Struct({
  setupSeconds: Schema.Finite,
  toolSeconds: Schema.Finite,
  observeSeconds: Schema.Finite,
});

export type Phases = typeof Phases.Type;

export const noPhases: Phases = { setupSeconds: 0, toolSeconds: 0, observeSeconds: 0 };

/** The trace a unit's spans belong to: its root's. */
export const traceOf = (spans: ReadonlyArray<Tracer.Span>): string | null =>
  spans.find((span) => Option.isNone(span.parent))?.traceId ?? null;

const startOf = (span: Tracer.Span) => span.status.startTime;

const middle = (start: bigint, end: bigint) => (start + end) / 2n;

const bySent = (left: Command, right: Command) => Number(left.sent - right.sent);

// The innermost span open at `at`: the latest started of those not yet ended.
const innermost = (spans: ReadonlyArray<Tracer.Span>, at: bigint) => {
  let found: Tracer.Span | undefined;

  for (const span of spans)
    if (
      startOf(span) <= at &&
      (span.status._tag === "Started" || span.status.endTime >= at) &&
      (found === undefined || startOf(span) >= startOf(found))
    )
      found = span;

  return found;
};

// Round trips taken one after another: a command sent before the earlier ones were all answered
// shares their round trip.
const roundTrips = (sent: ReadonlyArray<Command>) => {
  let count = 0;
  let busyUntil: bigint | undefined;

  for (const command of sent) {
    if (busyUntil === undefined || command.sent >= busyUntil) count++;
    if (busyUntil === undefined || command.ended > busyUntil) busyUntil = command.ended;
  }

  return count;
};

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** The DevTools commands sent while spans of one name were the innermost open. */
export const Waited = Schema.Struct({
  /** Spans of the name, whether or not they sent anything. */
  spans: Count,
  commands: Count,
  roundTrips: Count,
  methods: Schema.Record(Schema.String, Count),
});

export type Waited = typeof Waited.Type;

/** What a unit asked of its browser over the DevTools protocol, and where it was waiting. */
export const Protocol = Schema.Struct({
  commands: Count,
  roundTrips: Count,
  /** By the innermost span open in the middle of each command; only names that sent any. */
  bySpan: Schema.Record(Schema.String, Waited),
});

export type Protocol = typeof Protocol.Type;

const failures = { error: "cdp_error", none: "unanswered" } as const;

/**
 * Put each command in the trace, as a client span under the innermost span open in the middle of
 * it, and count the commands and round trips by that span's name. Attribution is by time alone, so
 * a command sent in the background, such as a screencast frame's acknowledgement, lands on
 * whatever span was open.
 */
export const protocol = (collected: Collected, sent: ReadonlyArray<Command>): Protocol => {
  // Taken before the commands' own spans join them.
  const spans = [...collected.spans];
  const ordered = sent.toSorted(bySent);
  const byParent = new Map<Tracer.Span, Array<Command>>();

  for (const command of ordered) {
    const parent = innermost(spans, middle(command.sent, command.ended));

    if (parent === undefined) continue;

    const span = collected.tracer.span({
      name: `CDP ${command.method}`,
      parent: Option.some(parent),
      annotations: Context.empty(),
      links: [],
      startTime: command.sent,
      kind: "client",
      root: false,
      sampled: parent.sampled,
    });

    span.attribute("rpc.system", "cdp");
    span.attribute("rpc.method", command.method);
    if (command.answer !== "result") span.attribute("error.type", failures[command.answer]);
    span.end(
      command.ended,
      command.answer === "result" ? Exit.void : Exit.fail(failures[command.answer]),
    );

    const siblings = byParent.get(parent);

    if (siblings === undefined) byParent.set(parent, [command]);
    else siblings.push(command);
  }

  const bySpan = new Map<
    string,
    { spans: number; commands: number; roundTrips: number; methods: Record<string, number> }
  >();

  for (const span of spans) {
    const own = byParent.get(span) ?? [];
    const waited = bySpan.get(span.name) ?? { spans: 0, commands: 0, roundTrips: 0, methods: {} };

    waited.spans++;
    waited.commands += own.length;
    waited.roundTrips += roundTrips(own);
    for (const { method } of own) waited.methods[method] = (waited.methods[method] ?? 0) + 1;
    bySpan.set(span.name, waited);
  }

  return {
    commands: ordered.length,
    roundTrips: roundTrips(ordered),
    bySpan: Object.fromEntries([...bySpan].filter(([, waited]) => waited.commands > 0)),
  };
};

/**
 * The fastest round trip to the browser that the unit's clock calibrations measured
 * (`Page.calibrateClock`, which a browser's first capture runs); null if none ran.
 */
export const roundTripOf = (spans: ReadonlyArray<Tracer.Span>): number | null => {
  const measured = spans.flatMap((span) => {
    const value = span.attributes.get("roundTripMillis");

    return typeof value === "number" ? [value] : [];
  });

  return measured.length === 0 ? null : Math.min(...measured);
};

/** A hosted unit's Browserbase region, as `Browserbase.open` recorded it; null otherwise. */
export const regionOf = (spans: ReadonlyArray<Tracer.Span>): string | null => {
  const region = spans.find((span) => span.name === "Browserbase.open")?.attributes.get("region");

  return typeof region === "string" ? region : null;
};

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
