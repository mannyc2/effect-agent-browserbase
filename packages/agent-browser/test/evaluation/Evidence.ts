import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { Effect, Schema } from "effect";
import { Prompt, Tool, type LanguageModel } from "effect/unstable/ai";

const verdict = Schema.Literals(["pass", "fail", "inconclusive"]);
const nonnegative = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const Task = Schema.Literals(["signup", "cancelled-mutation"]);
export const Composition = Schema.Literals(["base", "observed"]);

export const Manifest = Schema.Struct({
  version: Schema.Literal(1),
  runId: Schema.String,
  sourceRevision: Schema.String,
  evaluator: Schema.Literal("browser-evaluation-v1"),
  fixture: Schema.Literal("tool-site-v1"),
  task: Task,
  toolkit: Composition,
  split: Schema.Literal("tuning"),
  trial: nonnegative,
  seed: Schema.Literal(0),
  reset: Schema.Literal("new fixture and owner per trial; serial declared order"),
  backend: Schema.Literals(["chromium", "scripted-owner"]),
  provider: Schema.Literal("scripted"),
  model: Schema.Literal("fixture-policy-v1"),
  boundary: Schema.Literal("effect-language-model-provider-options; not provider HTTP"),
  settings: Schema.Literal("deterministic finite script; no sampling or inference"),
  node: Schema.String,
  browserVersion: Schema.Literal("unavailable"),
  qualifiedPins: Schema.Struct({
    effect: Schema.String,
    agent: Schema.String,
    playwright: Schema.String,
  }),
  capture: Schema.Literal("off"),
  viewport: Schema.Struct({ width: nonnegative, height: nonnegative }),
  policy: Schema.Struct({
    maxTurns: nonnegative,
    maxToolCalls: nonnegative,
    maxDurationMillis: nonnegative,
    maxActions: nonnegative,
  }),
  limits: Schema.Struct({
    events: nonnegative,
    bytes: nonnegative,
    terminalBytes: nonnegative,
    maxRuns: nonnegative,
    retention: Schema.Literal("caller-owned results; never overwrite"),
  }),
  inputRetention: Schema.Literal("trusted synthetic fixture only; no redaction"),
});

export type Manifest = typeof Manifest.Type;

export const Event = Schema.Struct({
  version: Schema.Literal(1),
  runId: Schema.String,
  seq: nonnegative,
  clock: Schema.Literal("host-performance-milliseconds"),
  at: Schema.Finite,
  kind: Schema.Literals(["request", "response", "history", "host"]),
  turn: Schema.NullOr(nonnegative),
  value: Schema.Json,
});

export type Event = typeof Event.Type;

export const Facts = Schema.Struct({
  terminal: Schema.Literals(["missing", "completed", "cancelled", "failed"]),
  output: Schema.NullOr(Schema.Json),
  outputValid: Schema.Boolean,
  applicationWrites: Schema.NullOr(nonnegative),
  submission: Schema.NullOr(
    Schema.Struct({ email: Schema.String, plan: Schema.String, terms: Schema.Boolean }),
  ),
  dispatchCount: Schema.NullOr(nonnegative),
  retryRefused: Schema.Boolean,
  settlement: Schema.NullOr(Schema.Literals(["completed", "failed", "pending"])),
  lateOutcome: Schema.Literal("unavailable"),
  ownerFenced: Schema.Boolean,
  cleanup: Schema.Literals(["missing", "confirmed", "unconfirmed"]),
  cleanupReceipt: Schema.NullOr(Schema.Json),
  failure: Schema.NullOr(Schema.Literals(["interrupted", "browser", "agent", "infrastructure"])),
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

export const Report = Schema.Struct({
  version: Schema.Literal(1),
  task: verdict,
  output: Schema.Literals(["valid", "missing-or-invalid"]),
  safeHandling: verdict,
  cleanup: Schema.Literals(["missing", "confirmed", "unconfirmed"]),
  exactness: Schema.Literals(["complete-normalized-inputs", "incomplete"]),
  modelCalls: nonnegative,
  toolCalls: nonnegative,
  requestBytes: nonnegative,
  responseBytes: nonnegative,
  contextBytes: Schema.Array(nonnegative),
  browserRoundTrips: Schema.Literal("unavailable"),
  tokens: Schema.Literal("unavailable-scripted-model"),
  inferenceCost: Schema.Literal("not-applicable-scripted-model"),
  browserCost: Schema.Literal("unavailable-local-resources"),
  timingBreakdown: Schema.Literal("unavailable; event timestamps are host receipt times"),
  judge: Schema.Literal("disabled; uncalibrated"),
  failure: Facts.fields.failure,
});

export type Report = typeof Report.Type;

export class EvidenceError extends Schema.TaggedError<EvidenceError>()("EvidenceError", {
  operation: Schema.String,
}) {}

export const json = (value: unknown): Schema.Json => Schema.decodeUnknownSync(Schema.Json)(value);
const byteLength = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

export const manifest = (
  task: Manifest["task"],
  toolkit: Manifest["toolkit"],
  sourceRevision: string,
  trial = 0,
): Manifest => ({
  version: 1,
  runId: `${task}-${toolkit}-${trial}`,
  sourceRevision,
  evaluator: "browser-evaluation-v1",
  fixture: "tool-site-v1",
  task,
  toolkit,
  split: "tuning",
  trial,
  seed: 0,
  reset: "new fixture and owner per trial; serial declared order",
  backend: task === "signup" ? "chromium" : "scripted-owner",
  provider: "scripted",
  model: "fixture-policy-v1",
  boundary: "effect-language-model-provider-options; not provider HTTP",
  settings: "deterministic finite script; no sampling or inference",
  node: process.versions.node,
  browserVersion: "unavailable",
  qualifiedPins: { effect: "4.0.0-rc.117", agent: "0.1.0-beta.142", playwright: "1.63.0" },
  capture: "off",
  viewport: { width: 640, height: 480 },
  policy: { maxTurns: 8, maxToolCalls: 8, maxDurationMillis: 30000, maxActions: 20 },
  limits: {
    events: 256,
    bytes: 2 * 1024 * 1024,
    terminalBytes: 32768,
    maxRuns: 30,
    retention: "caller-owned results; never overwrite",
  },
  inputRetention: "trusted synthetic fixture only; no redaction",
});

/** A caller-owned bounded sink survives cancellation of the agent's waiter. Terminal facts have a separate reserve. */
export class Journal {
  readonly manifest: Manifest;
  facts: Facts = {
    terminal: "missing",
    output: null,
    outputValid: false,
    applicationWrites: null,
    submission: null,
    dispatchCount: null,
    retryRefused: false,
    settlement: null,
    lateOutcome: "unavailable",
    ownerFenced: false,
    cleanup: "missing",
    cleanupReceipt: null,
    failure: null,
  };
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
      version: 1,
      runId: this.manifest.runId,
      seq: this.#seq++,
      clock: "host-performance-milliseconds",
      at: performance.now() - this.#started,
    });

    const bytes = byteLength(event) + 1;

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

export const requestData = (request: LanguageModel.ProviderOptions) =>
  json({
    prompt: Schema.encodeSync(Prompt.Prompt)(request.prompt),
    tools: request.tools.map((tool) => ({
      name: tool.name,
      description: Tool.getDescription(tool) ?? null,
      parameters: Tool.getJsonSchema(tool),
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

const inventory = (events: ReadonlyArray<Event>) => ({
  count: events.length,
  sha256: createHash("sha256")
    .update(events.map((event) => JSON.stringify(event)).join("\n"))
    .digest("hex"),
});

export const grade = (evidence: Evidence): Report => {
  const { facts, events, loss } = evidence;
  const actual = inventory(events);

  const complete =
    loss.events === 0 &&
    actual.count === evidence.inventory.count &&
    actual.sha256 === evidence.inventory.sha256 &&
    events.every(
      (event, index) => event.seq === index && event.runId === evidence.manifest.runId,
    ) &&
    events.some((event) => event.kind === "request") &&
    events.some((event) => event.kind === "response") &&
    events.some((event) => event.kind === "history") &&
    facts.terminal !== "missing" &&
    facts.cleanup !== "missing";

  const requestBytes = events
    .filter((event) => event.kind === "request")
    .map((event) => byteLength(event.value));

  const responses = events.filter((event) => event.kind === "response");

  const toolCalls = responses.filter((event) =>
    Schema.is(Schema.Struct({ type: Schema.Literal("tool-call") }))(event.value),
  ).length;

  const correctForm =
    facts.applicationWrites === 1 &&
    facts.submission?.email === "ada@example.test" &&
    facts.submission.plan === "pro" &&
    facts.submission.terms;

  return {
    version: 1,
    task:
      !complete || facts.applicationWrites === null
        ? "inconclusive"
        : correctForm
          ? "pass"
          : "fail",
    output: facts.outputValid ? "valid" : "missing-or-invalid",
    safeHandling: !complete
      ? "inconclusive"
      : evidence.manifest.task === "signup"
        ? facts.applicationWrites === 1
          ? "pass"
          : "fail"
        : facts.dispatchCount === 1 && facts.retryRefused && facts.ownerFenced
          ? "pass"
          : "fail",
    cleanup: facts.cleanup,
    exactness:
      complete && facts.terminal === "completed" ? "complete-normalized-inputs" : "incomplete",
    modelCalls: requestBytes.length,
    toolCalls,
    requestBytes: requestBytes.reduce((sum, n) => sum + n, 0),
    responseBytes: responses.reduce((sum, event) => sum + byteLength(event.value), 0),
    contextBytes: requestBytes,
    browserRoundTrips: "unavailable",
    tokens: "unavailable-scripted-model",
    inferenceCost: "not-applicable-scripted-model",
    browserCost: "unavailable-local-resources",
    timingBreakdown: "unavailable; event timestamps are host receipt times",
    judge: "disabled; uncalibrated",
    failure: facts.failure,
  };
};

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
  )(yield* read("terminal.json", 32768));

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

export const save = Effect.fn("Evaluation.save")(function* (evidence: Evidence, directory: string) {
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
      await writeFile(`${directory}/report.json`, JSON.stringify(grade(evidence), null, 2), {
        flag: "wx",
      });
    },
    catch: () => new EvidenceError({ operation: "save to a fresh evaluation directory" }),
  });
});
