/**
 * effect-browser pages as Yielded Agent's browser ports: `BrowserActions`, which observes a page and
 * acts on the refs it observed, and `BrowserControl`, which inspects, navigates, scrolls, waits,
 * takes screenshots, presses keys and selects tabs. `BrowserUse.make()` and
 * `BrowserUse.browserTools` give a model tools over them, and so does `BrowserTools`, with this
 * package's own.
 *
 * Over a `page`, the ports are pinned to it: they list no tabs, and a tab the page opens stays where
 * it is. Over a `browser`, they act on the tab the model last saw and list the others as tabs it may
 * select. A tab an action opens is shown at the next look as `follow` says: `"select"`, the
 * default, makes it current without bringing it to front, so the page on air and an operator's
 * view stay where they are; `"front"` also brings it to front; `"never"` keeps the current tab.
 *
 * An observation is the page's outline, with a ref on each control, and the controls as values. One
 * after an action begins with what followed it: a dialog and how the browser answered it, a
 * navigation, a tab it opened and what its input visibly changed. Every action goes through the
 * page's own input policy, with `task` as the user's task its judge reads, and the browser answers
 * dialogs itself, so `respondDialog` refuses. An action that failed before its input reached the
 * browser is `not-dispatched`, one that failed after is `unknown`, and nothing is ever retried.
 *
 * @since 0.3.0
 */
import { BrowserUse } from "@yielded/agent";
import { Context, Effect, Layer, Option, Result } from "effect";
import type * as Browser from "effect-browser/Browser";
import type { BrowserError } from "effect-browser/BrowserError";
import type * as Page from "effect-browser/Page";
import * as Policy from "effect-browser/Policy";
import type { Snapshot } from "effect-browser/Snapshot";

import { destination, followed, told } from "./internal/receipts.ts";

type Observation = typeof BrowserUse.Observation.Type;

type ActionResult = typeof BrowserUse.ActionResult.Type;

type Dispatch = "not-dispatched" | "acknowledged" | "unknown";

/** What the ports do when a tab opens: see the module's comment. */
export type Follow = "select" | "front" | "never";

/** What the ports act on: one page, or a browser's tabs. */
export type Target =
  | { readonly page: Page.Page }
  | { readonly browser: Browser.Service; readonly follow?: Follow | undefined };

export interface Options {
  /** The user's task, which the input policy's judge reads as what authorizes a risky input. */
  readonly task?: string | undefined;
  /** Bound on an observation's outline, in characters. Defaults to 8,000. */
  readonly maxChars?: number | undefined;
  /** Bound on a condition wait. Defaults to 5,000 ms; an unmet wait returns the page as it is. */
  readonly maxWaitMillis?: number | undefined;
}

/** The ports, and the tab they act on, which `BrowserTools` shares. */
export interface Controller {
  readonly actions: BrowserUse.BrowserActions["Service"];
  readonly control: BrowserUse.BrowserControl["Service"];
  /** The tab calls act on now: the pinned page, or the one the model last saw. */
  readonly current: Effect.Effect<Page.Page, BrowserError>;
  /** Run `run` on the current tab with the task, and say what followed it there. */
  readonly perform: <A>(
    run: (page: Page.Page) => Effect.Effect<A, BrowserError>,
  ) => Effect.Effect<{ readonly value: A; readonly followed: ReadonlyArray<string> }, BrowserError>;
  /** Give `effect` the run's task, for the input policy's judge. */
  readonly withTask: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

/** A failure as the ports report it: what happened and what it leaves, and whether input went. */
export const useError = (error: BrowserError) =>
  new BrowserUse.BrowserUseError({
    code: error.reason._tag === "InvalidRequest" ? "invalid" : "browser",
    message: told(error),
    dispatch: dispatchOf(error),
  });

const dispatchOf = (error: BrowserError): Dispatch =>
  error.dispatched ? "unknown" : "not-dispatched";

const invalid = (message: string) =>
  Effect.fail(new BrowserUse.BrowserUseError({ code: "invalid", message }));

/** A snapshot as the ports' observation: the outline, the controls and where the page is. */
const observation = (
  snapshot: Snapshot,
  extra: { readonly followed?: ReadonlyArray<string>; readonly tabs?: Observation["tabs"] },
): Observation => ({
  text: [...(extra.followed ?? []), snapshot.rendered].join("\n"),
  // The ports' controls leave out what a control does not have, rather than state it undefined.
  controls: snapshot.controls.map((control) => ({
    ref: control.ref,
    kind: control.kind,
    name: control.name,
    value: control.value,
    options: control.options ?? [],
    ...(control.optionCount === undefined ? {} : { optionCount: control.optionCount }),
    ...(control.disabled === undefined ? {} : { disabled: control.disabled }),
    ...(control.checked === undefined ? {} : { checked: control.checked }),
    ...(control.editable === undefined ? {} : { editable: control.editable }),
  })),
  page: {
    title: snapshot.title,
    scrollY: snapshot.scroll.y,
    viewportHeight: snapshot.viewport.height,
    documentHeight: snapshot.scroll.height,
  },
  truncated: snapshot.truncated,
  ...(extra.tabs === undefined ? {} : { tabs: extra.tabs }),
});

/** The tabs a browser's ports follow: which one is current, and a stable ref for each. */
const following = (browser: Browser.Service, follow: Follow) =>
  Effect.gen(function* () {
    let shown: Page.Page | undefined;
    const seen = new Set((yield* browser.pages).map((tab) => tab.id));
    const refs = new Map<string, string>();

    const refOf = (tab: Page.Page) => {
      const known = refs.get(tab.id);

      if (known !== undefined) return known;
      const ref = `tab${refs.size + 1}`;

      refs.set(tab.id, ref);

      return ref;
    };

    const become = (tab: Page.Page) =>
      Effect.gen(function* () {
        // Bringing a tab to front is for whoever watches it; the ports act on it either way.
        if (follow === "front" && shown !== undefined && tab.id !== shown.id)
          yield* tab.bringToFront.pipe(Effect.ignore);
        shown = tab;

        return tab;
      });

    // A look follows the newest tab opened since the last, unless told never to; a tab that has
    // gone gives way to the first one open.
    const look = Effect.gen(function* () {
      const open = yield* browser.pages;
      const newest = open.filter((tab) => !seen.has(tab.id)).at(-1);

      for (const tab of open) seen.add(tab.id);

      return yield* become(
        follow !== "never" && newest !== undefined
          ? newest
          : (open.find((tab) => tab.id === shown?.id) ?? (yield* browser.firstPage)),
      );
    });

    const tabs = Effect.gen(function* () {
      const open = yield* browser.pages;

      return yield* Effect.forEach(open, (tab) =>
        Effect.map(tab.url, (url) => ({
          ref: refOf(tab),
          url: url.startsWith("data:") ? "data:" : url,
          active: tab.id === shown?.id,
        })),
      );
    });

    const select = (ref: string) =>
      Effect.gen(function* () {
        const tab = (yield* browser.pages).find((open) => refs.get(open.id) === ref);

        if (tab === undefined) return Option.none<Page.Page>();
        seen.add(tab.id);

        return Option.some(yield* become(tab));
      });

    return {
      current: Effect.suspend(() => (shown === undefined ? look : Effect.succeed(shown))),
      look,
      tabs,
      select,
    };
  });

/** What the ports share: the tab they act on, how they read it, and the run's task. */
interface Session {
  readonly current: Effect.Effect<Page.Page, BrowserError>;
  /** The current tab, following a tab an action opened; the pinned page is always the one. */
  readonly look: Effect.Effect<Page.Page, BrowserError>;
  readonly read: (
    page: Page.Page,
    within?: string,
    lines?: ReadonlyArray<string>,
  ) => Effect.Effect<Observation, BrowserError>;
  readonly tabs: Effect.Success<ReturnType<typeof following>> | undefined;
  readonly withTask: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly maxWait: number;
}

const session = Effect.fnUntraced(function* (target: Target, options: Options) {
  const maxChars = options.maxChars ?? 8000;

  // A look follows a tab an action opened; the pinned page is always the one.
  const { current, look, tabs } =
    "page" in target
      ? { current: Effect.succeed(target.page), look: Effect.succeed(target.page), tabs: undefined }
      : yield* Effect.map(following(target.browser, target.follow ?? "select"), (followed) => ({
          current: followed.current,
          look: followed.look,
          tabs: followed,
        }));

  // The pages whose changes are recorded, from their first look, so the receipt of the first
  // action on one can say what it changed. Starting a record is a convenience: a page that could
  // not start one says so in the receipt that reads it.
  const recording = new Set<string>();

  const record = (page: Page.Page) =>
    recording.has(page.id)
      ? Effect.void
      : page
          .changes()
          .pipe(Effect.andThen(Effect.sync(() => recording.add(page.id))), Effect.ignore);

  const read = (page: Page.Page, within?: string, lines: ReadonlyArray<string> = []) =>
    Effect.all([page.snapshot({ maxChars, within }), tabs?.tabs ?? Effect.void, record(page)], {
      concurrency: "unbounded",
    }).pipe(
      Effect.map(([snapshot, open]) =>
        observation(snapshot, { followed: lines, tabs: open === undefined ? undefined : open }),
      ),
    );

  return {
    current,
    look,
    read,
    tabs,
    withTask: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      options.task === undefined
        ? effect
        : Effect.provideService(effect, Policy.Task, options.task),
    maxWait: options.maxWaitMillis ?? 5000,
  } satisfies Session;
});

/**
 * Run actions in order on the current tab, stopping at the first failure, then look at the page,
 * which follows a tab they opened. Acknowledged actions are counted even if the look fails.
 */
const acting =
  ({ current, look, read, withTask }: Session) =>
  (
    steps: ReadonlyArray<(page: Page.Page) => Effect.Effect<unknown, BrowserError>>,
    observe: boolean,
  ): Effect.Effect<ActionResult, BrowserUse.BrowserUseError> =>
    Effect.gen(function* () {
      const page = yield* current;
      const since = (yield* page.state).at;
      let completed = 0;
      let failure: BrowserError | undefined;

      for (const step of steps) {
        const done = yield* Effect.result(step(page));

        if (Result.isFailure(done)) {
          failure = done.failure;
          break;
        }
        completed += 1;
      }
      const dispatch: Dispatch = failure === undefined ? "acknowledged" : dispatchOf(failure);
      const lines = yield* followed(page, since);
      const error = failure === undefined ? null : told(failure);

      if (!observe) return { completed, error, observation: null, dispatch };

      const seen = yield* Effect.result(
        Effect.flatMap(look, (next) => read(next, undefined, lines)),
      );

      return {
        completed,
        error:
          error ??
          (Result.isFailure(seen)
            ? `Done, but the page could not be read after it: ${told(seen.failure)}`
            : null),
        observation: Result.getOrNull(seen),
        dispatch,
      };
    }).pipe(Effect.mapError(useError), withTask);

const action = (step: BrowserUse.Action) => (page: Page.Page) => {
  switch (step.kind) {
    case "click":
      return page.click(step.ref);
    case "fill":
      return page.type(step.value, { into: step.ref });
    case "select":
      return page.select(step.ref, [step.value]);
  }
};

const frameless = (operation: string) =>
  invalid(`Frames are read inline here and none is listed: ${operation} without frame.`);

/** A condition wait, ending at the run's bound with the page as it is. */
const waiting =
  ({ current, read, withTask, maxWait }: Session) =>
  (request: typeof BrowserUse.WaitRequest.Type) => {
    if (request.frame !== undefined) return frameless("wait");
    if (request.state === "text" && request.text === undefined)
      return invalid("A wait for text needs the text.");
    const millis = Math.min(request.timeoutMillis, maxWait);
    const state = request.state === "text" ? "visible" : request.state;

    return Effect.gen(function* () {
      const page = yield* current;

      const met = yield* page
        .waitFor({ selector: request.selector, text: request.text, state }, millis)
        .pipe(
          Effect.as(true),
          Effect.catchIf(
            (error) => error.reason._tag === "Timeout",
            () => Effect.succeed(false),
          ),
        );

      return yield* read(page, undefined, met ? [] : [`The wait ended after ${millis} ms unmet.`]);
    }).pipe(Effect.mapError(useError), withTask);
  };

/** `BrowserControl` over the session's current tab. */
const controlling = (context: Session) => {
  const { current, look, read, tabs, withTask } = context;
  const act = acting(context);

  return BrowserUse.BrowserControl.of({
    inspect: ({ selector, frame, optionFilter }) =>
      frame !== undefined
        ? frameless("inspect")
        : Effect.flatMap(look, (page) => read(page, selector)).pipe(
            Effect.map((seen) =>
              optionFilter === undefined ? seen : filterOptions(seen, optionFilter),
            ),
            Effect.mapError(useError),
            withTask,
          ),
    navigate: ({ url }) =>
      act(
        [(page) => Effect.flatMap(destination("navigate", url), (address) => page.goto(address))],
        true,
      ),
    scroll: ({ ref, deltaX, deltaY }) =>
      act([(page) => page.scroll({ at: ref, dx: deltaX, dy: deltaY })], true),
    wait: waiting(context),
    screenshot: Effect.flatMap(current, (page) => page.screenshot({ format: "png" })).pipe(
      Effect.map((image) => ({
        mediaType: "image/png" as const,
        base64: Buffer.from(image.data).toString("base64"),
      })),
      Effect.mapError(useError),
    ),
    press: ({ ref, key }) => act([(page) => page.press(key, { on: ref })], true),
    selectTab: ({ ref }) =>
      tabs === undefined
        ? invalid("These tools are pinned to one tab.")
        : tabs.select(ref).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => invalid(`${ref} is not an open tab; observe for the current tabs.`),
                onSome: (page) => read(page).pipe(Effect.mapError(useError)),
              }),
            ),
            withTask,
          ),
    respondDialog: () =>
      invalid(
        "No dialog is open: the browser answers dialogs itself, and the observation after an action says how it answered each.",
      ),
  });
};

/** The ports over `target`, and the tab they act on. */
export const make = Effect.fnUntraced(function* (target: Target, options: Options = {}) {
  const context = yield* session(target, options);
  const { current, look, read, withTask } = context;
  const act = acting(context);

  const actions = BrowserUse.BrowserActions.of({
    observe: Effect.flatMap(look, (page) => read(page)).pipe(Effect.mapError(useError), withTask),
    act: (steps, actOptions = {}) => act(steps.map(action), actOptions.observe ?? true),
  });

  const perform = <A>(run: (page: Page.Page) => Effect.Effect<A, BrowserError>) =>
    Effect.gen(function* () {
      const page = yield* current;
      const since = (yield* page.state).at;
      const value = yield* run(page);

      return { value, followed: yield* followed(page, since) };
    }).pipe(withTask);

  return {
    actions,
    control: controlling(context),
    current,
    perform,
    withTask,
  } satisfies Controller;
});

/** A select's options narrowed to those whose label holds `filter`, keeping its chosen value. */
const filterOptions = (seen: Observation, filter: string): Observation => {
  const wanted = filter.toLowerCase();

  return {
    ...seen,
    controls: seen.controls.map((control) =>
      control.options.length === 0
        ? control
        : {
            ...control,
            options: control.options.filter(
              (option) => option.toLowerCase().includes(wanted) || option === control.value,
            ),
          },
    ),
  };
};

/** `BrowserActions` and `BrowserControl` over `target`, for `BrowserUse`'s own tools. */
export const layer = (
  target: Target,
  options: Options = {},
): Layer.Layer<BrowserUse.BrowserActions | BrowserUse.BrowserControl> =>
  Layer.effectContext(
    Effect.map(make(target, options), ({ actions, control }) =>
      Context.make(BrowserUse.BrowserActions, actions).pipe(
        Context.add(BrowserUse.BrowserControl, control),
      ),
    ),
  );
