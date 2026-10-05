// One isolated process owns one trial. Neither its private configuration nor native stderr is saved.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { Effect, Option, Schema } from "effect";

import * as Diagnostics from "./Diagnostics.ts";
import * as Native from "./Native.ts";
import * as Perception from "./Perception.ts";
import * as Protocol from "./Protocol.ts";

const Count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const Millis = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));

export const Config = Schema.Struct({
  task: Text,
  arm: Schema.Literals([1, 2, 3, 4, 5, 6]),
  seed: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 0xffffffff })),
  provider: Schema.Literals(["local", "browserbase"]),
  apiUrl: Schema.String.check(
    Schema.isPattern(/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/[a-f0-9]{48}$/),
  ),
  model: Text,
  reasoning: Schema.Literals(["none", "minimal", "low", "medium", "high", "xhigh", "max"]),
  maxOutputTokens: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32_768 })),
  endpoint: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8192))),
  perceptionOrigin: Schema.NullOr(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  ),
  scripted: Schema.Boolean,
});

export type Config = typeof Config.Type;

export const Code = Schema.Union([
  Schema.Literals([
    "InvalidConfig",
    "UnknownTask",
    "Browser",
    "Agent",
    "Model",
    "Defect",
    "Other",
    "CaptureIncomplete",
    "Interrupted",
    "Timeout",
    "Spawn",
    "Exit",
    "Output",
    "Cleanup",
  ]),
  Native.Code,
  Perception.Failure,
]);

export type Code = typeof Code.Type;

export const Usage = Schema.Struct({
  inputTokens: Count,
  outputTokens: Count,
  cachedInputTokens: Count,
});

export const Result = Schema.Struct({
  status: Schema.Literals(["completed", "failed", "cancelled", "timed-out"]),
  pass: Schema.Boolean,
  steps: Count,
  code: Schema.NullOr(Code),
  diagnostic: Schema.NullOr(Diagnostics.Failure),
  usage: Schema.NullOr(Usage),
  timings: Schema.Struct({
    prepareMillis: Millis,
    runMillis: Millis,
    gradeMillis: Millis,
    totalMillis: Millis,
  }),
  phaseMarks: Schema.Struct({
    prepare: Schema.NullOr(Millis),
    run: Schema.NullOr(Millis),
    grade: Schema.NullOr(Millis),
  }),
  perception: Schema.Struct({
    parseCalls: Count,
    groundCalls: Count,
    millis: Millis,
    failures: Count,
  }),
  actions: Schema.NullOr(Count),
  actionMeasurement: Schema.Literals(["guard-approved-attempts", "unmeasured"]),
});

export type Result = typeof Result.Type;

export interface Execution {
  readonly result: Result;
  readonly protocol: Protocol.Snapshot;
  readonly process: {
    readonly exitCode: number | null;
    readonly signal: "SIGTERM" | "SIGKILL" | "Other" | null;
    readonly forced: boolean;
  };
}

export interface Options {
  readonly timeoutMillis?: number;
}

export class WorkerError extends Schema.TaggedError<WorkerError>()("WorkerError", {
  code: Schema.Literals(["InvalidConfig", "Spawn"]),
}) {}

export const failed = (code: Code, totalMillis = 0): Result => ({
  status: code === "Interrupted" ? "cancelled" : code === "Timeout" ? "timed-out" : "failed",
  pass: false,
  steps: 0,
  code,
  diagnostic: null,
  usage: null,
  timings: { prepareMillis: 0, runMillis: 0, gradeMillis: 0, totalMillis },
  phaseMarks: { prepare: null, run: null, grade: null },
  perception: { parseCalls: 0, groundCalls: 0, millis: 0, failures: 0 },
  actions: null,
  actionMeasurement: "unmeasured",
});

/** An allowlist also removes future provider keys, proxy credentials and executable preload hooks. */
export const environment = (source: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const safe: NodeJS.ProcessEnv = {};

  for (const key of [
    "PATH",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "XDG_CACHE_HOME",
    "PLAYWRIGHT_BROWSERS_PATH",
  ]) {
    if (source[key] !== undefined) safe[key] = source[key];
  }

  return { ...safe, ...Protocol.environment };
};

const maximumOutputBytes = 32 * 1024;

const decodeResult = Schema.decodeUnknownOption(Schema.fromJsonString(Result), {
  onExcessProperty: "error",
});

const root = fileURLToPath(new URL("..", import.meta.url));
const entry = fileURLToPath(new URL("./worker-main.ts", import.meta.url));

const start = (config: Config, timeoutMillis: number) => {
  const startedAt = performance.now();
  const sink = Protocol.make();

  const child = spawn(process.execPath, ["--conditions=@effect-browser/source", entry], {
    cwd: root,
    detached: true,
    env: environment(process.env),
    stdio: ["pipe", "pipe", "pipe"],
  });

  let closed = false;
  let forced = false;
  let stopCode: "Interrupted" | "Timeout" | "Output" | undefined;
  let outputBytes = 0;
  const output: Array<Uint8Array> = [];
  let spawnFailed = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let resolveDone: ((result: Execution) => void) | undefined;

  const done = new Promise<Execution>((resolve) => {
    resolveDone = resolve;
  });

  const signal = (value: "SIGTERM" | "SIGKILL") => {
    if (child.pid === undefined) return;
    try {
      // A detached child leads its own group. No signal can target a sibling worker or its browser.
      process.kill(-child.pid, value);
    } catch {
      // ESRCH is the expected race when the process group already finished.
    }
  };

  const stop = (code: "Interrupted" | "Timeout" | "Output") => {
    if (closed) return done;
    if (stopCode === undefined) {
      stopCode = code;
      signal("SIGTERM");
      killTimer = setTimeout(() => {
        if (!closed) {
          forced = true;
          signal("SIGKILL");
        }
      }, 10_000);
    }

    return done;
  };

  child.stderr.on("data", (chunk: Buffer) => sink.feed(chunk));
  child.stdout.on("data", (chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes > maximumOutputBytes) {
      output.length = 0;
      void stop("Output");
    } else if (stopCode !== "Output") output.push(Uint8Array.from(chunk));
  });
  child.stdin.on("error", () => {
    /* An early worker exit is classified after both output pipes close. */
  });
  child.once("error", () => {
    spawnFailed = true;
  });
  child.once("close", (exitCode, exitSignal) => {
    closed = true;
    if (timeout !== undefined) clearTimeout(timeout);
    if (killTimer !== undefined) clearTimeout(killTimer);
    const elapsed = Math.max(0, performance.now() - startedAt);
    let result = failed(spawnFailed ? "Spawn" : "Exit", elapsed);

    if (outputBytes <= maximumOutputBytes) {
      try {
        const decoded = decodeResult(
          new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(output)),
        );

        if (Option.isSome(decoded)) result = decoded.value;
        else if (!spawnFailed && exitCode === 0) result = failed("Output", elapsed);
      } catch {
        result = failed("Output", elapsed);
      }
    }
    if (stopCode === undefined && (exitCode !== 0 || exitSignal !== null))
      result = { ...result, status: "failed", pass: false, code: spawnFailed ? "Spawn" : "Exit" };
    if (stopCode !== undefined)
      result = {
        ...result,
        status:
          stopCode === "Timeout"
            ? "timed-out"
            : stopCode === "Interrupted"
              ? "cancelled"
              : "failed",
        pass: false,
        code: stopCode,
        timings: { ...result.timings, totalMillis: elapsed },
      };
    resolveDone?.({
      result,
      // Node's close event follows stderr EOF; finishing sooner would silently lose shutdown traffic.
      protocol: sink.finish(),
      process: {
        exitCode,
        signal:
          exitSignal === null
            ? null
            : exitSignal === "SIGTERM" || exitSignal === "SIGKILL"
              ? exitSignal
              : "Other",
        forced,
      },
    });
  });
  timeout = setTimeout(() => {
    void stop("Timeout");
  }, timeoutMillis);
  // There is no command-line argument, temp file, diagnostic or log containing this capability.
  child.stdin.end(JSON.stringify(config));

  return { done, stop };
};

export const run = (config: Config, options: Options = {}): Effect.Effect<Execution, WorkerError> =>
  Effect.gen(function* () {
    const checked = yield* Schema.decodeEffect(Config, { onExcessProperty: "error" })(config).pipe(
      Effect.mapError(() => new WorkerError({ code: "InvalidConfig" })),
    );

    const timeoutMillis = options.timeoutMillis ?? 540_000;

    if (
      !Number.isSafeInteger(timeoutMillis) ||
      timeoutMillis < 1 ||
      timeoutMillis > 600_000 ||
      (checked.provider === "local") !== (checked.endpoint === null)
    )
      return yield* new WorkerError({ code: "InvalidConfig" });

    const running = yield* Effect.acquireRelease(
      Effect.try({
        try: () => start(checked, timeoutMillis),
        catch: () => new WorkerError({ code: "Spawn" }),
      }),
      (owned) => Effect.promise(() => owned.stop("Interrupted")),
    );

    return yield* Effect.promise(() => running.done);
  }).pipe(Effect.scoped);
