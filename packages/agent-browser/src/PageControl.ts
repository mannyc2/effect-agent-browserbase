/**
 * effect-browser pages as the controller `BrowserTools` serves: `actions`, which observe a page and
 * act on the refs it observed, and `control`, which inspects, navigates, scrolls, waits, presses
 * keys and selects tabs. Their observations and results are this module's schemas. Yielded Agent
 * defined them as its `BrowserActions` and `BrowserControl` ports until 0.1.0-beta.174 replaced
 * those with Code Mode over CDP; they keep the shapes and failures they had there.
 *
 * Over a `page`, the controller is pinned to it: it lists no tabs, and a tab the page opens stays
 * where it is. Over a `browser`, it acts on the tab the model last saw and lists the others as tabs
 * it may select. A tab an action opens is shown at the next look as `follow` says: `"select"`, the
 * default, makes it current without bringing it to front, so the page on air and an operator's
 * view stay where they are; `"front"` also brings it to front; `"never"` keeps the current tab.
 *
 * An observation is the page's outline, with a ref on each control, and the controls as values. One
 * after an action begins with what followed it: a dialog and how the browser answered it, a
 * navigation, a tab it opened and what its input visibly changed. Every action goes through the
 * page's own input policy, with `task` as the user's task its judge reads, and the browser answers
 * dialogs itself. With `changes`, its outline holds only the lines that changed since the tab's last
 * whole look, when those are fewer. An action that failed before its input reached the browser is `not-dispatched`,
 * one that failed after is `possibly-dispatched`, and nothing is ever retried.
 *
 * @since 0.3.0
 */
import { BrowserUse } from "@yielded/agent";
import { Effect, Option, Result, Schema } from "effect";
import type * as Browser from "effect-browser/Browser";
import type { BrowserError } from "effect-browser/BrowserError";
import type * as Page from "effect-browser/Page";
import * as Policy from "effect-browser/Policy";
import { Snapshot } from "effect-browser/Snapshot";

import * as AdapterState from "./AdapterState.ts";
import { destination, followed, told } from "./internal/receipts.ts";

/** A control's ref in an observation, such as `e12`. */
export const Ref = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,50}$/));

/** An action on an observed control. */
export const Action = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("click"), ref: Ref }),
  Schema.Struct({
    kind: Schema.Literal("fill"),
    ref: Ref,
    value: Schema.String.check(Schema.isMaxLength(64 * 1024)),
  }),
  Schema.Struct({
    kind: Schema.Literal("select"),
    ref: Ref,
    value: Schema.String.check(Schema.isMaxLength(4_096)),
  }),
]);

export type Action = typeof Action.Type;

/** A control as an observation lists it. */
const Control = Schema.Struct({
  ref: Ref,
  kind: Schema.String,
  name: Schema.String,
  value: Schema.String,
  options: Schema.Array(Schema.String),
  optionCount: Schema.optionalKey(Schema.Natural),
  disabled: Schema.optionalKey(Schema.Boolean),
  checked: Schema.optionalKey(Schema.Boolean),
  editable: Schema.optionalKey(Schema.Boolean),
});

/** The page's outline and its controls, where the page is scrolled, and a browser's tabs. */
export const Observation = Schema.Struct({
  text: Schema.String,
  controls: Schema.Array(Control),
  page: Schema.Struct({
    title: Schema.String,
    scrollY: Schema.Finite,
    viewportHeight: Schema.Finite,
    documentHeight: Schema.Finite,
  }),
  truncated: Schema.Boolean,
  tabs: Schema.optionalKey(
    Schema.Array(Schema.Struct({ ref: Ref, url: Schema.String, active: Schema.Boolean })),
  ),
});

export type Observation = typeof Observation.Type;

const Dispatch = Schema.Literals(["not-dispatched", "acknowledged", "possibly-dispatched"]);

type Dispatch = typeof Dispatch.Type;

/**
 * What actions did: how many completed, the first one's failure, the page after them unless the
 * caller asked not to look, and whether the input reached the browser. Never replay an input
 * whose dispatch is not `not-dispatched`.
 */
export const ActionResult = Schema.Struct({
  completed: Schema.Natural,
  error: Schema.NullOr(Schema.String),
  observation: Schema.NullOr(Observation),
  dispatch: Dispatch,
});

export type ActionResult = typeof ActionResult.Type;

/** What `control.wait` waits for, as the `wait` tool takes it. */
interface WaitRequest {
  readonly selector: string;
  readonly frame?: string | undefined;
  readonly state: "visible" | "hidden" | "enabled" | "text";
  readonly text?: string | undefined;
  readonly timeoutMillis: number;
}

/** What the controller does when a tab opens: see the module's comment. */
export type Follow = "select" | "front" | "never";

/** What the controller acts on: one page, or a browser's tabs. */
export type Target =
  | { readonly page: Page.Page }
  | { readonly browser: Browser.Service; readonly follow?: Follow | undefined };

export interface Options {
  /** The user's task, which the input policy's judge reads as what authorizes a risky input. */
  readonly task?: string | undefined;
  /** Resume stable tab identities from a prior finished adapter state. */
  readonly initialTabs?: AdapterState.Tabs | undefined;
  /** Bound on an observation's outline, in characters. Defaults to 8,000. */
  readonly maxChars?: number | undefined;
  /** Bound on a condition wait. Defaults to 5,000 ms; an unmet wait returns the page as it is. */
  readonly maxWaitMillis?: number | undefined;
  /** Give every control's box in the outline, as `WxH at (x,y)` in viewport CSS pixels. */
  readonly boxes?: boolean | undefined;
  /**
   * After an action, give only the outline's lines that are gone and new since the tab's last whole
   * look, when they are fewer than its lines. Defaults to false.
   */
  readonly changes?: boolean | undefined;
}

type Failing<A> = Effect.Effect<A, BrowserUse.BrowserUseError>;

/** The controller, and the tab it acts on, which `BrowserTools` shares. */
export interface Controller {
  readonly actions: {
    readonly observe: Failing<Observation>;
    /** Act in order, stopping at the first failure; `observe: false` skips the look after. */
    readonly act: (
      actions: ReadonlyArray<Action>,
      options?: { readonly observe?: boolean | undefined },
    ) => Failing<ActionResult>;
  };
  readonly control: {
    /** The whole page's outline lines that hold `text`, ignoring case. */
    readonly find: (request: { readonly text: string }) => Failing<Observation>;
    readonly inspect: (request: {
      readonly selector?: string | undefined;
      readonly frame?: string | undefined;
      readonly optionFilter?: string | undefined;
    }) => Failing<Observation>;
    readonly navigate: (request: { readonly url: string }) => Failing<ActionResult>;
    readonly scroll: (request: {
      readonly ref?: string | undefined;
      readonly deltaX: number;
      readonly deltaY: number;
    }) => Failing<ActionResult>;
    readonly wait: (request: WaitRequest) => Failing<Observation>;
    readonly press: (request: {
      readonly ref: string;
      readonly key: string;
    }) => Failing<ActionResult>;
    readonly selectTab: (request: { readonly ref: string }) => Failing<Observation>;
  };
  /** The tab calls act on now: the pinned page, or the one the model last saw. */
  readonly current: Effect.Effect<Page.Page, BrowserError>;
  /** The current tab as a look finds it, following a tab an action opened. */
  readonly look: Effect.Effect<Page.Page, BrowserError>;
  /** Run `run` on the current tab with the task, and say what followed it there. */
  readonly perform: <A>(
    run: (page: Page.Page) => Effect.Effect<A, BrowserError>,
  ) => Effect.Effect<{ readonly value: A; readonly followed: ReadonlyArray<string> }, BrowserError>;
  /** Give `effect` the run's task, for the input policy's judge. */
  readonly withTask: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

/** A failure as the tools report it: what happened and what it leaves, and whether input went. */
export const useError = (error: BrowserError) =>
  new BrowserUse.BrowserUseError({
    code: error.reason._tag === "InvalidRequest" ? "invalid" : "browser",
    message: told(error),
    dispatch: dispatchOf(error),
  });

const dispatchOf = (error: BrowserError) =>
  error.dispatched ? ("possibly-dispatched" as const) : ("not-dispatched" as const);

const invalid = (message: string) =>
  Effect.fail(new BrowserUse.BrowserUseError({ code: "invalid", message }));

/** A snapshot as an observation: the outline, the controls and where the page is. */
const observation = (
  snapshot: Snapshot,
  extra: { readonly followed?: ReadonlyArray<string>; readonly tabs?: Observation["tabs"] },
): Observation => ({
  text: [...(extra.followed ?? []), snapshot.rendered].join("\n"),
  // An observation's controls leave out what a control does not have, rather than state it undefined.
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

/** The tabs the controller follows in a browser: which one is current, and a stable ref for each. */
const following = (browser: Browser.Service, follow: Follow, initial?: AdapterState.Tabs) =>
  Effect.gen(function* () {
    let state = initial ?? AdapterState.tabs((yield* browser.pages).map((tab) => tab.id));

    const become = (tab: Page.Page) =>
      Effect.gen(function* () {
        if (follow === "front" && state.shown !== undefined && tab.id !== state.shown)
          yield* tab.bringToFront;
        state = new AdapterState.Tabs({ ...state, shown: tab.id });

        return tab;
      });

    const look = Effect.gen(function* () {
      const open = yield* browser.pages;

      const next = AdapterState.follow(
        state,
        open.map((tab) => tab.id),
        follow,
      );

      const tab = open.find((tab) => tab.id === next.selected) ?? (yield* browser.firstPage);

      yield* become(tab);
      state = next.state;

      return tab;
    });

    const tabs = Effect.gen(function* () {
      const open = yield* browser.pages;

      state = new AdapterState.Tabs({
        ...state,
        refs: AdapterState.follow(
          state,
          open.map((tab) => tab.id),
          "never",
        ).state.refs,
      });

      return yield* Effect.forEach(open, (tab) => {
        const ref = state.refs[tab.id];

        if (ref === undefined) return Effect.die("registered tab is missing its stable ref");

        return Effect.map(tab.url, (url) => ({
          ref,
          url: url.startsWith("data:") ? "data:" : url,
          active: tab.id === state.shown,
        }));
      });
    });

    const select = (ref: string) =>
      Effect.gen(function* () {
        const open = yield* browser.pages;

        const id = AdapterState.selected(
          state,
          open.map((tab) => tab.id),
          ref,
        );

        const tab = open.find((tab) => tab.id === id);

        if (tab === undefined) return Option.none<Page.Page>();
        state = new AdapterState.Tabs({ ...state, seen: [...new Set([...state.seen, tab.id])] });

        return Option.some(yield* become(tab));
      });

    return {
      current: Effect.suspend(() =>
        state.shown === undefined
          ? look
          : Effect.flatMap(
              browser.page(state.shown),
              Option.match({ onNone: () => look, onSome: Effect.succeed }),
            ),
      ),
      look,
      tabs,
      select,
    };
  });

/**
 * What of a page a read outlines: what is inside `within`, the lines of the whole page that hold
 * `query`, or the viewport, which after an action may be only its `changes`.
 */
interface Scope {
  readonly within?: string | undefined;
  readonly query?: string | undefined;
  readonly changes?: boolean | undefined;
}

/** The outline's lines that are gone from `before` and new in `after`, as often as each repeats. */
const changed = (before: ReadonlyArray<string>, after: ReadonlyArray<string>) => {
  const left = new Map<string, number>();

  const take = (line: string) => {
    const count = left.get(line) ?? 0;

    left.set(line, count - 1);

    return count > 0;
  };

  for (const line of before) left.set(line, (left.get(line) ?? 0) + 1);
  const added = after.filter((line) => !take(line));

  return { gone: before.filter(take), added };
};

/** A snapshot whose outline is only what changed since `before`, or itself when that is longer. */
const changesOf = (snapshot: Snapshot, before: string) => {
  const lines = snapshot.text.split("\n");
  const { gone, added } = changed(before.split("\n"), lines);

  if (gone.length + added.length >= lines.length) return snapshot;

  const text = [
    "Only what changed in the outline since the last observation:",
    ...(gone.length + added.length === 0 ? ["(nothing)"] : []),
    ...(gone.length === 0 ? [] : ["No longer shown:", ...gone]),
    ...(added.length === 0 ? [] : ["Newly shown:", ...added]),
  ].join("\n");

  return new Snapshot({
    ...snapshot,
    text,
    controls: snapshot.controls.filter((control) => text.includes(`[ref=${control.ref}]`)),
  });
};

/** What the controller's parts share: the tab they act on, how they read it, and the run's task. */
interface Session {
  readonly current: Effect.Effect<Page.Page, BrowserError>;
  /** The current tab, following a tab an action opened; the pinned page is always the one. */
  readonly look: Effect.Effect<Page.Page, BrowserError>;
  readonly read: (
    page: Page.Page,
    scope?: Scope,
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
      : yield* Effect.map(
          following(target.browser, target.follow ?? "select", options.initialTabs),
          (followed) => ({
            current: followed.current,
            look: followed.look,
            tabs: followed,
          }),
        );

  // The pages whose changes are recorded, from their first look, so the receipt of the first
  // action on one can say what it changed. A page whose record could not start says so, and the
  // next look tries again.
  const recording = new Set<string>();

  const record = (page: Page.Page) =>
    recording.has(page.id)
      ? Effect.succeed([])
      : page.changes().pipe(
          Effect.andThen(Effect.sync(() => recording.add(page.id))),
          Effect.as([]),
          Effect.catch((error) =>
            Effect.succeed([`What changes on this page cannot be recorded yet: ${error.message}.`]),
          ),
        );

  // Each tab's last whole outline, with its address, which an action's changes are taken against.
  const whole = new Map<string, { readonly url: string; readonly text: string }>();

  const outlined = (page: Page.Page, scope: Scope) =>
    Effect.map(
      page.snapshot({
        maxChars,
        within: scope.within,
        ...(scope.query === undefined ? {} : { full: true, query: scope.query }),
        boxes: options.boxes,
      }),
      (snapshot) => {
        if (options.changes !== true || scope.within !== undefined || scope.query !== undefined)
          return snapshot;
        const before = whole.get(page.id);

        whole.set(page.id, { url: snapshot.url, text: snapshot.text });

        return scope.changes === true && before?.url === snapshot.url
          ? changesOf(snapshot, before.text)
          : snapshot;
      },
    );

  const read = (page: Page.Page, scope: Scope = {}, lines: ReadonlyArray<string> = []) =>
    Effect.all([outlined(page, scope), tabs?.tabs ?? Effect.void, record(page)], {
      concurrency: "unbounded",
    }).pipe(
      Effect.map(([snapshot, open, unrecorded]) =>
        observation(snapshot, {
          followed: [...lines, ...unrecorded],
          tabs: open === undefined ? undefined : open,
        }),
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
        Effect.flatMap(look, (next) => read(next, { changes: true }, lines)),
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

const action = (step: Action) => (page: Page.Page) => {
  switch (step.kind) {
    case "click":
      return page.perform({ _tag: "Click", target: step.ref });
    case "fill":
      return page.perform({ _tag: "Type", text: step.value, options: { into: step.ref } });
    case "select":
      return page.perform({ _tag: "Select", ref: step.ref, values: [step.value] });
  }
};

const frameless = (operation: string) =>
  invalid(`Frames are read inline here and none is listed: ${operation} without frame.`);

/** A condition wait, ending at the run's bound with the page as it is. */
const waiting =
  ({ current, read, withTask, maxWait }: Session) =>
  (request: WaitRequest) => {
    if (request.frame !== undefined) return frameless("wait");
    if (request.state === "text" && request.text === undefined)
      return invalid("A wait for text needs the text.");
    const millis = Math.min(request.timeoutMillis, maxWait);
    const state = request.state === "text" ? "visible" : request.state;

    return Effect.gen(function* () {
      const page = yield* current;

      const { met } = yield* page.until(
        {
          selector: request.selector,
          text: request.text,
          state: state === "enabled" ? "enabled" : "visible",
        },
        state === "hidden" ? "none" : "some",
        millis,
      );

      return yield* read(page, {}, met ? [] : [`The wait ended after ${millis} ms unmet.`]);
    }).pipe(Effect.mapError(useError), withTask);
  };

/** The controller's `control` over the session's current tab. */
const controlling = (context: Session): Controller["control"] => {
  const { look, read, tabs, withTask } = context;
  const act = acting(context);

  return {
    find: ({ text }) =>
      Effect.flatMap(look, (page) => read(page, { query: text })).pipe(
        Effect.mapError(useError),
        withTask,
      ),
    inspect: ({ selector, frame, optionFilter }) =>
      frame !== undefined
        ? frameless("inspect")
        : Effect.flatMap(look, (page) => read(page, { within: selector })).pipe(
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
    press: ({ ref, key }) => act([(page) => page.press(key, { on: ref })], true),
    selectTab: ({ ref }) =>
      tabs === undefined
        ? invalid("These tools are pinned to one tab.")
        : tabs.select(ref).pipe(
            Effect.mapError(useError),
            Effect.flatMap(
              Option.match({
                onNone: () => invalid(`${ref} is not an open tab; observe for the current tabs.`),
                onSome: (page) => read(page).pipe(Effect.mapError(useError)),
              }),
            ),
            withTask,
          ),
  };
};

/** The controller over `target`, and the tab it acts on. */
export const make = Effect.fnUntraced(function* (target: Target, options: Options = {}) {
  const context = yield* session(target, options);
  const { current, look, read, withTask } = context;
  const act = acting(context);

  const actions: Controller["actions"] = {
    observe: Effect.flatMap(look, (page) => read(page)).pipe(Effect.mapError(useError), withTask),
    act: (steps, actOptions = {}) => act(steps.map(action), actOptions.observe ?? true),
  };

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
    look,
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
