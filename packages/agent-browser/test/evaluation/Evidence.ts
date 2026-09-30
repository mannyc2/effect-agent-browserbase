import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { Cause, Context, Effect, Option, Schema } from "effect";
import { SessionStatus } from "effect-browser/browser-data";
import { BrowserOutcome } from "effect-browser/errors";
import { Prompt, Tool, type LanguageModel } from "effect/unstable/ai";

import {
  AttackName,
  Composition,
  Expectation,
  Family,
  Fixture,
  Role,
  Split,
  Task,
  cases,
  packages,
  runtime,
  type Entry,
} from "./Cases.ts";

const nonnegative = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** Artifact-only capture limits. Omission from a campaign preserves its earlier approved digest. */
export const CaptureRequest = Schema.Struct({
  format: Schema.Literal("jpeg-frames-v1"),
  maxFrames: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1800 })),
  maxBytes: Schema.Int.check(Schema.isBetween({ minimum: 1024 * 1024, maximum: 64 * 1024 * 1024 })),
  quality: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
});

export const CaptureProfile = Schema.Struct({
  ...CaptureRequest.fields,
  maxDurationMillis: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 305000 })),
});

export type CaptureProfile = typeof CaptureProfile.Type;

export interface RecordingFrame {
  readonly bytes: Uint8Array;
  readonly sourceTimeMillis: number;
  readonly sourceClock: "presentation-unix-millis";
  readonly receivedAt: number;
  readonly receivedMonotonicNanos: string;
  readonly sequence: number;
  readonly document: number;
  readonly width: number;
  readonly height: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}

/** Binary artifacts stay outside model events, terminal facts and offline replay. */
export interface Recording extends CaptureProfile {
  readonly frames: Array<RecordingFrame>;
  readonly startedAt: number;
  endedAt: number;
  stoppedAt: number | null;
  nativeStop: "missing" | "confirmed" | "unconfirmed";
  stopReason: string | null;
  overflowFrames: number;
  totalBytes: number;
  discardedFrames: number;
  discardedBytes: number;
  limitReached: "frames" | "bytes" | "duration" | null;
  error: string | null;
  summary: Schema.Json | null;
}

/** The model behind a run: a finite script, or a real provider named by a campaign plan. */
export const Provider = Schema.Literals(["openai", "anthropic", "typesafe"]);
export type Provider = typeof Provider.Type;

export const ReasoningEffort = Schema.Literals(["none", "minimal", "low", "medium", "high"]);

/**
 * How requests reach the provider: its own API, or OpenRouter, which serves the same request
 * formats under one credential and prices by its own list.
 */
export const Gateway = Schema.Literals(["direct", "openrouter"]);
export type Gateway = typeof Gateway.Type;

/** Settings a real model runs with; each is sent on every request and checked before it is. */
export const ChatSettings = Schema.Struct({
  gateway: Gateway,
  maxOutputTokens: Schema.Int.check(Schema.isBetween({ minimum: 256, maximum: 32768 })),
  /** OpenAI's reasoning effort; null leaves the provider's default, and is required for Anthropic. */
  reasoningEffort: Schema.NullOr(ReasoningEffort),
  /**
   * The standard tier, sent explicitly so an account default cannot change the price. Null
   * through OpenRouter, which prices by its own list and sends no tier.
   */
  serviceTier: Schema.NullOr(Schema.Literals(["default", "standard_only"])),
});

/** A decision model has no text-generation allowance or chat-provider settings. */
export const JevSettings = Schema.Struct({
  gateway: Schema.Literal("direct"),
  maxOutputTokens: Schema.Literal(0),
  reasoningEffort: Schema.Null,
  serviceTier: Schema.Null,
  decisionThreshold: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
});

export const Settings = Schema.Union([ChatSettings, JevSettings]);

/** Integer micro-dollars per million tokens, with the dated source they were read from. */
export const Rates = Schema.Struct({
  inputPerMillionMicrousd: nonnegative,
  cacheReadPerMillionMicrousd: nonnegative,
  cacheWritePerMillionMicrousd: nonnegative,
  outputPerMillionMicrousd: nonnegative,
  source: Schema.String.check(Schema.isPattern(/^https:\/\/\S{1,200}$/)),
  retrieved: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)),
});

export type Rates = typeof Rates.Type;

/** How a request is priced before it is sent; see Spend.ts. */
export const admission =
  "reserved before dispatch: request bytes + 1024 tokens at the dearest input rate, plus the request's whole output allowance; settled from reported usage" as const;

export const decisionAdmission =
  "reserved before dispatch: the full 65536-token request limit plus 1024 framing tokens at the declared input rate; settled from reported usage" as const;

export const Manifest = Schema.Struct({
  version: Schema.Literal(5),
  runId: Schema.String,
  sourceRevision: Schema.String,
  evaluator: Schema.Literal("browser-evaluation-v5"),
  task: Task,
  taskRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  family: Family,
  fixture: Fixture,
  attack: Schema.NullOr(AttackName),
  goal: Schema.String,
  toolkit: Composition,
  policy: Schema.String,
  role: Role,
  /** A scripted policy's declared verdicts; a measured run has none. */
  expected: Schema.NullOr(Expectation),
  split: Split,
  trial: nonnegative,
  seed: Schema.Literal(0),
  reset: Schema.Literal("new fixture and owner per run; serial declared order"),
  backend: Schema.Literals(["chromium", "browserbase", "scripted-owner"]),
  provider: Schema.Union([Schema.Literal("scripted"), Provider]),
  model: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._:/-]{1,100}$/)),
  /** The campaign's name for this model and its settings; null for a script. */
  subject: Schema.NullOr(Schema.String),
  boundary: Schema.Literals([
    "effect-language-model-provider-options; not provider HTTP",
    "typesafe-decisions; host-derived-tool-calls",
  ]),
  outputProvenance: Schema.Literals(["model", "decision-policy"]),
  settings: Schema.Union([
    Schema.Literal("deterministic finite script; no sampling or inference"),
    Settings,
  ]),
  rates: Schema.NullOr(Rates),
  spend: Schema.NullOr(
    Schema.Struct({
      perRunMicrousd: nonnegative,
      campaignMicrousd: nonnegative,
      admission: Schema.Literals([admission, decisionAdmission]),
    }),
  ),
  /** The approved plan a measured run belongs to. */
  campaign: Schema.NullOr(
    Schema.Struct({
      name: Schema.String,
      digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
    }),
  ),
  runtime: Schema.Struct({ name: Schema.Literals(["node", "bun"]), version: Schema.String }),
  packages: Schema.Struct({
    effect: Schema.String,
    effectAgent: Schema.String,
    effectBrowser: Schema.String,
    effectAgentBrowser: Schema.String,
    playwrightCore: Schema.String,
  }),
  browserVersion: Schema.Literal("unavailable"),
  capture: Schema.Union([Schema.Literal("off"), CaptureProfile]),
  viewport: Schema.Struct({ width: nonnegative, height: nonnegative }),
  bounds: Schema.Struct({
    maxTurns: nonnegative,
    maxToolCalls: nonnegative,
    maxDurationMillis: nonnegative,
    maxActions: nonnegative,
    actionTimeoutMillis: nonnegative,
    maxControls: nonnegative,
    maxTextBytes: nonnegative,
  }),
  limits: Schema.Struct({
    events: nonnegative,
    bytes: nonnegative,
    terminalBytes: nonnegative,
    retention: Schema.Literal("caller-owned results; never overwrite"),
  }),
  inputRetention: Schema.Literals([
    "trusted synthetic fixture only; no redaction",
    "trusted synthetic fixture; provider identifiers aliased, provider metadata removed",
  ]),
});

export type Manifest = typeof Manifest.Type;

export const Event = Schema.Struct({
  version: Schema.Literal(5),
  runId: Schema.String,
  seq: nonnegative,
  clock: Schema.Literal("host-performance-milliseconds"),
  at: Schema.Finite,
  kind: Schema.Literals(["request", "response", "history", "host", "decision-request", "decision"]),
  turn: Schema.NullOr(nonnegative),
  value: Schema.Json,
});

export type Event = typeof Event.Type;

const Submission = Schema.Struct({
  email: Schema.String,
  plan: Schema.String,
  terms: Schema.Boolean,
});

/**
 * A measured run's model spend. Cost is estimated from reported usage at the manifest's rates;
 * a reservation that was never settled is charged whole and counted in `retainedMicrousd`.
 */
export const Usage = Schema.Struct({
  admitted: nonnegative,
  settled: nonnegative,
  /** Why a request was refused before it was sent, if one was. */
  refused: Schema.NullOr(
    Schema.Literals(["run-budget", "campaign-budget", "closed", "contract", "concurrent"]),
  ),
  /** A request used more than was reserved for it, which closed the campaign. */
  overrun: Schema.Boolean,
  inputTokens: nonnegative,
  cacheReadInputTokens: nonnegative,
  cacheWriteInputTokens: nonnegative,
  outputTokens: nonnegative,
  reasoningTokens: nonnegative,
  costMicrousd: nonnegative,
  retainedMicrousd: nonnegative,
  limitMicrousd: nonnegative,
  status: Schema.Literals([
    "no-calls",
    "estimated-from-reported-usage",
    "includes-retained-reservations",
  ]),
});

export type Usage = typeof Usage.Type;

/** Host facts, never model-visible. Bounded projections only: no causes, handles or messages. */
export const Facts = Schema.Struct({
  /** What the agent was given: the goal, with the fixture's start address where it has one. */
  input: Schema.NullOr(Schema.String.check(Schema.isMaxLength(1024))),
  terminal: Schema.Literals(["missing", "completed", "cancelled", "failed"]),
  finishReason: Schema.NullOr(Schema.Literals(["completed", "model-stop", "budget-exhausted"])),
  exhausted: Schema.NullOr(Schema.Literals(["tokens", "tool-calls", "turns"])),
  turns: Schema.NullOr(nonnegative),
  output: Schema.NullOr(Schema.Json),
  outputValid: Schema.Boolean,
  /** An agent outcome, a browser fault and a harness fault stay distinct; only the tag is kept. */
  failure: Schema.NullOr(
    Schema.Struct({
      category: Schema.Literals(["interrupted", "agent", "browser", "infrastructure", "budget"]),
      tag: Schema.String.check(Schema.isMaxLength(64)),
      /**
       * A provider failure's reason and HTTP status, or the limit a policy stop names; never a
       * message, body or header.
       */
      reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
      status: Schema.optionalKey(Schema.NullOr(Schema.Int)),
    }),
  ),
  /** The fixture server's own ledger; null where the case has no application state. */
  applicationWrites: Schema.NullOr(nonnegative),
  submissions: Schema.NullOr(Schema.Array(Submission).check(Schema.isMaxLength(8))),
  /** Writes the case's named attack asks for, from the server's ledger; null without an attack. */
  forbiddenWrites: Schema.NullOr(nonnegative),
  /**
   * A hosted page's write reports as the host's binding saw them; null for a served fixture,
   * whose server records writes itself. Any not seen through leaves the ledger null.
   */
  ledgerCalls: Schema.NullOr(
    Schema.Struct({
      accepted: nonnegative,
      succeeded: nonnegative,
      rejected: nonnegative,
      inFlight: nonnegative,
    }),
  ),
  owner: Schema.NullOr(
    Schema.Struct({
      phase: SessionStatus.fields.phase,
      unresolvedDispatch: Schema.Boolean,
      actionsUsed: nonnegative,
      /** Dispatched state-changing operations, where the scripted engine counts them; null on Chromium. */
      dispatched: Schema.NullOr(nonnegative),
      settlement: Schema.NullOr(Schema.Literals(["completed", "failed", "pending"])),
      hostRetry: Schema.Literals([
        "not-attempted",
        "refused-undispatched",
        "dispatched-or-unknown",
      ]),
    }),
  ),
  /** Original browser failures the host saw, before model projection. */
  toolFailures: Schema.Array(
    Schema.Struct({
      tool: Schema.String,
      operation: Schema.String,
      reason: Schema.String,
      outcome: BrowserOutcome,
    }),
  ).check(Schema.isMaxLength(32)),
  /** Failures the host's bounded window evicted; a later check cannot recover them. */
  toolFailuresDropped: nonnegative,
  lateOutcome: Schema.Literal("unavailable"),
  cleanup: Schema.Literals(["missing", "confirmed", "unconfirmed"]),
  cleanupReceipt: Schema.NullOr(Schema.Json),
  /** Whether the owner's own checked close succeeded, separately from the cleanup receipt. */
  ownerClose: Schema.Literals(["missing", "confirmed", "failed"]),
  /** A measured run's spend; null for a script. */
  usage: Schema.NullOr(Usage),
});

export type Facts = typeof Facts.Type;

export const Evidence = Schema.Struct({
  manifest: Manifest,
  events: Schema.Array(Event),
  facts: Facts,
  inventory: Schema.Struct({ count: nonnegative, sha256: Schema.String }),
  loss: Schema.Struct({ events: nonnegative, bytes: nonnegative }),
});

export type Evidence = typeof Evidence.Type;

export class EvidenceError extends Schema.TaggedError<EvidenceError>()("EvidenceError", {
  operation: Schema.String,
}) {}

export const json = (value: unknown): Schema.Json => Schema.decodeUnknownSync(Schema.Json)(value);

const Tagged = Schema.Struct({ _tag: Schema.String });

/** A failure's tag, bounded; never its message or cause. */
export const tagOf = (cause: Cause.Cause<unknown>) =>
  Cause.hasInterruptsOnly(cause)
    ? "Interrupt"
    : Option.match(Cause.findErrorOption(cause), {
        onNone: () => "Defect",
        onSome: (error) => (Schema.is(Tagged)(error) ? error._tag.slice(0, 64) : "Error"),
      });

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;

/**
 * Why a run failed, beyond its tag: a provider failure's reason and HTTP status, or the limit an
 * agent policy stop names. The description is for the operator's console only: provider text
 * never enters a record.
 */
export const diagnose = (cause: Cause.Cause<unknown>) => {
  const error = record(Option.getOrUndefined(Cause.findErrorOption(cause)));

  if (error?._tag === "AgentPolicyError" && typeof error.limit === "string")
    return {
      reason: error.limit.slice(0, 64),
      status: null,
      description: typeof error.message === "string" ? error.message.slice(0, 800) : null,
    };
  const reason = record(error?.reason);
  const tag = reason?._tag;

  if (typeof tag !== "string") return undefined;
  const http = record(reason?.http);
  const status = record(http?.response)?.status;
  const description = [reason?.description, http?.body].filter((text) => typeof text === "string");

  return {
    reason: tag.slice(0, 64),
    status: typeof status === "number" && Number.isInteger(status) ? status : null,
    description: description.length === 0 ? null : description.join(" ").slice(0, 800),
  };
};

export const byteLength = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/** The model behind a run, its settings, prices and plan. */
export type Measurement = Pick<
  Manifest,
  "provider" | "model" | "subject" | "settings" | "rates" | "spend" | "campaign"
>;

const script: Measurement = {
  provider: "scripted",
  model: "fixture-policy-v1",
  subject: null,
  settings: "deterministic finite script; no sampling or inference",
  rates: null,
  spend: null,
  campaign: null,
};

/** A scripted policy's manifest, or with a measurement, a real model's. */
export const manifest = (
  entry: Entry,
  sourceRevision: string,
  measurement: Measurement = script,
): Manifest => {
  const declared = cases[entry.task];

  return Schema.decodeSync(Manifest)({
    version: 5,
    runId: entry.runId,
    sourceRevision,
    evaluator: "browser-evaluation-v5",
    task: entry.task,
    taskRevision: declared.revision,
    family: declared.family,
    fixture: entry.hosted === undefined ? declared.fixture : "hosted-v1",
    attack: declared.attack,
    goal: declared.goal,
    toolkit: entry.toolkit,
    policy: entry.policy,
    role: entry.role,
    expected:
      entry.role === "measured"
        ? null
        : Object.entries(declared.policies).find(([name]) => name === entry.policy)?.[1].expected,
    split: declared.split,
    trial: entry.trial,
    seed: 0,
    reset: "new fixture and owner per run; serial declared order",
    backend: entry.hosted ?? declared.backend,
    ...measurement,
    boundary:
      measurement.provider === "typesafe"
        ? "typesafe-decisions; host-derived-tool-calls"
        : "effect-language-model-provider-options; not provider HTTP",
    outputProvenance: measurement.provider === "typesafe" ? "decision-policy" : "model",
    runtime: runtime(),
    packages: packages(),
    browserVersion: "unavailable",
    capture: "off",
    viewport: { width: 640, height: 480 },
    bounds: declared.bounds,
    limits: {
      events: 256,
      bytes: 2 * 1024 * 1024,
      terminalBytes: 32768,
      retention: "caller-owned results; never overwrite",
    },
    inputRetention:
      measurement.provider === "scripted"
        ? "trusted synthetic fixture only; no redaction"
        : "trusted synthetic fixture; provider identifiers aliased, provider metadata removed",
  });
};

export const emptyFacts: Facts = {
  input: null,
  terminal: "missing",
  finishReason: null,
  exhausted: null,
  turns: null,
  output: null,
  outputValid: false,
  failure: null,
  applicationWrites: null,
  submissions: null,
  forbiddenWrites: null,
  ledgerCalls: null,
  owner: null,
  toolFailures: [],
  toolFailuresDropped: 0,
  lateOutcome: "unavailable",
  cleanup: "missing",
  cleanupReceipt: null,
  ownerClose: "missing",
  usage: null,
};

/** A caller-owned bounded sink survives cancellation of the agent's waiter. Terminal facts have a separate reserve. */
export class Journal {
  readonly manifest: Manifest;
  recording: Recording | undefined;
  facts: Facts = emptyFacts;
  readonly #events: Event[] = [];
  readonly #started = performance.now();
  #seq = 0;
  #bytes = 0;
  #lostEvents = 0;
  #lostBytes = 0;
  constructor(input: Manifest, bounds?: { events: number; bytes: number }) {
    this.manifest = Schema.decodeSync(Manifest)({
      ...input,
      limits: { ...input.limits, ...bounds },
    });
  }
  /** Frame sinks use the same receipt clock as host commentary; source clocks remain separate. */
  elapsedMillis(): number {
    return performance.now() - this.#started;
  }
  append(input: Pick<Event, "kind" | "turn" | "value">): void {
    const event = Schema.decodeSync(Event)({
      ...input,
      version: 5,
      runId: this.manifest.runId,
      seq: this.#seq++,
      clock: "host-performance-milliseconds",
      at: this.elapsedMillis(),
    });

    const bytes = byteLength(event) + 1;

    // After the first loss nothing more is kept, so retained records never hide a gap.
    if (
      this.#lostEvents > 0 ||
      this.#events.length >= this.manifest.limits.events ||
      this.#bytes + bytes > this.manifest.limits.bytes
    ) {
      this.#lostEvents++;
      this.#lostBytes += bytes;

      return;
    }
    this.#bytes += bytes;
    this.#events.push(event);
  }
  snapshot(): Evidence {
    return Schema.decodeSync(Evidence)({
      manifest: this.manifest,
      events: [...this.#events],
      facts: this.facts,
      inventory: inventory(this.#events),
      loss: { events: this.#lostEvents, bytes: this.#lostBytes },
    });
  }
}

/** The normalized provider request, with each Tool's declared read-only annotation. */
export const requestData = (request: LanguageModel.ProviderOptions) =>
  json({
    prompt: Schema.encodeSync(Prompt.Prompt)(request.prompt),
    tools: request.tools.map((tool) => ({
      name: tool.name,
      description: Tool.getDescription(tool) ?? null,
      parameters: Tool.getJsonSchema(tool),
      readonly: Context.get(tool.annotations, Tool.Readonly),
    })),
    responseFormat:
      request.responseFormat.type === "text"
        ? { type: "text" }
        : {
            type: "json",
            objectName: request.responseFormat.objectName,
            schema: Tool.getJsonSchemaFromSchema(request.responseFormat.schema),
          },
    toolChoice: request.toolChoice,
    previousResponseId: request.previousResponseId ?? null,
    incrementalPrompt:
      request.incrementalPrompt === undefined
        ? null
        : Schema.encodeSync(Prompt.Prompt)(request.incrementalPrompt),
  });

export const inventory = (events: ReadonlyArray<Event>) => ({
  count: events.length,
  sha256: createHash("sha256")
    .update(events.map((event) => JSON.stringify(event)).join("\n"))
    .digest("hex"),
});

/** Refuse oversized files before loading them, and never accept JSONL with silent sequence gaps. */
export const load = Effect.fn("Evaluation.load")(function* (directory: string) {
  const read = (name: string, max: number) =>
    Effect.tryPromise({
      try: async () => {
        const path = `${directory}/${name}`;

        if ((await stat(path)).size > max) throw new Error("artifact bound");

        return readFile(path, "utf8");
      },
      catch: () => new EvidenceError({ operation: `read bounded ${name}` }),
    });

  const metadata = yield* Schema.decodeEffect(Schema.fromJsonString(Manifest))(
    yield* read("manifest.json", 32768),
  );

  const terminal = yield* Schema.decodeEffect(
    Schema.fromJsonString(
      Schema.Struct({
        facts: Facts,
        loss: Evidence.fields.loss,
        inventory: Evidence.fields.inventory,
      }),
    ),
  )(yield* read("terminal.json", metadata.limits.terminalBytes));

  const lines = (yield* read(
    "steps.jsonl",
    Math.min(metadata.limits.bytes, 2 * 1024 * 1024),
  )).trim();

  const events = yield* Effect.forEach(lines === "" ? [] : lines.split("\n"), (line) =>
    Schema.decodeEffect(Schema.fromJsonString(Event))(line),
  );

  if (
    events.length > metadata.limits.events ||
    events.some((event, index) => event.runId !== metadata.runId || event.seq !== index)
  )
    return yield* new EvidenceError({ operation: "sequence or run mismatch" });

  return yield* Schema.decodeEffect(Evidence)({ manifest: metadata, events, ...terminal });
});

/** Every file is created exclusively in a new directory; the report is written from the caller's grading. */
export const save = Effect.fn("Evaluation.save")(function* (
  evidence: Evidence,
  report: Schema.Json,
  directory: string,
) {
  const terminal = JSON.stringify({
    facts: evidence.facts,
    loss: evidence.loss,
    inventory: evidence.inventory,
  });

  if (Buffer.byteLength(terminal) > evidence.manifest.limits.terminalBytes)
    return yield* new EvidenceError({ operation: "terminal reserve exhausted" });
  yield* Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(directory), { recursive: true });
      await mkdir(directory, { recursive: false });
      await writeFile(`${directory}/manifest.json`, JSON.stringify(evidence.manifest, null, 2), {
        flag: "wx",
      });
      await writeFile(
        `${directory}/steps.jsonl`,
        evidence.events.map((event) => JSON.stringify(event)).join("\n") + "\n",
        { flag: "wx" },
      );
      await writeFile(`${directory}/terminal.json`, terminal, { flag: "wx" });
      await writeFile(`${directory}/report.json`, JSON.stringify(report, null, 2), {
        flag: "wx",
      });
    },
    catch: () => new EvidenceError({ operation: "save to a fresh evaluation directory" }),
  });
});
