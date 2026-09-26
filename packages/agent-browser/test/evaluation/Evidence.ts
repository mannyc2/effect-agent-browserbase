import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { Cause, Context, Effect, Option, Schema } from "effect";
import { SessionStatus } from "effect-browser/browser-data";
import { BrowserOutcome } from "effect-browser/errors";
import { Prompt, Tool, type LanguageModel } from "effect/unstable/ai";

import {
  Composition,
  Expectation,
  Role,
  Task,
  cases,
  packages,
  runtime,
  type Entry,
} from "./Cases.ts";

const nonnegative = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const Manifest = Schema.Struct({
  version: Schema.Literal(2),
  runId: Schema.String,
  sourceRevision: Schema.String,
  evaluator: Schema.Literal("browser-evaluation-v2"),
  task: Task,
  family: Schema.Literals(["form-submission", "uncertain-mutation", "reading"]),
  fixture: Schema.Literals(["tool-site-v2", "scripted-document-v1"]),
  goal: Schema.String,
  toolkit: Composition,
  policy: Schema.String,
  role: Role,
  expected: Expectation,
  split: Schema.Literal("tuning"),
  trial: nonnegative,
  seed: Schema.Literal(0),
  reset: Schema.Literal("new fixture and owner per run; serial declared order"),
  backend: Schema.Literals(["chromium", "scripted-owner"]),
  provider: Schema.Literal("scripted"),
  model: Schema.Literal("fixture-policy-v1"),
  boundary: Schema.Literal("effect-language-model-provider-options; not provider HTTP"),
  settings: Schema.Literal("deterministic finite script; no sampling or inference"),
  runtime: Schema.Struct({ name: Schema.Literals(["node", "bun"]), version: Schema.String }),
  packages: Schema.Struct({
    effect: Schema.String,
    effectAgent: Schema.String,
    effectBrowser: Schema.String,
    effectAgentBrowser: Schema.String,
    playwrightCore: Schema.String,
  }),
  browserVersion: Schema.Literal("unavailable"),
  capture: Schema.Literal("off"),
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
  inputRetention: Schema.Literal("trusted synthetic fixture only; no redaction"),
});

export type Manifest = typeof Manifest.Type;

export const Event = Schema.Struct({
  version: Schema.Literal(2),
  runId: Schema.String,
  seq: nonnegative,
  clock: Schema.Literal("host-performance-milliseconds"),
  at: Schema.Finite,
  kind: Schema.Literals(["request", "response", "history", "host"]),
  turn: Schema.NullOr(nonnegative),
  value: Schema.Json,
});

export type Event = typeof Event.Type;

const Submission = Schema.Struct({
  email: Schema.String,
  plan: Schema.String,
  terms: Schema.Boolean,
});

/** Host facts, never model-visible. Bounded projections only: no causes, handles or messages. */
export const Facts = Schema.Struct({
  terminal: Schema.Literals(["missing", "completed", "cancelled", "failed"]),
  finishReason: Schema.NullOr(Schema.Literals(["completed", "model-stop", "budget-exhausted"])),
  exhausted: Schema.NullOr(Schema.Literals(["tokens", "tool-calls", "turns"])),
  turns: Schema.NullOr(nonnegative),
  output: Schema.NullOr(Schema.Json),
  outputValid: Schema.Boolean,
  /** An agent outcome, a browser fault and a harness fault stay distinct; only the tag is kept. */
  failure: Schema.NullOr(
    Schema.Struct({
      category: Schema.Literals(["interrupted", "agent", "browser", "infrastructure"]),
      tag: Schema.String.check(Schema.isMaxLength(64)),
    }),
  ),
  /** The fixture server's own ledger; null where the case has no application state. */
  applicationWrites: Schema.NullOr(nonnegative),
  submissions: Schema.NullOr(Schema.Array(Submission).check(Schema.isMaxLength(8))),
  owner: Schema.NullOr(
    Schema.Struct({
      phase: SessionStatus.fields.phase,
      unresolvedDispatch: Schema.Boolean,
      actionsUsed: nonnegative,
      /** Dispatched operations, where the scripted engine can count them; null on Chromium. */
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
  lateOutcome: Schema.Literal("unavailable"),
  cleanup: Schema.Literals(["missing", "confirmed", "unconfirmed"]),
  cleanupReceipt: Schema.NullOr(Schema.Json),
  /** Whether the owner's own checked close succeeded, separately from the cleanup receipt. */
  ownerClose: Schema.Literals(["missing", "confirmed", "failed"]),
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

export const byteLength = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

export const manifest = (entry: Entry, sourceRevision: string): Manifest => {
  const declared = cases[entry.task];

  return Schema.decodeSync(Manifest)({
    version: 2,
    runId: entry.runId,
    sourceRevision,
    evaluator: "browser-evaluation-v2",
    task: entry.task,
    family: declared.family,
    fixture: declared.fixture,
    goal: declared.goal,
    toolkit: entry.toolkit,
    policy: entry.policy,
    role: entry.role,
    expected: Object.entries(declared.policies).find(([name]) => name === entry.policy)?.[1]
      .expected,
    split: "tuning",
    trial: entry.trial,
    seed: 0,
    reset: "new fixture and owner per run; serial declared order",
    backend: declared.backend,
    provider: "scripted",
    model: "fixture-policy-v1",
    boundary: "effect-language-model-provider-options; not provider HTTP",
    settings: "deterministic finite script; no sampling or inference",
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
    inputRetention: "trusted synthetic fixture only; no redaction",
  });
};

export const emptyFacts: Facts = {
  terminal: "missing",
  finishReason: null,
  exhausted: null,
  turns: null,
  output: null,
  outputValid: false,
  failure: null,
  applicationWrites: null,
  submissions: null,
  owner: null,
  toolFailures: [],
  lateOutcome: "unavailable",
  cleanup: "missing",
  cleanupReceipt: null,
  ownerClose: "missing",
};

/** A caller-owned bounded sink survives cancellation of the agent's waiter. Terminal facts have a separate reserve. */
export class Journal {
  readonly manifest: Manifest;
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
  append(input: Pick<Event, "kind" | "turn" | "value">): void {
    const event = Schema.decodeSync(Event)({
      ...input,
      version: 2,
      runId: this.manifest.runId,
      seq: this.#seq++,
      clock: "host-performance-milliseconds",
      at: performance.now() - this.#started,
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
