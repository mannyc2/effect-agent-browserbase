// Aggregate one worker's native Playwright protocol logger without retaining payloads.
import { Schema } from "effect";

export const environment = {
  DEBUG: "pw:protocol",
  DEBUG_COLORS: "false",
  DEBUG_HIDE_DATE: "false",
  DEBUG_FILE: "",
  MAX_LOG_LENGTH: "Infinity",
} as const;

const defaults = {
  maxLineBytes: 2 * 1024 * 1024,
  maxPending: 8192,
  maxLatencyBuckets: 8192,
} as const;

export interface Limits {
  readonly maxLineBytes?: number;
  readonly maxPending?: number;
  readonly maxLatencyBuckets?: number;
}

const domains = () => ({
  browser: 0,
  target: 0,
  page: 0,
  runtime: 0,
  input: 0,
  network: 0,
  dom: 0,
  emulation: 0,
  fetch: 0,
  performance: 0,
  other: 0,
});

type Domain = keyof ReturnType<typeof domains>;

const domainOf = (method: string): Domain => {
  switch (method.split(".", 1)[0] ?? "") {
    case "Browser":
      return "browser";
    case "Target":
      return "target";
    case "Page":
      return "page";
    case "Runtime":
      return "runtime";
    case "Input":
      return "input";
    case "Network":
      return "network";
    case "DOM":
      return "dom";
    case "Emulation":
      return "emulation";
    case "Fetch":
      return "fetch";
    case "Performance":
      return "performance";
    default:
      return "other";
  }
};

const Message = Schema.Struct({
  id: Schema.optional(
    Schema.Int.check(
      Schema.isBetween({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }),
    ),
  ),
  sessionId: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  method: Schema.optional(
    Schema.String.check(
      Schema.isMaxLength(128),
      Schema.isPattern(/^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/),
    ),
  ),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown),
});

const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(Message));

/** Prefix dates are emitted by debug with colors and hideDate disabled, before each native log. */
const prefix = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) pw:protocol (SEND ► |◀ RECV )(.+)$/;
const truncation = "<<<<<( LOG TRUNCATED )>>>>>";

export interface Snapshot {
  readonly complete: boolean;
  readonly finished: boolean;
  readonly observed: boolean;
  readonly scope: "playwright-protocol-logger";
  readonly latencyClock: "logger-wall-millis";
  readonly byteMeasurement: "serialized-cdp-json-utf8";
  readonly commands: number;
  readonly replies: number;
  readonly matchedReplies: number;
  readonly unmatchedReplies: number;
  readonly pendingCommands: number;
  readonly pendingShutdownCommands: number;
  readonly knownUnloggedShutdownReplies: number;
  readonly errors: number;
  readonly events: number;
  readonly bytes: { readonly sent: number; readonly received: number };
  readonly commandsByDomain: Readonly<ReturnType<typeof domains>>;
  readonly eventsByDomain: Readonly<ReturnType<typeof domains>>;
  readonly ignoredStderrLines: number;
  readonly issues: {
    readonly malformedLines: number;
    readonly truncatedLines: number;
    readonly oversizedLines: number;
    readonly invalidUtf8Lines: number;
    readonly unfinishedLines: number;
    readonly pendingOverflow: number;
    readonly duplicateCommands: number;
    readonly clockRegressions: number;
    readonly latencyOverflow: number;
    readonly chunksAfterFinish: number;
  };
  readonly latency: {
    readonly measuredReplies: number;
    readonly p50Millis: number | null;
    readonly p95Millis: number | null;
    readonly minMillis: number | null;
    readonly maxMillis: number | null;
  };
}

export interface Sink {
  readonly feed: (chunk: Uint8Array) => void;
  readonly finish: () => Snapshot;
  readonly snapshot: () => Snapshot;
}

/**
 * Set environment on spawn, before importing Playwright, and call finish only after stderr EOF.
 * Per-worker isolation matters: different native connections can reuse command/session identifiers.
 */
export const make = (options: Limits = {}): Sink => {
  const limits = { ...defaults, ...options };

  for (const key of ["maxLineBytes", "maxPending", "maxLatencyBuckets"] as const) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > defaults[key])
      throw new RangeError(
        "Protocol limits must be positive integers no greater than the defaults",
      );
  }

  const line = new Uint8Array(limits.maxLineBytes);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const pending = new Map<string, { readonly at: number; readonly shutdown: boolean }>();
  const latencies = new Map<number, number>();
  const commandsByDomain = domains();
  const eventsByDomain = domains();

  const issues = {
    malformedLines: 0,
    truncatedLines: 0,
    oversizedLines: 0,
    invalidUtf8Lines: 0,
    unfinishedLines: 0,
    pendingOverflow: 0,
    duplicateCommands: 0,
    clockRegressions: 0,
    latencyOverflow: 0,
    chunksAfterFinish: 0,
  };

  let length = 0;
  let dropping = false;
  let finished = false;
  let commands = 0;
  let replies = 0;
  let matchedReplies = 0;
  let unmatchedReplies = 0;
  let unmatchedShutdownReplies = 0;
  let errors = 0;
  let events = 0;
  let sentBytes = 0;
  let receivedBytes = 0;
  let ignoredStderrLines = 0;
  let previousTime: number | undefined;
  let measuredReplies = 0;
  let minMillis: number | null = null;
  let maxMillis: number | null = null;

  const processLine = () => {
    let text: string;

    try {
      text = decoder.decode(line.subarray(0, length)).replace(/\r$/, "");
    } catch {
      issues.invalidUtf8Lines += 1;

      return;
    }

    const match = prefix.exec(text);

    if (match === null) {
      if (text.includes("pw:protocol")) issues.malformedLines += 1;
      else ignoredStderrLines += 1;

      return;
    }

    const [, stamp, direction, payload] = match;

    if (stamp === undefined || direction === undefined || payload === undefined) {
      issues.malformedLines += 1;

      return;
    }
    if (payload.includes(truncation)) {
      issues.truncatedLines += 1;

      return;
    }

    const at = Date.parse(stamp);
    const parsed = decodeMessage(payload);

    if (!Number.isFinite(at) || new Date(at).toISOString() !== stamp || parsed._tag === "None") {
      issues.malformedLines += 1;

      return;
    }
    if (previousTime !== undefined && at < previousTime) issues.clockRegressions += 1;
    previousTime = at;
    const message = parsed.value;
    const isSend = direction === "SEND ► ";
    const hasResult = "result" in message;
    const hasError = "error" in message;
    const id = message.id;
    const method = message.method;

    if (isSend) {
      if (id === undefined || method === undefined || hasResult || hasError) {
        issues.malformedLines += 1;

        return;
      }
      commands += 1;
      sentBytes += Buffer.byteLength(payload, "utf8");
      const domain = domainOf(method);
      const key = JSON.stringify([message.sessionId ?? "", id]);

      commandsByDomain[domain] += 1;
      if (pending.has(key)) issues.duplicateCommands += 1;
      else if (pending.size >= limits.maxPending) issues.pendingOverflow += 1;
      else pending.set(key, { at, shutdown: method === "Browser.close" });

      return;
    }

    if (id === undefined && method !== undefined && !hasResult && !hasError) {
      events += 1;
      receivedBytes += Buffer.byteLength(payload, "utf8");
      eventsByDomain[domainOf(method)] += 1;

      return;
    }

    if (id === undefined || method !== undefined || hasResult === hasError) {
      issues.malformedLines += 1;

      return;
    }

    replies += 1;
    receivedBytes += Buffer.byteLength(payload, "utf8");
    if (hasError) errors += 1;
    const key = JSON.stringify([message.sessionId ?? "", id]);
    const request = pending.get(key);

    if (request === undefined) {
      unmatchedReplies += 1;
      // Pinned Chromium sends graceful close directly to transport, bypassing the send logger.
      // Its -9999 reply is observable; count the gap without inventing a command or byte count.
      if (id === -9999 && (message.sessionId ?? "") === "") unmatchedShutdownReplies += 1;

      return;
    }
    pending.delete(key);
    matchedReplies += 1;
    const elapsed = at - request.at;

    if (elapsed < 0) return;
    measuredReplies += 1;
    minMillis = minMillis === null ? elapsed : Math.min(minMillis, elapsed);
    maxMillis = maxMillis === null ? elapsed : Math.max(maxMillis, elapsed);
    if (issues.latencyOverflow > 0) return;
    const count = latencies.get(elapsed);

    if (count !== undefined) latencies.set(elapsed, count + 1);
    else if (latencies.size < limits.maxLatencyBuckets) latencies.set(elapsed, 1);
    else {
      issues.latencyOverflow += 1;
      latencies.clear();
    }
  };

  const percentile = (fraction: number): number | null => {
    if (measuredReplies === 0 || issues.latencyOverflow > 0) return null;
    const rank = Math.ceil(measuredReplies * fraction);
    let count = 0;

    for (const [elapsed, frequency] of [...latencies].sort(([left], [right]) => left - right)) {
      count += frequency;
      if (count >= rank) return elapsed;
    }

    return null;
  };

  const snapshot = (): Snapshot => ({
    complete:
      finished &&
      commands > 0 &&
      pending.size === 0 &&
      unmatchedReplies === 0 &&
      Object.values(issues).every((count) => count === 0),
    finished,
    observed: commands + replies + events > 0,
    scope: "playwright-protocol-logger",
    latencyClock: "logger-wall-millis",
    byteMeasurement: "serialized-cdp-json-utf8",
    commands,
    replies,
    matchedReplies,
    unmatchedReplies,
    pendingCommands: pending.size,
    pendingShutdownCommands: [...pending.values()].filter((request) => request.shutdown).length,
    knownUnloggedShutdownReplies: unmatchedShutdownReplies,
    errors,
    events,
    bytes: { sent: sentBytes, received: receivedBytes },
    commandsByDomain: { ...commandsByDomain },
    eventsByDomain: { ...eventsByDomain },
    ignoredStderrLines,
    issues: { ...issues },
    latency: {
      measuredReplies,
      p50Millis: percentile(0.5),
      p95Millis: percentile(0.95),
      minMillis,
      maxMillis,
    },
  });

  return {
    feed: (chunk) => {
      if (finished) {
        issues.chunksAfterFinish += 1;

        return;
      }
      for (const byte of chunk) {
        if (byte === 10) {
          if (!dropping) processLine();
          length = 0;
          dropping = false;
        } else if (!dropping) {
          if (length === line.length) {
            issues.oversizedLines += 1;
            dropping = true;
            length = 0;
          } else {
            line[length] = byte;
            length += 1;
          }
        }
      }
    },
    finish: () => {
      if (!finished) {
        if (length > 0 || dropping) issues.unfinishedLines += 1;
        length = 0;
        dropping = false;
        finished = true;
      }

      return snapshot();
    },
    snapshot,
  };
};
