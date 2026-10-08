/**
 * Browser tools for any `effect/ai` language model, bound to one page or following a browser's
 * tabs.
 *
 * The model reads a page two ways. A snapshot is a text outline whose controls carry refs such as
 * `e12`. A screenshot is a picture whose pixel coordinates are viewport coordinates. It acts by
 * ref when a control has one, and by point when it does not, as on a canvas game or a chart. Each
 * call answers with a `Receipt`: what it did and, for an action, what followed on its page while
 * it ran: a dialog and how it was answered, a navigation, a tab it opened and what visibly
 * changed. The model is told it as text; the caller reads it as a value.
 *
 * `make({ page })` pins the tools to one page. `make({ browser, follow })` offers `browser_tabs`
 * too, and acts on the tab the model last saw: when a tab opens, the next look shows it as
 * `follow` says. `"select"`, the default, makes it current without bringing it to front, so the
 * page on air and an operator's view stay where they are; `"front"` also brings it to front;
 * `"never"` keeps the current tab.
 *
 * A turn's calls run as a `batch`: in order, stopping at the first failure. `Agent` does that and
 * observes the page after each turn; a caller composing its own loop spreads a fresh `batch` into
 * each model call, then observes `page`, with the crops the receipts of `browser_zoom` hold.
 *
 * Each page operation is one contract: its parameters, its receipt and `BrowserError` as schemas,
 * and one handler. The tools, `on(page)`'s methods and the RPC group `PageRpcs` are projections of
 * it, so a consumer serves a page's operations to another process with
 * `PageRpcs.toLayer(Tools.on(page))`, and they answer there with the same receipts.
 *
 * @since 0.3.0
 */
import { Cause, Context, Effect, Option, Ref, Result, Schema, Stream } from "effect";
import { Tool, Toolkit } from "effect/ai";

import type * as Browser from "./Browser.ts";
import { type BrowserError, InvalidRequest } from "./BrowserError.ts";
import * as Operations from "./internal/agent/operations.ts";
import { BrowserToolkit, PageToolkit } from "./internal/agent/projection.ts";
import { undispatched } from "./internal/page/context.ts";
import * as Page from "./Page.ts";

export { Receipt } from "./internal/agent/operations.ts";
export { BrowserToolkit, PageRpcs, PageToolkit } from "./internal/agent/projection.ts";

/** The tools of one page. */
export type PageTools = typeof PageToolkit.tools;

/** The tools of a browser's tabs: a page's, and `browser_tabs`. */
export type BrowserTools = typeof BrowserToolkit.tools;

/** What tools that follow a browser do when a tab opens: see the module's comment. */
export type Follow = "select" | "front" | "never";

/**
 * The page operations bound to `page`, each answering with its receipt: to call one directly, or
 * to serve them to another process as `PageRpcs`' handlers.
 */
export const on = (page: Page.Page) => Operations.bind((_, run) => run(page));

/**
 * Options for one `generateText` call, from `LanguageModel` or `Chat`: spread them into the call.
 * `effect/ai` runs a response's tool calls concurrently unless `concurrency` is 1, so the toolkit
 * and that setting travel together.
 */
export interface Batch<T extends Record<string, Tool.Any>> {
  readonly toolkit: Toolkit.WithHandler<T>;
  readonly concurrency: 1;
}

/**
 * One turn of tool calls over a toolkit with handlers. Calls run one at a time in the order the
 * model made them. The first failure, or a successful call named in `endsBatch`, stops the batch:
 * every later call answers as not executed. Build a new batch for each turn.
 *
 * Each call, run or not, is a span of its own, `Tools.<name>`, with OpenTelemetry's GenAI tool
 * attributes. It keeps a browser tool's parameters without the text it types, and only the names
 * of another tool's parameters, which may hold anything. The actions a call performs record its
 * call id as their `correlation`.
 */
export function batch<T extends Record<string, Tool.Any>>(
  toolkit: Toolkit.WithHandler<T>,
  options?: { readonly endsBatch?: ReadonlyArray<keyof T & string> | undefined },
): Effect.Effect<Batch<T>>;

export function batch<T extends Record<string, Tool.Any>>(
  toolkit: Toolkit.WithHandler<T>,
  options: { readonly endsBatch?: ReadonlyArray<keyof T & string> | undefined } = {},
) {
  const ends = new Set<string>(options.endsBatch ?? []);

  return Effect.map(Ref.make(Option.none<string>()), (halted) => ({
    concurrency: 1 as const,
    toolkit: {
      tools: toolkit.tools,
      // With concurrency 1, each call starts after the previous one's final result.
      handle: <Name extends keyof T>(
        name: Name,
        params: Tool.ParametersEncoded<T[Name]>,
        id?: string,
      ) =>
        Effect.map(Ref.get(halted), (halt) => {
          const tool = String(name);
          const kept = traced(tool, params);

          const call = Option.isSome(halt)
            ? Stream.succeed(failedResult("Not executed: " + halt.value)).pipe(
                Stream.tap(() => Effect.annotateCurrentSpan("executed", false)),
              )
            : toolkit.handle(name, params, id).pipe(
                // The handler runs in a fiber this forks, so its actions carry the call's id.
                id === undefined ? (handled) => handled : Page.correlate(id),
                // effect/ai puts the raw parameters on the span around the call, which is this one.
                Effect.ensuring(Effect.annotateCurrentSpan("parameters", kept)),
                Stream.unwrap,
                Stream.catchCause((cause) => failedCall(toolkit.tools[name], cause)),
                Stream.tap((result) =>
                  result.preliminary
                    ? Effect.void
                    : result.isFailure
                      ? Ref.set(halted, Option.some(`${tool} failed.`)).pipe(
                          Effect.andThen(Effect.annotateCurrentSpan("error.type", "tool_error")),
                        )
                      : ends.has(tool)
                        ? Ref.set(halted, Option.some(`${tool} ended the batch.`))
                        : Effect.void,
                ),
              );

          return call.pipe(
            Stream.withSpan(`Tools.${tool}`, {
              attributes: {
                "gen_ai.operation.name": "execute_tool",
                "gen_ai.tool.name": tool,
                "gen_ai.tool.type": "function",
                ...(id === undefined ? {} : { "gen_ai.tool.call.id": id }),
                parameters: kept,
              },
              captureStackTrace: false,
            }),
          );
        }),
    },
  }));
}

/** What a span keeps of a call's parameters: a browser tool's without typed text, else names. */
const traced = (tool: string, params: unknown): unknown =>
  typeof params !== "object" || params === null
    ? params
    : !Object.hasOwn(BrowserToolkit.tools, tool)
      ? Object.keys(params)
      : "text" in params
        ? { ...params, text: Page.redacted }
        : params;

const failedResult = (reason: string) => {
  const result: typeof Tool.ExecutionFailure.Type = { type: "execution-interrupted", reason };

  return { result, encodedResult: result, isFailure: true, preliminary: false };
};

/**
 * A tool with failure mode "error" fails its stream instead of returning a result. Answer it
 * with its failure encoded by the tool's own schema, saying whether the handler could have run:
 * rejected parameters never reach it. Defects and interruptions stay what they are.
 */
const failedCall = <Called extends Tool.Any, E>(tool: Called, cause: Cause.Cause<E>) => {
  const failure = Cause.findFail(cause);

  if (Result.isFailure(failure)) return Stream.failCause(failure.failure);
  const { error } = failure.success;

  const rejected =
    Context.get(Cause.reasonAnnotations(failure.success), Toolkit.FailureOrigin) === "parameters";

  return Stream.fromEffect(
    Schema.encodeUnknownEffect(Tool.failureResultSchema(tool))(error).pipe(
      Effect.map((encoded) => JSON.stringify(encoded)),
      // A failure outside the declared schema still reaches the model, unencoded.
      Effect.orElseSucceed(() => String(error)),
      Effect.map((detail) =>
        failedResult(
          (rejected
            ? "Not executed: its parameters are invalid: "
            : "The call failed and may have taken effect: ") + detail,
        ),
      ),
      Effect.tap(() => (rejected ? Effect.annotateCurrentSpan("executed", false) : Effect.void)),
    ),
  );
};

/** Each tool's handler, as the tools call it: from its parameters to its receipt or failure. */
export type Handlers<T extends Record<string, Tool.Any>> = {
  readonly [Name in keyof T]: (
    params: Tool.Parameters<T[Name]>,
  ) => Effect.Effect<Tool.Success<T[Name]>, Tool.Failure<T[Name]>>;
};

export interface Tools<T extends Record<string, Tool.Any>> {
  /** The tools, to give a model or to build a caller's own from. */
  readonly toolkit: Toolkit.Toolkit<T>;
  /** Each tool's handler, to wrap or rename in a caller's own tools. */
  readonly handlers: Handlers<T>;
  /** A fresh `batch` of the tools for one turn, to spread into a `generateText` call. */
  readonly batch: Effect.Effect<Batch<T>>;
  /**
   * The page to show the model after each batch: the tools' own, or the tab their calls act on
   * from then, following a tab opened since they last looked as `follow` says.
   */
  readonly page: Effect.Effect<Page.Page, BrowserError>;
}

/** Tools pinned to `page`: no `browser_tabs`, and a tab the page opens stays where it is. */
export function make(options: { readonly page: Page.Page }): Effect.Effect<Tools<PageTools>>;

/** Tools on `browser`'s current tab, beginning with its first, following tabs as `follow` says. */
export function make(options: {
  readonly browser: Browser.Service;
  readonly follow?: Follow | undefined;
}): Effect.Effect<Tools<BrowserTools>>;

export function make(
  options:
    | { readonly page: Page.Page }
    | { readonly browser: Browser.Service; readonly follow?: Follow | undefined },
): Effect.Effect<Tools<PageTools> | Tools<BrowserTools>> {
  if (!("page" in options)) return following(options.browser, options.follow);
  const handlers = on(options.page);

  return Effect.map(PageToolkit.pipe(Effect.provide(PageToolkit.toLayer(handlers))), (toolkit) => ({
    toolkit: PageToolkit,
    handlers,
    batch: batch(toolkit),
    page: Effect.succeed(options.page),
  }));
}

const refused = (name: string, detail: string) =>
  Effect.fail(undispatched(name.replace(/^browser_/, ""), new InvalidRequest({ detail })));

const following = Effect.fnUntraced(function* (
  browser: Browser.Service,
  follow: Follow = "select",
) {
  // The tab the model last saw, which calls act on; the tabs the tools had seen by then; and
  // whether `browser_tabs` switched tabs since, which actions wait to be seen.
  let shown: Page.Page | undefined;
  const seen = new Set((yield* browser.pages).map((tab) => tab.id));
  let switched = false;

  const become = (tab: Page.Page) =>
    Effect.gen(function* () {
      // Bringing a tab to front is for whoever watches it; the tools act on it either way.
      if (follow === "front" && shown !== undefined && tab.id !== shown.id)
        yield* tab.bringToFront.pipe(Effect.ignore);
      shown = tab;

      return tab;
    });

  // A look follows the newest tab opened since the last, unless told never to; a tab that has
  // gone gives way to the first one open.
  const page = Effect.gen(function* () {
    const open = yield* browser.pages;
    const newest = open.filter((tab) => !seen.has(tab.id)).at(-1);

    for (const tab of open) seen.add(tab.id);
    switched = false;

    return yield* become(
      follow !== "never" && newest !== undefined
        ? newest
        : (open.find((tab) => tab.id === shown?.id) ?? (yield* browser.firstPage)),
    );
  });

  // Refs restart on every tab and coordinates belong to its picture, so a call acts on the tab
  // the model last saw, and a tab that opens meanwhile waits for the next look. After
  // `browser_tabs` switches, reads see the new tab and actions wait until it is seen.
  const handlers = Operations.bind((operation, run) =>
    Effect.gen(function* () {
      if (switched && operation.kind !== "read")
        return yield* refused(operation.name, "browser_tabs switched tabs: look at the tab first");

      return yield* run(shown ?? (yield* page));
    }),
  );

  const describeTab = (tab: Page.Page) =>
    tab.title.pipe(
      Effect.map((title) => (title === "" ? "(untitled)" : title)),
      Effect.catch((error) => Effect.succeed(`(its title could not be read: ${error.message})`)),
      Effect.flatMap((title) => Effect.map(tab.url, (url) => `${title} — ${url}`)),
    );

  const tabs = ({ action, index, url }: typeof Operations.TabsInput.Type) =>
    Effect.gen(function* () {
      const chosen = index === undefined ? undefined : (yield* browser.pages)[index - 1];

      if (action === "new") {
        const tab = yield* url === undefined
          ? browser.newPage()
          : Effect.flatMap(Operations.destination("tabs", url), browser.newPage);

        seen.add(tab.id);
        yield* become(tab);
        switched = true;
      } else if (action === "select" || action === "close") {
        if (chosen === undefined)
          return yield* refused("browser_tabs", `there is no tab ${index ?? "(no index given)"}`);
        if (action === "close") {
          yield* chosen.close;
          if (chosen.id === shown?.id) shown = undefined;
        } else if (chosen.id !== shown?.id) {
          yield* become(chosen);
          switched = true;
        }
      }

      const lines = yield* Effect.forEach(yield* browser.pages, (tab, number) =>
        Effect.map(
          describeTab(tab),
          (where) => `${number + 1}. ${tab.id === shown?.id ? "[current] " : ""}${where}`,
        ),
      );

      return new Operations.Receipt({
        page: shown?.id ?? "",
        did: lines.join("\n"),
        dialogs: [],
        opened: [],
        missing: [],
      });
    });

  const all = { ...handlers, browser_tabs: tabs };
  const toolkit = yield* BrowserToolkit.pipe(Effect.provide(BrowserToolkit.toLayer(all)));

  return {
    toolkit: BrowserToolkit,
    handlers: all,
    batch: batch(toolkit),
    page,
  } satisfies Tools<BrowserTools>;
});
