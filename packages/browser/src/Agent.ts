/**
 * A browser agent: a language model with the browser tools, called in a loop until it reports
 * an answer with `done` or stops with `give_up`.
 *
 * Any `effect/ai` `LanguageModel` drives it, on a page, or on a browser whose tabs its tools
 * follow, each given as a value. Tool calls run one at a time, in the order the model made them,
 * halting on failure or completion. Each turn that does not end the run is followed by one
 * observation, with the crops `browser_zoom` took, and a run whose page or browser is gone fails
 * with that `BrowserError`. Only the latest few pictures stay in the conversation: older ones are
 * replaced by a note, several at a time, so a provider's prompt cache keeps most of it.
 *
 * What the model sees (`observe`), its tools (`tools`) and its system prompt (`system`) can each be
 * replaced. A run that ends without an answer fails with `AgentError`, which keeps its usage and
 * its conversation.
 *
 * @since 0.3.0
 */
import { Context, Effect, Option, Ref, Result, Schema } from "effect";
import { AiError, Chat, type LanguageModel, Prompt, type Tool, Toolkit } from "effect/ai";

import type * as Browser from "./Browser.ts";
import { BrowserError, consequence } from "./BrowserError.ts";
import { operations, Receipt } from "./internal/agent/operations.ts";
import { completion } from "./internal/agent/projection.ts";
import * as Usage from "./internal/agent/usage.ts";
import type * as Page from "./Page.ts";
import * as Policy from "./Policy.ts";
import * as Tools from "./Tools.ts";

export type { Usage } from "./internal/agent/usage.ts";

/** The model used every step it was given without finishing. */
export class StepLimit extends Schema.TaggedError<StepLimit>()("StepLimit", {
  steps: Schema.Finite,
}) {
  override get message() {
    return `the task was not finished in ${this.steps} steps`;
  }
}

/** The model said the task cannot be done, or stopped calling tools. */
export class GaveUp extends Schema.TaggedError<GaveUp>()("GaveUp", {
  reason: Schema.String,
}) {
  override get message() {
    return `the agent gave up: ${this.reason}`;
  }
}

/** The input policy refused three actions in a row: the task needs what the policy forbids. */
export class Refused extends Schema.TaggedError<Refused>()("Refused", {
  refusals: Schema.Array(Schema.String),
}) {
  override get message() {
    return `the input policy refused ${this.refusals.length} actions in a row; the last: ${this.refusals.at(-1)}`;
  }
}

/** How a run ended without an answer, with what it spent and its whole conversation. */
export class AgentError extends Schema.TaggedError<AgentError>()("AgentError", {
  reason: Schema.Union([StepLimit, GaveUp, Refused]),
  steps: Schema.Finite,
  usage: Usage.Usage,
  history: Prompt.Prompt,
}) {
  override get message() {
    return this.reason.message;
  }
}

/** One model call and the tool calls it made, for logging, narration or a live view. */
export interface Step {
  readonly step: number;
  /** What the model said alongside its tool calls. */
  readonly text: string;
  readonly calls: ReadonlyArray<{ readonly name: string; readonly params: unknown }>;
  /** Each call's result: a browser tool's `Tools.Receipt`, or its `BrowserError`. */
  readonly results: ReadonlyArray<{
    readonly name: string;
    readonly result: unknown;
    readonly isFailure: boolean;
  }>;
  readonly usage: Usage.Usage;
  /**
   * Set when the model's response could not be read, such as a call to a tool that does not exist
   * or arguments that are not JSON. None of its calls ran, the model is asked to try again, and
   * its usage is not reported.
   */
  readonly rejected?: string | undefined;
}

export interface Result<A> {
  readonly answer: A;
  readonly steps: number;
  readonly usage: Usage.Usage;
  /** The whole conversation, for logs and for picking a run up later. */
  readonly history: Prompt.Prompt;
}

/**
 * What the model sees of the page before its first turn, and after each turn that does not end the
 * run; nothing adds no message. A failure is told to the model, unless the browser is gone, or
 * the page with tools pinned to it, which ends the run.
 */
export type Observe<R = never> = (
  page: Page.Page,
) => Effect.Effect<ReadonlyArray<Prompt.UserMessagePart>, BrowserError, R>;

const text = (value: string) => Prompt.makePart("text", { text: value });

/** How a part of an observation went, or nothing where it was not asked for. */
const part = <A>(asked: boolean, read: Effect.Effect<A, BrowserError>) =>
  asked ? Effect.asSome(Effect.result(read)) : Effect.succeedNone;

/**
 * What the model sees by default: the viewport's outline, a screenshot, or both, the default, read
 * together; what could not be read is named, and only when nothing could does it fail.
 */
export const observe =
  (mode: "outline" | "screenshot" | "both" = "both"): Observe =>
  (page) =>
    Effect.gen(function* () {
      const [outline, image] = yield* Effect.all(
        [
          part(mode !== "screenshot", page.snapshot({ maxChars: 8000 })),
          part(mode !== "outline", page.screenshot()),
        ],
        { concurrency: 2 },
      );

      const snapshot = Option.getOrUndefined(Option.flatMap(outline, Result.getSuccess));
      const picture = Option.getOrUndefined(Option.flatMap(image, Result.getSuccess));

      const missing = [
        ...Option.toArray(Option.flatMap(outline, Result.getFailure)),
        ...Option.toArray(Option.flatMap(image, Result.getFailure)),
      ];

      const [first] = missing;

      if (snapshot === undefined && picture === undefined && first !== undefined)
        return yield* first;

      return [
        text(snapshot?.rendered ?? "Observation of the current viewport."),
        ...missing.map((error) => text(`(missing from this observation: ${error.message})`)),
        ...(picture === undefined
          ? []
          : [
              text(
                `Screenshot: ${picture.width}x${picture.height}. Its pixel coordinates are viewport coordinates.`,
              ),
              Prompt.makePart("file", { mediaType: picture.mediaType, data: picture.data }),
            ]),
      ];
    });

/** A run's tools: their definitions and handlers. `done` and `give_up` stay the agent's own. */
export interface ToolSet<T extends Record<string, Tool.Any>> {
  readonly toolkit: Toolkit.Toolkit<T>;
  readonly handlers: Toolkit.HandlersFrom<T>;
}

/** Tools a caller's set may hold: `done` and `give_up` end the run, so they remain the agent's. */
type CallerTools = Record<string, Tool.Any> & {
  readonly done?: never;
  readonly give_up?: never;
};

/**
 * Where the run acts: on one page, with tools pinned to it, or on a browser's tabs, which its tools
 * follow as `follow` says. `tools` makes the run's tools from the default ones, to remove, rename,
 * wrap or add tools.
 */
export type Where<T extends CallerTools> =
  | {
      readonly page: Page.Page;
      readonly browser?: undefined;
      readonly follow?: undefined;
      readonly tools?: ((defaults: Tools.Tools<Tools.PageTools>) => ToolSet<T>) | undefined;
    }
  | {
      readonly browser: Browser.Service;
      readonly follow?: Tools.Follow | undefined;
      readonly page?: undefined;
      readonly tools?: ((defaults: Tools.Tools<Tools.BrowserTools>) => ToolSet<T>) | undefined;
    };

export interface Options<E = never, R = never> {
  /** Model calls before stopping with `StepLimit`. Defaults to 30. */
  readonly maxSteps?: number | undefined;
  /** Pictures kept in the conversation. Defaults to 3. */
  readonly keepPictures?: number | undefined;
  /** What the model sees of the page. Defaults to `observe("both")`. */
  readonly observe?: Observe<R> | undefined;
  /** The system prompt, from the standard one, to add a site's rules to it or replace it. */
  readonly system?: ((standard: string) => string) | undefined;
  /**
   * Runs after every model call. Failing stops the run with that error, such as a spent budget.
   * The services it needs become the run's requirements.
   */
  readonly onStep?: ((step: Step) => Effect.Effect<void, E, R>) | undefined;
}

const standard = [
  "You operate a web browser through tools to complete the user's task.",
  "",
  "Seeing the page:",
  "- browser_snapshot gives a text outline of the viewport. Controls carry refs such as e12 for the other tools. Refs from an old snapshot can be stale.",
  "- The observation after each turn shows the viewport as an outline, a picture, or both. The full screenshot uses viewport coordinates: use x and y for anything without a ref, such as a canvas game, a chart or a video.",
  "- browser_zoom crops a small viewport region and shows it on its own after the batch, at the viewport's own CSS pixel scale: a closer look, not a magnification. Its caption gives the viewport origin; keep using viewport coordinates for clicks.",
  "- Tool calls return receipts of what they did and what followed. One fresh observation follows the whole batch.",
  "",
  "Acting:",
  "- Prefer refs when an outline is available. Use x and y for what the outline cannot show.",
  "- Batch two or more predictable steps in one turn. Calls run in order and stop at the first failure; remaining calls are not executed. Coordinates in a batch refer to the observation before it.",
  "- If an action fails and says it may have taken effect, look at the page before you repeat it.",
  "- The input policy decides for the user. When it refuses an action, do not try another way to the same effect. Three refusals in a row end the task.",
  "- Work on your own. Do not ask the user anything; if something blocks you, try another way.",
  "- When the task is done, call done with the answer. If it cannot be done, call give_up with the reason.",
].join("\n");

const isPicture = (part: Prompt.UserMessagePart) =>
  part.type === "file" && part.mediaType.startsWith("image/");

/** Prune older pictures in groups while keeping every picture in the current observation. */
const prunePictures = (prompt: Prompt.Prompt, keep: number): Prompt.Prompt => {
  const total = prompt.content.reduce(
    (count, message) =>
      count + (message.role === "user" ? message.content.filter(isPicture).length : 0),
    0,
  );

  const current = prompt.content.at(-1);
  const latest = current?.role === "user" ? current.content.filter(isPicture).length : 0;

  // All pictures from this observation must reach the model at least once, including requested crops.
  const retain = Math.max(keep, latest);

  if (total <= Math.max(retain * 2, 1)) return prompt;
  let remove = total - retain;

  return Prompt.fromMessages(
    prompt.content.map((message) => {
      if (message.role !== "user" || remove === 0 || !message.content.some(isPicture))
        return message;

      return Prompt.makeMessage("user", {
        content: message.content.map((part) => {
          if (remove === 0 || !isPicture(part)) return part;
          remove -= 1;

          return text("(an earlier screenshot was removed)");
        }),
      });
    }),
  );
};

/**
 * Model output that could not be read: `effect/ai`'s decoding of the response, which fails on a
 * call to a tool that does not exist, or an adapter's parsing of a call's arguments. Both happen
 * before any handler runs, and the batch answers every handler failure as a result, so nothing
 * in such a response ran and the chat leaves its history unchanged. A provider client that cannot
 * decode what its service sent is not the model's to correct: that failure ends the run.
 */
const isUnreadable = (
  error: unknown,
): error is AiError.AiError & {
  readonly reason: AiError.InvalidOutputError | AiError.ToolParameterValidationError;
} =>
  AiError.isAiError(error) &&
  ((error.reason._tag === "InvalidOutputError" &&
    error.module === "LanguageModel" &&
    error.method === "generateText") ||
    (error.reason._tag === "ToolParameterValidationError" && error.module !== "Toolkit"));

/** What the model is told about a response that could not be read. */
const unreadable = (
  reason: AiError.InvalidOutputError | AiError.ToolParameterValidationError,
  tools: ReadonlyArray<string>,
) =>
  reason._tag === "ToolParameterValidationError"
    ? `Your call to ${reason.toolName} could not be read, so none of your last response's tool ` +
      `calls ran: ${reason.description}. Send each call's arguments as one JSON object.`
    : "Your last response could not be read, so none of its tool calls ran. It most likely " +
      `called a tool that does not exist. The tools are: ${tools.join(", ")}.`;

const note = (value: string) => Prompt.makeMessage("user", { content: [text(value)] });

/**
 * A crop as the model sees it, with its caption. Tools that follow tabs name its tab by its number
 * in their list, as `browser_tabs` does.
 */
const zoomed = (zoom: Page.Zoom, tabs: ReadonlyArray<Page.Page> | undefined) => {
  const tab = (tabs ?? []).findIndex((page) => page.id === zoom.page) + 1;

  const from =
    tabs === undefined ? "" : tab === 0 ? " from a tab since closed" : ` from tab ${tab}`;

  return [
    text(
      `Zoom${from}: viewport origin (${zoom.region.x}, ${zoom.region.y}), ${zoom.region.width}x${zoom.region.height} CSS pixels. Captured when browser_zoom ran. Add this origin to image coordinates for viewport clicks.`,
    ),
    Prompt.makePart("file", { mediaType: zoom.image.mediaType, data: zoom.image.data }),
  ];
};

/** At most this many crops follow a batch. */
const maxZooms = 8;

const isReceipt = Schema.is(Receipt);
const isBrowserError = Schema.is(BrowserError);

/** The input policy's refusals, which three in a row end a run. */
const refusing = new Set(["PolicyDenied", "PolicyTimeout"]);

/** Each browser tool's kind: a successful `"act"` is one the policy allowed, ending a run of refusals. */
const kinds = new Map<string, string>(
  Object.values(operations).map(({ name, kind }) => [name, kind]),
);

/** Token counts as OpenTelemetry's GenAI usage attributes. */
const tokens = (usage: Usage.Usage) => ({
  "gen_ai.usage.input_tokens": usage.inputTokens,
  "gen_ai.usage.output_tokens": usage.outputTokens,
});

/**
 * What the model sees of the page, and the crops it asked for, as one message, if any. A failure
 * to see the page is told, unless the browser is gone, or the page with tools pinned to it: more
 * model calls cannot help.
 */
const observed = <R>(
  current: Effect.Effect<Page.Page, BrowserError>,
  look: Observe<R>,
  browser: Browser.Service | undefined,
  zooms: ReadonlyArray<Page.Zoom>,
) =>
  Effect.gen(function* () {
    const seen = yield* current.pipe(
      Effect.flatMap(look),
      Effect.catchIf(
        (error) => {
          const { lost } = consequence(error);

          return lost === "nothing" || (lost === "page" && browser !== undefined);
        },
        (error) => Effect.succeed([text(`(the page could not be observed: ${error.message})`)]),
      ),
    );

    const tabs = browser === undefined ? undefined : yield* browser.pages;
    const more = zooms.length - maxZooms;

    const content = [
      ...seen,
      ...zooms.slice(0, maxZooms).flatMap((zoom) => zoomed(zoom, tabs)),
      ...(more > 0 ? [text(`(${more} more crops are not shown: at most 8 follow a batch)`)] : []),
    ];

    return content.length === 0 ? [] : [Prompt.makeMessage("user", { content })];
  });

/** The run itself, on the page its default tools act on, with the set made from them. */
const steps = <E, R, S extends Record<string, Tool.Any>>(
  answerSchema: Schema.Codec<unknown, unknown>,
  task: string,
  options: Options<E, R> & { readonly browser?: Browser.Service | undefined },
  current: Effect.Effect<Page.Page, BrowserError>,
  chosen: ToolSet<S>,
) =>
  Effect.gen(function* () {
    const { browser } = options;
    const maxSteps = options.maxSteps ?? 30;
    const keepPictures = options.keepPictures ?? 3;
    const look = options.observe ?? observe();

    const outcome = yield* Ref.make(
      Option.none<{ readonly answer: unknown } | { readonly reason: string }>(),
    );

    const Completion = completion(answerSchema);

    const completed = yield* Completion.toHandlers({
      done: ({ answer }) => Ref.set(outcome, Option.some({ answer })).pipe(Effect.as("Done.")),
      give_up: ({ reason }) =>
        Ref.set(outcome, Option.some({ reason })).pipe(Effect.as("Stopped.")),
    });

    const handled = yield* chosen.toolkit.toHandlers(chosen.handlers);

    // Merged last, completion stays the agent's even when the types are bypassed.
    const toolkit = yield* Toolkit.merge(chosen.toolkit, Completion).pipe(
      Effect.provideContext(Context.merge(handled, completed)),
    );

    const observation = (zooms: ReadonlyArray<Page.Zoom>) =>
      observed(current, look, browser, zooms);

    const chat = yield* Chat.fromPrompt([
      { role: "system", content: options.system?.(standard) ?? standard },
      { role: "user", content: task },
      ...(yield* observation([])),
    ]);

    let next: Array<Prompt.Message> = [];
    let usage = Usage.empty;
    let idle = 0;
    // Why the input policy refused each action since the last action it decides on went through.
    let refusals: ReadonlyArray<string> = [];

    const failed = (reason: AgentError["reason"], step: number) =>
      Effect.flatMap(Ref.get(chat.history), (history) =>
        Effect.fail(new AgentError({ reason, steps: step, usage, history })),
      );

    /** The observation after a turn, added to the conversation, pruning older pictures. */
    const showPage = (zooms: ReadonlyArray<Page.Zoom>) =>
      Effect.flatMap(observation(zooms), (observed) =>
        Ref.update(chat.history, (history) =>
          prunePictures(Prompt.concat(history, observed), keepPictures),
        ),
      );

    /** One model call, its tool calls and the observation after them; the result if it ends. */
    const takeStep = (step: number) =>
      Effect.gen(function* () {
        const response = yield* chat
          .generateText({
            prompt: Prompt.fromMessages(next),
            ...(yield* Tools.batch(toolkit, { endsBatch: ["done", "give_up"] })),
          })
          .pipe(
            Effect.map((turn) => ({ turn })),
            Effect.catchIf(isUnreadable, (error) => Effect.succeed({ rejected: error.reason })),
          );

        if ("rejected" in response) {
          yield* Effect.annotateCurrentSpan("rejected", true);
          if (options.onStep !== undefined) {
            yield* options.onStep({
              step,
              text: "",
              calls: [],
              results: [],
              usage: Usage.empty,
              rejected: response.rejected.description,
            });
          }
          yield* showPage([]);
          idle = 0;
          next = [note(unreadable(response.rejected, Object.keys(toolkit.tools)))];

          return Option.none<Result<unknown>>();
        }
        const { turn } = response;
        const stepUsage = Usage.add(Usage.empty, turn.usage);

        const results = turn.toolResults.map(({ name, result, isFailure }) => ({
          name,
          result,
          isFailure,
        }));

        usage = Usage.add(usage, turn.usage);
        yield* Effect.annotateCurrentSpan({
          toolCalls: turn.toolCalls.length,
          ...tokens(stepUsage),
        });
        // The paid turn is reported, and its answer kept, before the page is looked at again.
        if (options.onStep !== undefined) {
          yield* options.onStep({
            step,
            text: turn.text,
            calls: turn.toolCalls.map((call) => ({ name: call.name, params: call.params })),
            results,
            usage: stepUsage,
          });
        }
        const finished = yield* Ref.get(outcome);

        if (Option.isSome(finished)) {
          if ("reason" in finished.value)
            return yield* failed(new GaveUp({ reason: finished.value.reason }), step);

          return Option.some<Result<unknown>>({
            answer: finished.value.answer,
            steps: step,
            usage,
            history: yield* Ref.get(chat.history),
          });
        }
        for (const { name, result, isFailure } of results)
          if (isFailure && isBrowserError(result) && refusing.has(result.reason._tag))
            refusals = [...refusals, result.reason.message];
          else if (!isFailure && kinds.get(name) === "act") refusals = [];
        yield* showPage(
          results.flatMap(({ result }) =>
            isReceipt(result) && result.zoom !== undefined ? [result.zoom] : [],
          ),
        );

        // With nobody to ask, an agent that keeps meeting refusals stops rather than probing for
        // a way around them.
        if (refusals.length >= 3) return yield* failed(new Refused({ refusals }), step);

        if (turn.toolCalls.length === 0) {
          idle += 1;
          if (idle >= 3)
            return yield* failed(
              new GaveUp({ reason: `stopped calling tools: ${turn.text}` }),
              step,
            );
          next = [note("Continue with the tools, or call done with the answer.")];

          return Option.none<Result<unknown>>();
        }
        idle = 0;
        next = [];

        return Option.none<Result<unknown>>();
      }).pipe(
        Effect.withSpan("Agent.step", { attributes: { step } }, { captureStackTrace: false }),
      );

    for (let step = 1; step <= maxSteps; step++) {
      const ended = yield* takeStep(step);

      if (Option.isSome(ended)) return ended.value;
    }

    return yield* failed(new StepLimit({ steps: maxSteps }), maxSteps);
  });

/** The run on its page or browser, with its default tools or the set made from them. */
const loop = <E, R, T extends CallerTools>(
  answer: Schema.Codec<unknown, unknown>,
  task: string,
  options: Options<E, R> & Where<T>,
) =>
  Effect.gen(function* () {
    if (options.page !== undefined) {
      const defaults = yield* Tools.make({ page: options.page });

      return yield* options.tools === undefined
        ? steps(answer, task, options, defaults.page, defaults)
        : steps(answer, task, options, defaults.page, options.tools(defaults));
    }
    const defaults = yield* Tools.make({ browser: options.browser, follow: options.follow });

    return yield* options.tools === undefined
      ? steps(answer, task, options, defaults.page, defaults)
      : steps(answer, task, options, defaults.page, options.tools(defaults));
  });

/**
 * What a caller's tools need: their handlers' services, and those their schemas use. A set whose
 * types were bypassed leaves `T` as `CallerTools` itself, and adds nothing.
 */
type ToolServices<T extends CallerTools> = string extends keyof T
  ? never
  :
      | Tool.HandlerServices<T[keyof T]>
      | Tool.ParametersEncodingServices<T[keyof T]>
      | Tool.ResultDecodingServices<T[keyof T]>;

/**
 * Run a task to its end, with an answer of the given shape.
 *
 * It fails with how the agent ended (`AgentError`), the model's provider, the browser, or
 * `onStep`; a tool's failure goes back to the model as a result.
 */
export function run<A, I, E = never, R = never, T extends CallerTools = {}>(
  task: string,
  options: Options<E, R> & Where<T> & { readonly answer: Schema.Codec<A, I> },
): Effect.Effect<
  Result<A>,
  AgentError | AiError.AiError | BrowserError | E,
  LanguageModel.LanguageModel | ToolServices<T> | R
>;

/** Run a task to its end. The answer is a string. */
export function run<E = never, R = never, T extends CallerTools = {}>(
  task: string,
  options: Options<E, R> & Where<T>,
): Effect.Effect<
  Result<string>,
  AgentError | AiError.AiError | BrowserError | E,
  LanguageModel.LanguageModel | ToolServices<T> | R
>;

export function run<E, R, T extends CallerTools>(
  task: string,
  options: Options<E, R> & Where<T> & { readonly answer?: Schema.Codec<unknown, unknown> },
) {
  return loop(options.answer ?? Schema.String, task, options).pipe(
    Effect.tap((result) =>
      Effect.annotateCurrentSpan({ steps: result.steps, ...tokens(result.usage) }),
    ),
    Effect.provideService(Policy.Task, task),
    // Each step is a child span: its model call, its tool calls and the observation after them.
    Effect.withSpan("Agent.run", {
      attributes: { "gen_ai.operation.name": "invoke_agent", maxSteps: options.maxSteps ?? 30 },
    }),
  );
}
