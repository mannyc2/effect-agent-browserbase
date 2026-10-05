// Executed only in an isolated process whose protocol environment was set before these imports.
import { fileURLToPath } from "node:url";

import { OpenRouterClient, OpenRouterLanguageModel } from "@effect/ai-openrouter";
import { Cause, Clock, Effect, Exit, Layer, Option, Redacted, Schema, Stream } from "effect";
import * as Agent from "effect-browser/Agent";
import * as Browser from "effect-browser/Browser";
import { BrowserError, PolicyDenied } from "effect-browser/BrowserError";
import * as Cdp from "effect-browser/Cdp";
import * as Chromium from "effect-browser/Chromium";
import type { InputGuard } from "effect-browser/Page";
import { AiError, type LanguageModel } from "effect/ai";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import * as Arms from "./Arms.ts";
import * as Diagnostics from "./Diagnostics.ts";
import * as Native from "./Native.ts";
import * as Perception from "./Perception.ts";
import { origin } from "./Sites.ts";
import { tasks, type Outcome } from "./Tasks.ts";
import * as Worker from "./Worker.ts";

class ExecutionError extends Schema.TaggedError<ExecutionError>()("WorkerExecutionError", {
  code: Worker.Code,
}) {}
type Phase = "prepare" | "run" | "grade";

/** The public guard refuses known destinations before any input can be dispatched. */
export const fixtureGuard: InputGuard = (request) => {
  for (const destination of [request.destination, request.href]) {
    if (destination === undefined) continue;
    try {
      const address = new URL(destination, origin);

      if (address.origin !== origin || address.username !== "" || address.password !== "")
        return Effect.fail(
          new PolicyDenied({ detail: "The trial is restricted to its local fixture." }),
        );
    } catch {
      return Effect.fail(
        new PolicyDenied({ detail: "The trial destination could not be checked." }),
      );
    }
  }

  return Effect.void;
};

/** Install before Sites.serve: its later route fulfills fixtures, and everything else is denied. */
export const isolateNetwork = (browser: Browser.Service) =>
  Effect.tryPromise({
    try: async () => {
      await browser.context.route("**/*", (route) => route.abort("blockedbyclient"));
      await browser.context.routeWebSocket("**/*", (socket) => socket.close());
    },
    catch: () => new ExecutionError({ code: "Browser" }),
  });

const tracker = () => {
  const started = performance.now();
  let since = started;
  let phase: Phase | undefined = "prepare";
  let cleanupFailed = false;
  const times = { prepare: 0, run: 0, grade: 0 };

  const phaseMarks: { prepare: number | null; run: number | null; grade: number | null } = {
    prepare: Date.now(),
    run: null,
    grade: null,
  };

  const perception = { parseCalls: 0, groundCalls: 0, millis: 0, failures: 0 };
  let actions = 0;
  let steps = 0;
  let usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };

  const mark = (next: Phase) =>
    Effect.gen(function* () {
      const wall = yield* Clock.currentTimeMillis;
      const now = performance.now();

      if (phase !== undefined) times[phase] += Math.max(0, now - since);
      since = now;
      phase = next;
      if (phaseMarks[next] === null) phaseMarks[next] = wall;
    });

  const guard: InputGuard = (request) =>
    fixtureGuard(request).pipe(
      Effect.andThen(
        Effect.sync(() => {
          if (phase === "run") actions += 1;
        }),
      ),
    );

  const onUsage = (next: Agent.Usage) =>
    Effect.sync(() => {
      steps += 1;
      usage = {
        inputTokens: usage.inputTokens + next.inputTokens,
        outputTokens: usage.outputTokens + next.outputTokens,
        cachedInputTokens: usage.cachedInputTokens + next.cachedInputTokens,
      };
    });

  const measure = <A, E, R>(kind: "parseCalls" | "groundCalls", effect: Effect.Effect<A, E, R>) =>
    Effect.suspend(() => {
      perception[kind] += 1;
      const before = performance.now();

      return effect.pipe(
        Effect.onError(() =>
          Effect.sync(() => {
            perception.failures += 1;
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            perception.millis += Math.max(0, performance.now() - before);
          }),
        ),
      );
    });

  const snapshot = () => {
    const now = performance.now();

    if (phase !== undefined) times[phase] += Math.max(0, now - since);
    since = now;

    return {
      steps,
      usage,
      actions,
      perception: { ...perception },
      phaseMarks: { ...phaseMarks },
      timings: {
        prepareMillis: times.prepare,
        runMillis: times.run,
        gradeMillis: times.grade,
        totalMillis: Math.max(0, now - started),
      },
    };
  };

  const end = Effect.sync(() => {
    const now = performance.now();

    if (phase !== undefined) times[phase] += Math.max(0, now - since);
    since = now;
    phase = undefined;
  });

  return {
    mark,
    guard,
    onUsage,
    measure,
    snapshot,
    end,
    cleanupFailure: Effect.sync(() => {
      cleanupFailed = true;
    }),
    hasCleanupFailure: () => cleanupFailed,
  };
};

const browserLayer = (config: Worker.Config, state: ReturnType<typeof tracker>) => {
  const settings = { frameHistory: 1200, guard: state.guard };

  return Layer.effect(
    Browser.Browser,
    Effect.gen(function* () {
      if (config.provider === "browserbase" && config.endpoint === null)
        return yield* new ExecutionError({ code: "InvalidConfig" });

      const attached =
        config.provider === "local"
          ? yield* Chromium.open()
          : yield* Cdp.open({
              endpoint: Redacted.make(config.endpoint ?? ""),
              connectTimeoutMillis: 30_000,
            });

      const connection = attached.context.browser();

      if (connection === null) return yield* new ExecutionError({ code: "Browser" });

      // Context routing cannot intercept service-worker-owned requests. A fresh context explicitly
      // blocks them; the launch/attachment scope still owns the underlying connection separately.
      const context = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            connection.newContext({
              viewport: { width: 1280, height: 720 },
              deviceScaleFactor: 1,
              serviceWorkers: "block",
            }),
          catch: () => new ExecutionError({ code: "Browser" }),
        }),
        (owned) =>
          Effect.tryPromise(() => owned.close()).pipe(Effect.catch(() => state.cleanupFailure)),
      );

      return yield* Browser.make(
        context,
        {
          id: "paired-worker",
          provider: config.provider === "local" ? "chromium" : "browserbase",
          contextOrigin: "fresh",
        },
        settings,
      );
    }),
  );
};

const nativeTransport = (config: Worker.Config) =>
  Layer.effect(
    Native.NativeTransport,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;

      return Native.NativeTransport.of({
        request: (request) =>
          Effect.gen(function* () {
            const response = yield* client
              .execute(
                HttpClientRequest.post(config.apiUrl + "/responses").pipe(
                  HttpClientRequest.bodyJsonUnsafe(request),
                ),
              )
              .pipe(Effect.mapError(() => new Native.NativeError({ code: "RequestUncertain" })));

            const read = yield* response.stream.pipe(
              Stream.mapError(() => new Native.NativeError({ code: "RequestUncertain" })),
              Stream.runFoldEffect(
                () => ({ size: 0, chunks: [] as Array<Uint8Array> }),
                (state, chunk) => {
                  if (state.size + chunk.byteLength > 16 * 1024 * 1024)
                    return Effect.fail(new Native.NativeError({ code: "ResponseEnvelopeInvalid" }));
                  state.chunks.push(Uint8Array.from(chunk));
                  state.size += chunk.byteLength;

                  return Effect.succeed(state);
                },
              ),
            );

            const value = yield* Effect.try({
              try: () =>
                new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(read.chunks)),
              catch: () => new Native.NativeError({ code: "ResponseEnvelopeInvalid" }),
            });

            if (response.status !== 200) {
              const failure = Schema.decodeOption(
                Schema.fromJsonString(Schema.Struct({ code: Native.Code })),
              )(value);

              return yield* new Native.NativeError({
                code: Option.isSome(failure) ? failure.value.code : "RequestUncertain",
              });
            }

            return yield* Schema.decodeEffect(Schema.fromJsonString(Native.ReplySchema), {
              onExcessProperty: "error",
            })(value).pipe(
              Effect.mapError(() => new Native.NativeError({ code: "ResponseEnvelopeInvalid" })),
            );
          }),
      });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));

const execute = (config: Worker.Config, state: ReturnType<typeof tracker>) =>
  Effect.gen(function* () {
    const task = tasks.find((candidate) => candidate.name === config.task);

    if (task === undefined) return yield* new ExecutionError({ code: "UnknownTask" });

    const model = OpenRouterLanguageModel.layer({
      model: config.model,
      config: { reasoning: { effort: config.reasoning }, max_tokens: config.maxOutputTokens },
    }).pipe(
      Layer.provide(OpenRouterClient.layer({ apiUrl: config.apiUrl })),
      Layer.provide(FetchHttpClient.layer),
    );

    const options = { seed: config.seed, onUsage: state.onUsage, onPhase: state.mark };

    const trial: Effect.Effect<
      Outcome,
      | Agent.AgentError
      | AiError.AiError
      | BrowserError
      | ExecutionError
      | Native.NativeError
      | Perception.PerceptionError,
      Browser.Browser | LanguageModel.LanguageModel
    > = config.scripted
      ? task.scripted({ seed: config.seed })
      : config.arm === 6
        ? task
            .withStrategy(Native.makeStrategy(config), options)
            .pipe(Effect.provide(nativeTransport(config)))
        : config.arm === 4 && task.kind === "understand"
          ? task.withStrategy(Arms.current, options)
          : config.arm === 3 || config.arm === 4
            ? task.withStrategy(Arms.strategies[config.arm], options).pipe(
                Effect.provide(
                  Layer.effect(
                    Perception.Perception,
                    Effect.gen(function* () {
                      if (config.perceptionOrigin === null)
                        return yield* new ExecutionError({ code: "Unavailable" });
                      const service = yield* Perception.make({ origin: config.perceptionOrigin });

                      return Perception.Perception.of({
                        parse: (image) => state.measure("parseCalls", service.parse(image)),
                        ground: (image, what) =>
                          state.measure("groundCalls", service.ground(image, what)),
                        status: service.status,
                      });
                    }),
                  ).pipe(Layer.provide(FetchHttpClient.layer)),
                ),
              )
            : task.withStrategy(Arms.strategies[config.arm], options);

    const isolated = Effect.gen(function* () {
      const browser = yield* Browser.Browser;

      yield* isolateNetwork(browser);

      return yield* trial;
    });

    return yield* isolated.pipe(
      // Scope teardown belongs in total time, not in the run or grader duration.
      Effect.ensuring(state.end),
      Effect.provide([model, browserLayer(config, state)]),
    );
  });

const codeOf = (cause: Cause.Cause<unknown>): Worker.Code => {
  if (Cause.hasInterruptsOnly(cause)) return "Interrupted";
  const candidate = Cause.findErrorOption(cause);
  const error = Option.isSome(candidate) ? candidate.value : undefined;

  if (Schema.is(ExecutionError)(error)) return error.code;
  if (Schema.is(Native.NativeError)(error)) return error.code;
  if (Schema.is(Perception.PerceptionError)(error)) return error.reason;
  if (Schema.is(BrowserError)(error)) return "Browser";
  if (Schema.is(Agent.AgentError)(error)) return "Agent";
  if (AiError.isAiError(error)) return "Model";

  return Cause.hasDies(cause) ? "Defect" : "Other";
};

const resultOf = (
  exit: Exit.Exit<Outcome, unknown>,
  state: ReturnType<typeof tracker>,
  scripted: boolean,
): Worker.Result => {
  const metrics = state.snapshot();

  if (Exit.isFailure(exit))
    return {
      ...Worker.failed(state.hasCleanupFailure() ? "Cleanup" : codeOf(exit.cause)),
      ...metrics,
      actions: scripted ? null : metrics.actions,
      actionMeasurement: scripted ? "unmeasured" : "guard-approved-attempts",
      diagnostic: Diagnostics.failure(exit.cause),
    };
  const incomplete = exit.value.detail.startsWith("capture incomplete:");
  const code = state.hasCleanupFailure() ? "Cleanup" : incomplete ? "CaptureIncomplete" : null;

  return {
    ...Worker.failed(code ?? "Other"),
    ...metrics,
    status: code === null ? "completed" : "failed",
    pass: code === null && exit.value.pass,
    steps: exit.value.steps,
    usage: exit.value.usage,
    code,
    actions: scripted ? null : metrics.actions,
    actionMeasurement: scripted ? "unmeasured" : "guard-approved-attempts",
  };
};

const read = Effect.tryPromise({
  try: async () => {
    const chunks: Array<Uint8Array> = [];
    let size = 0;

    for await (const value of process.stdin) {
      const chunk: unknown = value;

      if (!(chunk instanceof Uint8Array)) throw new Error("Invalid input");
      size += chunk.byteLength;
      if (size > 16 * 1024) throw new Error("Input too large");
      chunks.push(Uint8Array.from(chunk));
    }

    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  },
  catch: () => new ExecutionError({ code: "InvalidConfig" }),
}).pipe(
  Effect.flatMap((value) =>
    Schema.decodeEffect(Schema.fromJsonString(Worker.Config), { onExcessProperty: "error" })(
      value,
    ).pipe(Effect.mapError(() => new ExecutionError({ code: "InvalidConfig" }))),
  ),
);

export const main = async (): Promise<void> => {
  const controller = new AbortController();
  const terminate = () => controller.abort();

  process.once("SIGTERM", terminate);
  process.once("SIGINT", terminate);
  try {
    const config = await Effect.runPromiseExit(read, { signal: controller.signal });

    if (Exit.isFailure(config)) {
      process.stdout.write(JSON.stringify(Worker.failed(codeOf(config.cause))) + "\n");

      return;
    }
    const state = tracker();

    const exit = await Effect.runPromiseExit(execute(config.value, state), {
      signal: controller.signal,
    });

    const result = Schema.encodeSync(Worker.Result)(resultOf(exit, state, config.value.scripted));

    process.stdout.write(JSON.stringify(result) + "\n");
  } finally {
    process.off("SIGTERM", terminate);
    process.off("SIGINT", terminate);
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
