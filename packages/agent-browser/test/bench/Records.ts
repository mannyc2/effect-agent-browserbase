import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { Cause, Context, Effect, Option, Predicate, Schema } from "effect";
import { Prompt, Tool, type LanguageModel } from "effect/unstable/ai";

export class BenchError extends Schema.TaggedError<BenchError>()("BenchError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export const json = (value: unknown): Schema.Json =>
  Schema.decodeUnknownSync(Schema.Json)(structuredClone(value));

export const byteLength = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const Tagged = Schema.Struct({ _tag: Schema.String });

export const tagOf = (cause: Cause.Cause<unknown>) =>
  Cause.hasInterruptsOnly(cause)
    ? "Interrupt"
    : Option.match(Cause.findErrorOption(cause), {
        onNone: () => "Defect",
        onSome: (error) => (Schema.is(Tagged)(error) ? error._tag.slice(0, 64) : "Error"),
      });

export const diagnose = (cause: Cause.Cause<unknown>) => {
  const error = Option.getOrUndefined(Cause.findErrorOption(cause));

  if (!Predicate.isObject(error)) return undefined;
  const reason = "reason" in error && Predicate.isObject(error.reason) ? error.reason : error;

  if (!("_tag" in reason) || !Predicate.isString(reason._tag)) return undefined;

  return { reason: reason._tag.slice(0, 64) };
};

const natural = Schema.Natural;

export const Usage = Schema.Struct({
  admitted: natural,
  settled: natural,
  refused: Schema.NullOr(
    Schema.Literals(["run-budget", "invocation-budget", "concurrent", "missing-usage"]),
  ),
  inputTokens: natural,
  cacheReadInputTokens: natural,
  cacheWriteInputTokens: natural,
  outputTokens: natural,
  reasoningTokens: natural,
  costMicrousd: natural,
  limitMicrousd: natural,
  overshootMicrousd: natural,
  status: Schema.Literals(["no-calls", "estimated-from-reported-usage", "usage-unavailable"]),
});

export type Usage = typeof Usage.Type;

export const Subject = Schema.Struct({
  provider: Schema.Literals(["openai", "anthropic"]),
  model: Schema.NonEmptyString,
  settings: Schema.Struct({
    gateway: Schema.Literals(["direct", "openrouter"]),
    maxOutputTokens: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32768 })),
    reasoningEffort: Schema.NullOr(Schema.Literals(["none", "minimal", "low", "medium", "high"])),
    serviceTier: Schema.NullOr(Schema.Literals(["default", "standard_only"])),
  }),
  rates: Schema.Struct({
    input: natural,
    cacheRead: natural,
    cacheWrite: natural,
    output: natural,
    source: Schema.NonEmptyString,
    retrieved: Schema.NonEmptyString,
  }),
});

export type Subject = typeof Subject.Type;

export const CaptureProfile = Schema.Struct({
  maxFrames: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 36000 })),
  maxBytes: Schema.Int.check(Schema.isBetween({ minimum: 1024, maximum: 512 * 1024 * 1024 })),
  quality: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
  maxDurationMillis: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 900000 })),
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

export interface Recording extends CaptureProfile {
  readonly frames: RecordingFrame[];
  readonly startedAt: number;
  endedAt: number;
  nativeStop: "missing" | "confirmed" | "unconfirmed";
  summary: Schema.Json | null;
  totalBytes: number;
  discardedFrames: number;
  limitReached: "frames" | "bytes" | null;
  error: string | null;
}

export const Event = Schema.Struct({
  seq: natural,
  at: Schema.Finite,
  kind: Schema.Literals(["request", "response", "history", "host", "truth"]),
  turn: Schema.NullOr(natural),
  value: Schema.Json,
});

export type Event = typeof Event.Type;

export const Manifest = Schema.Struct({
  version: Schema.Literal(1),
  runId: Schema.NonEmptyString,
  scene: Schema.NonEmptyString,
  backend: Schema.Literals(["chromium", "browserbase"]),
  driver: Schema.NonEmptyString,
  sourceRevision: Schema.String,
  sourceDirty: Schema.Boolean,
  trial: natural,
  seed: Schema.Int,
  viewport: Schema.Struct({ width: Schema.Natural, height: Schema.Natural }),
  settings: Schema.Json,
  capture: CaptureProfile,
});

export type Manifest = typeof Manifest.Type;

export const Record = Schema.Struct({
  manifest: Manifest,
  events: Schema.Array(Event),
  truth: Schema.Json,
  metrics: Schema.Json,
  usage: Schema.NullOr(Usage),
  cleanup: Schema.Literals(["missing", "confirmed", "unconfirmed"]),
  cleanupReceipt: Schema.NullOr(Schema.Json),
  ownerClose: Schema.Literals(["missing", "confirmed", "failed"]),
  failure: Schema.NullOr(Schema.String),
  loss: Schema.Struct({ events: natural, bytes: natural }),
  capture: Schema.NullOr(Schema.Json),
});

export type Record = typeof Record.Type;

export class Journal {
  readonly manifest: Manifest;
  recording: Recording | undefined;
  truth: Schema.Json = null;
  metrics: Schema.Json = null;
  usage: Usage | null = null;
  cleanup: Record["cleanup"] = "missing";
  cleanupReceipt: Schema.Json | null = null;
  ownerClose: Record["ownerClose"] = "missing";
  failure: string | null = null;
  readonly #events: Event[] = [];
  readonly #started = performance.now();
  #bytes = 0;
  #lostEvents = 0;
  #lostBytes = 0;
  constructor(
    manifest: Manifest,
    readonly bounds = { events: 4096, bytes: 8 * 1024 * 1024 },
  ) {
    this.manifest = Schema.decodeSync(Manifest)(manifest);
  }
  elapsedMillis(): number {
    return performance.now() - this.#started;
  }
  append(input: Pick<Event, "kind" | "turn" | "value">): void {
    const event = Schema.decodeSync(Event)({
      ...input,
      seq: this.#events.length + this.#lostEvents,
      at: this.elapsedMillis(),
    });

    const bytes = byteLength(event);

    if (
      this.#lostEvents > 0 ||
      this.#events.length >= this.bounds.events ||
      this.#bytes + bytes > this.bounds.bytes
    ) {
      this.#lostEvents++;
      this.#lostBytes += bytes;

      return;
    }
    this.#bytes += bytes;
    this.#events.push(event);
  }
  snapshot(): Record {
    const recording = this.recording;

    return Schema.decodeSync(Record)({
      manifest: this.manifest,
      events: [...this.#events],
      truth: this.truth,
      metrics: this.metrics,
      usage: this.usage,
      cleanup: this.cleanup,
      cleanupReceipt: this.cleanupReceipt,
      ownerClose: this.ownerClose,
      failure: this.failure,
      loss: { events: this.#lostEvents, bytes: this.#lostBytes },
      capture:
        recording === undefined
          ? null
          : json({
              startedAt: recording.startedAt,
              endedAt: recording.endedAt,
              nativeStop: recording.nativeStop,
              summary: recording.summary,
              totalBytes: recording.totalBytes,
              discardedFrames: recording.discardedFrames,
              limitReached: recording.limitReached,
              error: recording.error,
              framesDir: "frames",
              frames: recording.frames.map(({ bytes, ...frame }, index) => ({
                ...frame,
                path: `frames/frame-${String(index).padStart(6, "0")}.jpg`,
                byteLength: bytes.byteLength,
              })),
            }),
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

export const save = Effect.fn("Bench.save")(function* (journal: Journal, directory: string) {
  yield* Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(directory), { recursive: true });
      await mkdir(directory);
      const frames = journal.recording?.frames ?? [];

      if (frames.length > 0) await mkdir(join(directory, "frames"));
      for (const [index, frame] of frames.entries())
        await writeFile(
          join(directory, `frames/frame-${String(index).padStart(6, "0")}.jpg`),
          frame.bytes,
          { flag: "wx" },
        );
      await writeFile(join(directory, "record.json"), JSON.stringify(journal.snapshot(), null, 2), {
        flag: "wx",
      });
    },
    catch: () =>
      new BenchError({ operation: "save", message: "Run records need a new output directory." }),
  });
});

export const load = Effect.fn("Bench.load")(function* (directory: string) {
  const text = yield* Effect.tryPromise({
    try: async () => {
      const path = join(directory, "record.json");

      if ((await stat(path)).size > 12 * 1024 * 1024) throw new Error("Record bound exceeded");

      return readFile(path, "utf8");
    },
    catch: () => new BenchError({ operation: "load", message: "Cannot read bounded run record." }),
  });

  return yield* Schema.decodeEffect(Schema.fromJsonString(Record))(text);
});
