/**
 * A supervisor's life as one state and one transition function, and the generation states it
 * publishes. The transition has no effects: `Supervisor.make` applies each input under one lock,
 * publishes the events in order and runs the commands, so the rules here are tested alone.
 */
import { Schema } from "effect";

import { DisconnectCause } from "../../BrowserEvent.ts";

/** The provider confirmed that the generation's browser ended. */
export class Settled extends Schema.TaggedClass<Settled>()("Settled", {}) {}

/** The provider could not confirm the end by its deadline, so the browser may still run, and bill. */
export class Unconfirmed extends Schema.TaggedClass<Unconfirmed>()("Unconfirmed", {
  detail: Schema.String,
}) {}

export const Released = Schema.Union([Settled, Unconfirmed]);

export type Released = typeof Released.Type;

/** Opening, but not after a loss: the first generation, a rotation, or the one after `Down`. */
export class Opening extends Schema.TaggedClass<Opening>()("Opening", {}) {}

/** Opening after the generation before it was lost. */
export class Reopening extends Schema.TaggedClass<Reopening>()("Reopening", {}) {}

/** Open: `browser` gives this generation until the next one opens. */
export class Open extends Schema.TaggedClass<Open>()("Open", {}) {}

/** No longer serving; holds end at this host-monotonic deadline or when their owners let go. */
export class Draining extends Schema.TaggedClass<Draining>()("Draining", {
  reason: Schema.Literals(["rotated", "lost", "retired"]),
  revokeAt: Schema.Finite,
}) {}

/** Lost through disconnection or a consumer's declaration that it is unusable. */
export class Lost extends Schema.TaggedClass<Lost>()("Lost", {
  cause: Schema.Union([DisconnectCause, Schema.Literal("declared")]),
  detail: Schema.optional(Schema.String),
}) {}

/**
 * It never opened: its last try failed with `cause`, which the provider deems definite, or after
 * which the reopen schedule gave up.
 */
export class Down extends Schema.TaggedClass<Down>()("Down", {
  detail: Schema.String,
  cause: Schema.Defect(),
}) {}

/** It ended. `released` says how its release went; one retired while opening has none. */
export class Closed extends Schema.TaggedClass<Closed>()("Closed", {
  released: Schema.optional(Released),
}) {}

/**
 * It was serving as the supervisor's scope closed, and was left running, not released: its scope
 * closed, and its provider runs it on, and bills, until something adopts and releases it.
 */
export class Kept extends Schema.TaggedClass<Kept>()("Kept", {}) {}

export const GenerationState = Schema.Union([
  Opening,
  Reopening,
  Open,
  Draining,
  Lost,
  Down,
  Closed,
  Kept,
]);

export type GenerationState = typeof GenerationState.Type;

/** A generation that opened: its number, and what the runtime keeps to serve and end it. */
export interface Live<A> {
  readonly number: number;
  readonly value: A;
}

export interface Held<A, H> extends Live<A> {
  readonly holds: ReadonlySet<H>;
}

/** Release ownership remains here until the provider and generation scope have finished. */
export interface Drain<A, H> {
  readonly _tag: "Draining" | "Releasing" | "Leaving";
  readonly live: Held<A, H>;
  readonly ending: Draining;
}

/** One serving generation, one shared acquisition, and prior generations still owned. */
export type State<A, H = unknown> = (
  | { readonly _tag: "Opening"; readonly number: number; readonly serving: Held<A, H> | undefined }
  | { readonly _tag: "Open"; readonly serving: Held<A, H> }
  | {
      readonly _tag: "Down";
      readonly number: number;
      readonly detail: string;
      readonly cause: unknown;
      readonly serving: Held<A, H> | undefined;
    }
  | { readonly _tag: "Retired" }
) & {
  readonly draining: ReadonlyMap<number, Drain<A, H>>;
  /** One bounded predecessor survives release and failed acquisitions for admission. */
  readonly latest: Live<A> | undefined;
};

export type Input<A, H = unknown> =
  | { readonly _tag: "Opened"; readonly live: Live<A> }
  | {
      readonly _tag: "Failed";
      readonly number: number;
      readonly detail: string;
      readonly cause: unknown;
    }
  | { readonly _tag: "Abandoned"; readonly number: number }
  | {
      readonly _tag: "Lost";
      readonly number: number;
      readonly cause: Lost["cause"];
      readonly detail?: string | undefined;
    }
  | { readonly _tag: "Rotate"; readonly due?: number | undefined }
  | { readonly _tag: "Retire" }
  | { readonly _tag: "Keep" }
  | {
      readonly _tag: "Hold";
      readonly number?: number | undefined;
      readonly hold: H;
    }
  | { readonly _tag: "Let"; readonly number: number; readonly hold: H }
  | { readonly _tag: "Revoke"; readonly number: number }
  | {
      readonly _tag: "Released";
      readonly number: number;
      readonly released?: Released | undefined;
    };

export type Command<A> =
  | { readonly _tag: "Open"; readonly number: number; readonly after: Live<A> | undefined }
  | { readonly _tag: "Watch"; readonly live: Live<A> }
  /** Signal ending and arrange revocation. Repeated only when loss/retirement accelerates it. */
  | { readonly _tag: "Drain"; readonly live: Live<A>; readonly ending: Draining }
  /** Revoke/close holds, await their Let inputs, release the provider, then close its scope. */
  | { readonly _tag: "Release"; readonly live: Live<A>; readonly ending: Draining }
  | { readonly _tag: "Leave"; readonly live: Live<A>; readonly ending: Draining };

export interface Step<A, H = unknown> {
  readonly state: State<A, H>;
  readonly events: ReadonlyArray<readonly [number, GenerationState]>;
  readonly commands: ReadonlyArray<Command<A>>;
  readonly reply?: number | undefined;
  readonly borrowed?: Live<A> | undefined;
}

export const start = <A, H = unknown>(): Step<A, H> => ({
  state: { _tag: "Opening", number: 1, serving: undefined, draining: new Map(), latest: undefined },
  events: [[1, new Opening()]],
  commands: [{ _tag: "Open", number: 1, after: undefined }],
});

const servingOf = <A, H>(state: State<A, H>) =>
  state._tag === "Retired" ? undefined : state.serving;

/** The holds still owned for a generation, including one whose release has begun. */
export const lookup = <A, H>(state: State<A, H>, number: number): Held<A, H> | undefined =>
  servingOf(state)?.number === number ? servingOf(state) : state.draining.get(number)?.live;

/** A transition's local result builder; input state and its collections remain immutable. */
interface Change<A, H> {
  readonly now: number;
  readonly handover: number;
  readonly exclusive: boolean;
  state: State<A, H>;
  events: Array<readonly [number, GenerationState]>;
  commands: Array<Command<A>>;
  reply?: number;
  borrowed?: Live<A>;
}

/** The sole writer of a drain's ending and phase; each release command is emitted once. */
const draining = <A, H>(change: Change<A, H>, drain: Drain<A, H>) => {
  const before = change.state.draining.get(drain.live.number);
  const { live, ending, _tag } = drain;

  change.state = {
    ...change.state,
    draining: new Map(change.state.draining).set(live.number, drain),
  };
  if (before?.ending !== ending) {
    change.events.push([live.number, ending]);
    change.commands.push({ _tag: "Drain", live, ending });
  }
  if (_tag !== "Draining" && before?._tag !== _tag)
    change.commands.push({ _tag: _tag === "Leaving" ? "Leave" : "Release", live, ending });
};

const end = <A, H>(
  change: Change<A, H>,
  live: Held<A, H>,
  reason: Draining["reason"],
  keep = false,
) => {
  const ending = new Draining({
    reason,
    revokeAt: change.now + (reason === "rotated" ? change.handover : 0),
  });

  draining(change, {
    live,
    ending,
    _tag: keep
      ? "Leaving"
      : live.holds.size === 0 || ending.revokeAt <= change.now
        ? "Releasing"
        : "Draining",
  });
};

const revoke = <A, H>(change: Change<A, H>, number: number, reason?: "lost" | "retired") => {
  const drain = change.state.draining.get(number);

  if (drain?._tag !== "Draining" || (reason === undefined && change.now < drain.ending.revokeAt))
    return;
  draining(change, {
    ...drain,
    _tag: "Releasing",
    ending: reason === undefined ? drain.ending : new Draining({ reason, revokeAt: change.now }),
  });
};

const holds = <A, H>(
  change: Change<A, H>,
  input: Extract<Input<A, H>, { readonly _tag: "Hold" | "Let" }>,
) => {
  const number = input.number ?? servingOf(change.state)?.number;
  const live = number === undefined ? undefined : lookup(change.state, number);

  if (live === undefined) return;
  const drain = change.state.draining.get(live.number);

  if (
    input._tag === "Hold" &&
    drain !== undefined &&
    (drain._tag !== "Draining" || change.now >= drain.ending.revokeAt)
  )
    return;
  if (live.holds.has(input.hold) === (input._tag === "Hold")) return;
  const holds = new Set(live.holds);

  if (input._tag === "Hold") {
    holds.add(input.hold);
    change.borrowed = live;
  } else holds.delete(input.hold);
  const held = { ...live, holds };

  if (drain !== undefined)
    draining(change, {
      ...drain,
      live: held,
      _tag: drain._tag === "Draining" && holds.size === 0 ? "Releasing" : drain._tag,
    });
  else if (change.state._tag !== "Retired") change.state = { ...change.state, serving: held };
};

const next = <A, H>(change: Change<A, H>, number: number, reopen: boolean) => {
  const { exclusive } = change;
  const current = servingOf(change.state);

  const after = change.state.latest;

  if (current !== undefined && (reopen || exclusive))
    end(change, current, reopen ? "lost" : "rotated");
  change.state = {
    _tag: "Opening",
    number,
    serving: reopen || exclusive ? undefined : current,
    draining: change.state.draining,
    latest: after,
  };
  change.events.push([number, reopen ? new Reopening() : new Opening()]);
  change.commands.push({ _tag: "Open", number, after });
};

const lost = <A, H>(
  change: Change<A, H>,
  input: Extract<Input<A, H>, { readonly _tag: "Lost" }>,
) => {
  const { state } = change;
  const drain = state.draining.get(input.number);
  const current = servingOf(state);

  if (input.cause === "declared" && current?.number !== input.number) return;
  if (drain?._tag === "Draining") {
    change.events.push([input.number, new Lost({ cause: input.cause })]);
    revoke(change, input.number, "lost");
  } else if (state._tag !== "Retired" && current?.number === input.number) {
    change.events.push([input.number, new Lost({ cause: input.cause, detail: input.detail })]);
    if (state._tag !== "Opening")
      next(change, (state._tag === "Open" ? current.number : state.number) + 1, true);
    else {
      change.state = { ...state, serving: undefined };
      end(change, current, "lost");
    }
  }
};

/** Pure admission and lifecycle changes. A rejected hold preserves state identity. */
export const transition = <A, H = unknown>(
  state: State<A, H>,
  input: Input<A, H>,
  exclusive: boolean,
  now = 0,
  handover = 30_000,
): Step<A, H> => {
  const change: Change<A, H> = {
    state,
    events: [],
    commands: [],
    exclusive,
    handover,
    now,
  };

  switch (input._tag) {
    case "Hold":
    case "Let":
      holds(change, input);
      break;
    case "Revoke":
      revoke(change, input.number);
      break;
    case "Opened": {
      const live = { ...input.live, holds: new Set<H>() };

      if (lookup(state, live.number) !== undefined) break;
      if (state._tag !== "Opening" || state.number !== live.number) end(change, live, "retired");
      else {
        change.events.push([live.number, new Open()]);
        change.commands.push({ _tag: "Watch", live });
        if (state.serving !== undefined) end(change, state.serving, "rotated");
        change.state = {
          _tag: "Open",
          serving: live,
          draining: change.state.draining,
          latest: input.live,
        };
      }
      break;
    }
    case "Failed": {
      const { number, detail, cause } = input;

      if (state._tag === "Opening" && state.number === number)
        change.state = { ...state, _tag: "Down", detail, cause };
      change.events.push([number, new Down({ detail, cause })]);
      break;
    }
    case "Abandoned":
      change.events.push([input.number, new Closed({})]);
      break;
    case "Released": {
      const drain = state.draining.get(input.number);

      if (drain === undefined || drain._tag === "Draining" || drain.live.holds.size > 0) break;
      const draining = new Map(state.draining);

      draining.delete(input.number);
      change.state = { ...state, draining };
      change.events.push([
        input.number,
        input.released === undefined ? new Kept() : new Closed({ released: input.released }),
      ]);
      break;
    }
    case "Lost":
      lost(change, input);
      break;
    case "Rotate": {
      if (
        state._tag === "Retired" ||
        (input.due !== undefined && (state._tag !== "Open" || state.serving.number !== input.due))
      )
        break;
      change.reply =
        state._tag === "Opening"
          ? state.number
          : (state._tag === "Open" ? state.serving.number : state.number) + 1;
      if (state._tag !== "Opening") next(change, change.reply, false);
      break;
    }
    case "Keep":
    case "Retire":
      if (state._tag === "Retired") break;
      for (const number of state.draining.keys()) revoke(change, number, "retired");
      if (state.serving !== undefined) end(change, state.serving, "retired", input._tag === "Keep");
      change.state = { _tag: "Retired", draining: change.state.draining, latest: undefined };
  }

  return change;
};

export type Resolution<A> =
  | { readonly _tag: "Serve"; readonly live: Live<A> }
  | {
      readonly _tag: "Unavailable";
      readonly reason: "down" | "retired";
      readonly detail: string;
      readonly cause?: unknown;
    };

/** An unheld browser resolution; use obtains its hold atomically through Hold instead. */
export const resolve = <A, H>(
  state: State<A, H>,
  target: number | undefined,
): Resolution<A> | undefined => {
  if (state._tag === "Retired")
    return { _tag: "Unavailable", reason: "retired", detail: "the supervisor was retired" };
  if (
    state.serving !== undefined &&
    (target === undefined || (state._tag === "Open" && state.serving.number >= target))
  )
    return { _tag: "Serve", live: state.serving };
  if (state._tag === "Down" && (target === undefined || state.number >= target))
    return { _tag: "Unavailable", reason: "down", detail: state.detail, cause: state.cause };

  return undefined;
};
