// The `tradingview` command: an agent working TradingView's charts, graded on the chart's own
// state. `--mode scripted` reaches each graded state with the chart's own controls and `--mode
// untouched` leaves the chart alone, so the graders show they can pass and fail at no model cost;
// `--mode replayed` records the scripted walk and replays it on a fresh browser, grading the
// replayed chart; `--mode model` runs the agent, behind its opt-in. `--humanize` performs the
// input for viewers, through a presenter. Live sites change, so its results speak to the day they
// were taken.
import {
  Cause,
  Clock,
  Config,
  Console,
  DateTime,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
} from "effect";
import { Browser } from "effect-browser/Browser";
import type * as BrowserEvent from "effect-browser/BrowserEvent";
import * as Chromium from "effect-browser/Chromium";
import * as Plan from "effect-browser/Plan";
import * as Presentation from "effect-browser/Presentation";
import * as Browserbase from "effect-browserbase/Browserbase";
import * as BrowserbaseClient from "effect-browserbase/BrowserbaseClient";
import * as ContextLease from "effect-browserbase/ContextLease";
import { Command, Flag } from "effect/cli";
import { FetchHttpClient } from "effect/http";

import * as Arms from "./Arms.ts";
import {
  efforts,
  type ModelCall,
  type ModelRunner,
  modelRunner,
  optedIn,
  type Refusal,
  refuse,
} from "./Budget.ts";
import { errorText, hostedSessionSeconds } from "./run.ts";
import { frameHistory } from "./Tasks.ts";
import * as TradingView from "./TradingViewTasks.ts";

const names = [
  ...new Set(Object.values(TradingView.tasks).flatMap((tasks) => tasks.map((task) => task.name))),
];

const flags = {
  site: Flag.Literals("site", ["demo", "tradingview"]).pipe(
    Flag.withDefault("demo"),
    Flag.withDescription(
      "TradingView's Advanced Charts demo, which needs no account, or tradingview.com. Defaults to demo.",
    ),
  ),
  mode: Flag.Literals("mode", ["scripted", "untouched", "replayed", "model"]).pipe(
    Flag.withDefault("scripted"),
    Flag.withDescription(
      "scripted solves each task with the chart's own controls, untouched leaves the chart alone, replayed replays the scripted walk on a fresh browser and grades that, model runs the agent. Defaults to scripted.",
    ),
  ),
  humanize: Flag.Boolean("humanize").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Perform the input for viewers, through a presenter's view of the page."),
  ),
  task: Flag.Literals("task", names).pipe(
    Flag.atLeast(0),
    Flag.withDescription("Run this task; repeat for more. Defaults to all of the site's."),
  ),
  trials: Flag.Int("trials").pipe(
    Flag.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
    Flag.withDefault(1),
    Flag.withDescription("Trials per task. Defaults to 1."),
  ),
  arm: Flag.ChoiceWithValue(
    "arm",
    Arms.arms.map((arm) => [String(arm), arm] as const),
  ).pipe(Flag.withDefault(5 as Arms.Arm), Flag.withDescription("The agent's arm. Defaults to 5.")),
  model: Flag.String("model").pipe(
    Flag.withDefault("openai/gpt-6-luna"),
    Flag.withDescription("OpenRouter model for --mode model. Defaults to openai/gpt-6-luna."),
  ),
  reasoning: Flag.Literals("reasoning", efforts).pipe(
    Flag.withDefault("medium"),
    Flag.withDescription("Reasoning effort. Defaults to medium."),
  ),
  maxUsd: Flag.Finite("max-usd").pipe(
    Flag.withSchema(Schema.Finite.check(Schema.isGreaterThan(0))),
    Flag.withDefault(1),
    Flag.withDescription("Model budget, in USD. Defaults to 1."),
  ),
  browser: Flag.Literals("browser", ["chromium", "browserbase"]).pipe(
    Flag.withDefault("chromium"),
    Flag.withDescription("Where each trial's browser runs. Defaults to chromium."),
  ),
  signedIn: Flag.Boolean("signed-in").pipe(
    Flag.withDefault(false),
    Flag.withDescription(
      "With browserbase, load the stored context BROWSERBASE_CONTEXT_ID names, without saving to it, for a signed-in tradingview.com.",
    ),
  ),
  out: Flag.String("out").pipe(
    Flag.optional,
    Flag.withDescription("Results directory. Defaults to .work/tradingview in the repository."),
  ),
};

// What stopped a trial or its replay: a page operation's or a replay's own message, which names
// the input or step that failed, or the bench's word for anything else.
const stopped = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);

  return error instanceof Error && ["BrowserError", "ReplayError"].includes(error.name)
    ? error.message
    : errorText(cause);
};

/**
 * How a model run ended without an answer, in the bench's own words. A call the ledger refused, or
 * one that ended without a decoded response, is the bench's failure, not the model's.
 */
const ending = (cause: Cause.Cause<unknown>, refusal: Refusal | null) => {
  if (refusal === "budget") return "denied: no call fit the budget";
  if (refusal === "unresolved") return "infrastructure: a request ended without a decoded response";
  if (refusal === "bound") return "infrastructure: a charge exceeded its reservation";
  const error = Cause.squash(cause);

  if (Schema.is(Arms.GaveUp)(error)) return `gave up: ${error.reason}`;
  if (Schema.is(Arms.StepLimit)(error) || Schema.is(Arms.Unanswered)(error))
    return `${error._tag}: ${error.detail}`;

  return errorText(cause);
};

interface Run {
  readonly mode: "scripted" | "untouched" | "replayed" | "model";
  readonly humanize: boolean;
  readonly arm: Arms.Arm;
  readonly reasoning: (typeof efforts)[number];
  readonly runner: ModelRunner | undefined;
  readonly directory: string;
}

// What a walk typed, by the input slots its plan names, from the events it was recorded from: the
// plan keeps each typed text as a slot, never the text.
const typed = (plan: Plan.Plan, events: ReadonlyArray<BrowserEvent.BrowserEvent>) => {
  const page = events.find((event) => event._tag === "Action")?.page;

  const actions = events.filter(
    (event): event is BrowserEvent.Action =>
      event._tag === "Action" && event.page === page && event.ok && event.value._tag !== "Act",
  );

  return Object.fromEntries(
    plan.steps.flatMap((step, index) => {
      const value = actions[index]?.value;

      return step.input === undefined || value?._tag !== "Type" ? [] : [[step.input, value.text]];
    }),
  );
};

/** One trial on its own browser: the chart before, the work, the chart after and its grade. */
const trial = (run: Run, url: string, task: TradingView.Task, id: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const page = yield* (yield* Browser).firstPage;
    const acting = run.humanize ? (yield* Presentation.make()).view(page) : page;
    const steps: Array<Arms.Step> = [];

    yield* page.goto(url);
    yield* TradingView.chartLoaded(page);
    if (task.setup !== undefined) yield* task.setup(page);
    const start = yield* TradingView.state(page);

    yield* fs.writeFile(
      path.join(run.directory, `${id}.start.png`),
      (yield* page.screenshot()).data,
    );

    let answer = "";
    let ended = "done";
    let usd = 0;
    let modelCalls: ReadonlyArray<ModelCall> = [];

    if (run.mode === "scripted" || run.mode === "replayed")
      answer = yield* task.solve(acting, start);
    if (run.runner !== undefined) {
      const account = yield* run.runner.account;

      const agent = Arms.operate(run.arm, acting, task.prompt, {
        answer: Schema.String,
        maxSteps: task.maxSteps,
        onStep: (step) => Effect.sync(() => void steps.push(step)),
      });

      const exit = yield* Effect.exit(
        run.runner.withModel(agent, run.reasoning, account).pipe(Effect.timeout("12 minutes")),
      );

      const calls = yield* account.calls;

      if (Exit.isSuccess(exit)) answer = exit.value.answer;
      else ended = ending(exit.cause, calls.refusal);
      usd = (yield* account.snapshot).knownUsd;
      modelCalls = calls.log;
    }

    const end = yield* TradingView.state(page);

    yield* fs.writeFile(path.join(run.directory, `${id}.end.png`), (yield* page.screenshot()).data);
    if (steps.length > 0)
      yield* fs.writeFileString(
        path.join(run.directory, `${id}.steps.jsonl`),
        steps.map((step) => `${JSON.stringify(step)}\n`).join(""),
      );

    const tools: Record<string, number> = {};

    for (const { name } of steps.flatMap((step) => step.calls))
      tools[name] = (tools[name] ?? 0) + 1;

    const events = yield* page.recentEvents;
    const plan = Plan.fromEvents(events);

    if (run.mode === "replayed")
      yield* fs.writeFileString(
        path.join(run.directory, `${id}.plan.json`),
        JSON.stringify(yield* Schema.encodeEffect(Plan.Plan)(plan), null, 2),
      );
    // The page's input by kind; `act` counts the chart API's changes, the setup's among them.
    const actions: Record<string, number> = {};

    for (const event of events)
      if (event._tag === "Action" && event.ok) actions[event.name] = (actions[event.name] ?? 0) + 1;

    return {
      ...task.grade(start, end, answer),
      answer,
      ended,
      arm: run.runner === undefined ? null : run.arm,
      turns: steps.length,
      tools,
      actions,
      modelCalls,
      usd,
      walk: run.mode === "replayed" ? { plan, inputs: typed(plan, events) } : undefined,
    };
  });

/**
 * A recorded walk replayed on a fresh browser, from the chart the task starts from, and the
 * replayed chart graded: whether a recording keeps the work.
 */
const replay = (
  url: string,
  task: TradingView.Task,
  walk: { readonly plan: Plan.Plan; readonly inputs: Readonly<Record<string, string>> },
  answer: string,
) =>
  Effect.gen(function* () {
    const page = yield* (yield* Browser).firstPage;
    const [first] = walk.plan.steps;

    yield* page.goto(url);
    yield* TradingView.chartLoaded(page);
    if (task.setup !== undefined) yield* task.setup(page);
    const start = yield* TradingView.state(page);

    // The walk opens on the chart this page has just loaded.
    const replayed = yield* Effect.exit(
      Plan.replay(page, walk.plan, {
        inputs: walk.inputs,
        from: first?.action._tag === "Goto" ? 1 : 0,
      }),
    );

    const end = yield* TradingView.state(page);
    const grade = task.grade(start, end, answer);

    return {
      pass: grade.pass,
      detail: Exit.isSuccess(replayed)
        ? grade.detail
        : `stopped: ${stopped(replayed.cause)}; ${grade.detail}`,
      steps: walk.plan.steps.length,
    };
  });

export const command = Command.make(
  "tradingview",
  flags,
  Effect.fnUntraced(function* (options) {
    if (options.mode === "model" && !(yield* optedIn("EFFECT_BROWSER_BENCH_LIVE")))
      return yield* refuse("model calls cost money: set EFFECT_BROWSER_BENCH_LIVE=1 to make them");
    if (options.browser === "browserbase" && !(yield* optedIn("EFFECT_BROWSER_BENCH_HOSTED")))
      return yield* refuse("Browserbase sessions cost money: set EFFECT_BROWSER_BENCH_HOSTED=1");
    if (options.signedIn && options.browser !== "browserbase")
      return yield* refuse("--signed-in loads a Browserbase context: use --browser browserbase");
    if (options.browser === "browserbase" && Arms.deviceScale(options.arm) !== 1)
      return yield* refuse("arms 11 and 12 set the device scale of a local chromium");

    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    // Read-only: the session loads the context and saves nothing back to it.
    const context = options.signedIn
      ? { id: yield* Config.String("BROWSERBASE_CONTEXT_ID"), persist: false }
      : undefined;

    const browser = (metadata: Readonly<Record<string, string>>) =>
      options.browser === "chromium"
        ? Chromium.layer({
            frameHistory,
            requests: TradingView.readOnly,
            deviceScaleFactor: Arms.deviceScale(options.arm),
          })
        : Browserbase.layer({
            requests: TradingView.readOnly,
            frameHistory,
            session: {
              timeout: hostedSessionSeconds,
              browserSettings: { viewport: { width: 1280, height: 720 }, context },
              userMetadata: metadata,
            },
          }).pipe(
            Layer.provide(ContextLease.layer),
            Layer.provide(
              BrowserbaseClient.layerConfig().pipe(Layer.provide(FetchHttpClient.layer)),
            ),
          );

    const selected = TradingView.tasks[options.site].filter(
      (task) => options.task.length === 0 || options.task.includes(task.name),
    );

    const runner =
      options.mode === "model"
        ? yield* modelRunner({
            model: options.model,
            rates: undefined,
            maxUsd: options.maxUsd,
            maxOutputTokens: 4096,
            needs: { tools: true, structuredOutput: false },
          })
        : undefined;

    const stamp = DateTime.formatIso(yield* DateTime.now).replace(/[:.]/g, "-");

    const directory = Option.getOrElse(options.out, () =>
      path.join(
        import.meta.dirname,
        "..",
        ".work",
        "tradingview",
        `${stamp}-${options.site}-${options.mode}`,
      ),
    );

    yield* fs.makeDirectory(directory, { recursive: true });

    const run: Run = {
      mode: options.mode,
      humanize: options.humanize,
      arm: options.arm,
      reasoning: options.reasoning,
      directory,
      runner,
    };

    let passed = 0;
    let spent = 0;

    for (const task of selected)
      for (let number = 1; number <= options.trials; number++) {
        const id = `${task.name}-${number}`;
        const started = yield* Clock.currentTimeMillis;

        const exit = yield* Effect.exit(
          trial(run, TradingView.sites[options.site], task, id).pipe(
            Effect.scoped,
            Effect.provide(
              browser({ bench: "tradingview", task: task.name, trial: String(number) }),
            ),
          ),
        );

        const seconds = ((yield* Clock.currentTimeMillis) - started) / 1000;
        const walk = Exit.isSuccess(exit) ? exit.value.walk : undefined;
        const answer = Exit.isSuccess(exit) ? exit.value.answer : "";

        const graded = Exit.isSuccess(exit)
          ? { ...exit.value, walk: undefined }
          : { pass: false, detail: `infrastructure: ${stopped(exit.cause)}`, ended: "", usd: 0 };

        // The replayed chart's grade is the trial's: the scripted one stands beside it.
        const replayed =
          walk === undefined
            ? undefined
            : yield* Effect.exit(
                replay(TradingView.sites[options.site], task, walk, answer).pipe(
                  Effect.scoped,
                  Effect.provide(
                    browser({
                      bench: "tradingview",
                      task: task.name,
                      trial: String(number),
                      replay: "1",
                    }),
                  ),
                ),
              );

        const record =
          replayed === undefined
            ? graded
            : Exit.isSuccess(replayed)
              ? {
                  ...graded,
                  pass: replayed.value.pass,
                  detail: `replayed ${replayed.value.steps} steps: ${replayed.value.detail}; scripted ${graded.pass ? "passed" : "failed"}`,
                }
              : {
                  ...graded,
                  pass: false,
                  detail: `replay infrastructure: ${stopped(replayed.cause)}`,
                };

        if (record.pass) passed += 1;
        spent += record.usd;
        yield* fs.writeFileString(
          path.join(directory, "results.jsonl"),
          `${JSON.stringify({ task: task.name, trial: number, site: options.site, mode: options.mode, humanize: options.humanize, seconds, ...record })}\n`,
          { flag: "a" },
        );
        yield* Console.log(
          `${id.padEnd(12)} ${record.pass ? "pass" : "FAIL"}  ${seconds.toFixed(0)}s  $${record.usd.toFixed(4)}  ${record.ended}  | ${record.detail}`,
        );
      }

    yield* Console.log(
      `\n${passed}/${selected.length * options.trials} passed, $${spent.toFixed(4)} known model spend; ${directory}`,
    );
  }),
).pipe(
  Command.withDescription(
    "TradingView tasks for an agent: timeframes, indicators, drawing, zooming and reading, graded on the chart's own state.",
  ),
);
