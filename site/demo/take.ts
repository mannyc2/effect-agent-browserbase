// One take of the demo, run the way the bench runs a trial: model calls behind the bench's opt-in
// and budget, a recorded local Chromium, and the outcome classified and checked. The take is then packed
// with the narrator's voice, which has a cap of its own within the take's.
import { OpenRouterLanguageModel } from "@effect/ai-openrouter";
import { BenchError, modelRunner, optedIn, refuse } from "bench/Budget.ts";
import * as Recorder from "bench/Recorder.ts";
import { errorText } from "bench/run.ts";
import { frameHistory } from "bench/Tasks.ts";
import * as Trace from "bench/Trace.ts";
import { classify, isolatedTrial, revision, workDeadline } from "bench/Trial.ts";
import { Clock, Console, DateTime, Duration, Effect, Exit, Path, Tracer } from "effect";
import * as Chromium from "effect-browser/Chromium";
import { FetchHttpClient } from "effect/http";

import * as Casino from "./casino.ts";
import type { DemoName } from "./defaults.ts";
import { pack } from "./pack.ts";
import * as Polymarket from "./polymarket.ts";
import type { ExploreOptions } from "./show.ts";
import * as Voice from "./voice.ts";

const tasks = { polymarket: Polymarket.task, casino: Casino.task } as const;

type Explored = ReturnType<typeof Casino.explore> | ReturnType<typeof Polymarket.explore>;

const explore = (
  demo: DemoName,
  options: ExploreOptions,
): Effect.Effect<Effect.Success<Explored>, Effect.Error<Explored>, Effect.Services<Explored>> =>
  demo === "casino" ? Casino.explore(options) : Polymarket.explore(options);

export interface TakeOptions {
  /** Which demo to record. */
  readonly demo: DemoName;
  /** The replay this take is packed as, under public/replays/. */
  readonly id: string;
  /** An OpenRouter model id, for the agent and the narrator. */
  readonly model: string;
  readonly reasoning: "none" | "low" | "medium" | "high";
  /** USD for the agent, narrator and voice together. */
  readonly maxUsd: number;
  /** How often the narrator speaks. */
  readonly every: Duration.Duration;
  readonly maxSteps: number;
  /** Show Chromium's window. */
  readonly headed: boolean;
}

export { defaults } from "./defaults.ts";

/** A take ends at this, as a bench trial does; Browserbase's own timeout ends a lost session. */
const deadline = Duration.minutes(10);

/** The voice's share of the take's budget: some 20 times what a long take's lines cost. */
const voiceShare = (maxUsd: number) => Math.min(0.25, maxUsd / 4);

export const take = Effect.fn("demo.take")(function* (options: TakeOptions) {
  if (!(yield* optedIn("EFFECT_BROWSER_BENCH_LIVE")))
    return yield* refuse("model calls cost money: set EFFECT_BROWSER_BENCH_LIVE=1 to make them");

  const path = yield* Path.Path;
  const voiceUsd = voiceShare(options.maxUsd);

  const runner = yield* modelRunner({
    model: options.model,
    rates: undefined,
    maxUsd: options.maxUsd - voiceUsd,
    maxOutputTokens: 4096,
    needs: { tools: true, structuredOutput: true },
  });

  const account = yield* runner.account;
  const stamp = DateTime.formatIso(yield* DateTime.now).replace(/[:.]/g, "-");

  const directory = path.join(
    import.meta.dirname,
    "..",
    "..",
    ".work",
    "demo",
    `${stamp}-${options.id}`,
  );

  const recorder = yield* Recorder.make(directory);
  const traced = yield* Trace.collect;
  const source = yield* revision;

  yield* Console.log(`Take ${options.id}: ${options.model}, recording into ${directory}`);

  const task = tasks[options.demo];

  const work = runner.withModel(
    Effect.provide(
      explore(options.demo, {
        every: options.every,
        maxSteps: options.maxSteps,
        trace: recorder.trace,
        captionCall: OpenRouterLanguageModel.withConfigOverride({ reasoning: { effort: "none" } }),
      }),
      FetchHttpClient.layer,
    ),
    options.reasoning,
    account,
  );

  const browser = Chromium.layer({ frameHistory, headless: !options.headed });

  const startedNanos = yield* Clock.monotonicTimeNanos;

  const exit = yield* isolatedTrial(recorder.around(work), browser).pipe(
    Effect.raceFirst(workDeadline(deadline, account.queued)),
    Effect.withSpan("demo.take", { root: true, attributes: { model: options.model } }),
    Effect.exit,
    Effect.provideService(Tracer.Tracer, traced.tracer),
  );

  const seconds = Number((yield* Clock.monotonicTimeNanos) - startedNanos) / 1e9;
  const calls = yield* account.calls;
  const outcome = classify(exit, calls);
  const value = Exit.isSuccess(exit) ? exit.value : undefined;
  const detail = Exit.isSuccess(exit) ? exit.value.detail : errorText(exit.cause);

  yield* recorder.finish({
    task: { name: task.name, kind: task.kind, summary: task.summary, prompt: task.prompt },
    run: {
      trial: 1,
      seed: 0,
      model: options.model,
      reasoning: options.reasoning,
      browser: "chromium",
      humanize: true,
      commit: source.commit,
      dirty: source.dirty,
    },
    outcome: {
      ...outcome,
      detail,
      answer: value?.answer ?? null,
      calls: calls.accounting.calls,
      knownUsd: calls.accounting.knownUsd,
      seconds,
    },
    spans: traced.spans,
  });

  yield* Console.log(
    `${outcome.status} ${outcome.pass === true ? "pass" : outcome.pass === false ? "FAIL" : ""} ${outcome.reason}, ${seconds.toFixed(0)}s, ${calls.accounting.calls} model calls, $${calls.accounting.knownUsd.toFixed(4)} known + $${calls.accounting.reservedUsd.toFixed(4)} unresolved\n${detail}`,
  );
  if (Exit.isFailure(exit) && outcome.status !== "graded")
    return yield* new BenchError({ message: `the take did not finish: ${detail}` });

  const voice = yield* Voice.make({ ...Voice.defaults, maxUsd: voiceUsd }).pipe(
    Effect.provide(FetchHttpClient.layer),
  );

  const packed = yield* pack(directory, options.id, voice);
  const voiceUsdSpent = yield* voice.spent;

  yield* Console.log(
    `Packed ${options.id}: ${packed.lines} lines spoken for $${voiceUsdSpent.toFixed(4)}; the take cost $${(calls.accounting.knownUsd + voiceUsdSpent).toFixed(4)} in all.`,
  );

  return { directory, replay: options.id, outcome };
}, Effect.provide(Trace.layer));
