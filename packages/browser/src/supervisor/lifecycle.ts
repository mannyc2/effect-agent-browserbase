/** The resource supervisor's pure lifecycle: one state, one transition, explicit commands. */
import type { Released } from "../providers/Released.ts";
import type { State, Why } from "./contract.ts";

/** A generation that opened, with the holds on it. */
export interface Live<V, H> {
  readonly number: number;
  readonly value: V;
  readonly holds: ReadonlySet<H>;
}

/** A generation that stopped serving and is not yet released. */
export interface Ended<V, H> {
  readonly live: Live<V, H>;
  readonly why: Why;
  readonly releasing: boolean;
}

export type Core<V, H, E> = (
  | {
      readonly _tag: "Opening";
      readonly number: number;
      /** False while an exclusive generation waits for earlier releases. */
      readonly started: boolean;
      /** The one it replaces, serving until it opens. Never under `exclusive`. */
      readonly serving: Live<V, H> | undefined;
    }
  | { readonly _tag: "Open"; readonly serving: Live<V, H> }
  | {
      readonly _tag: "Down";
      readonly number: number;
      readonly error: E | undefined;
      readonly detail: string;
      readonly serving: Live<V, H> | undefined;
    }
  /** `opening`: a generation whose open is finishing the try it began before retiring. */
  | { readonly _tag: "Retired"; readonly opening: number | undefined }
) & { readonly ended: ReadonlyMap<number, Ended<V, H>> };

export type Input<V, H, E> =
  | { readonly _tag: "Try"; readonly number: number; readonly attempt: number }
  | {
      readonly _tag: "Failed";
      readonly number: number;
      readonly attempt: number;
      readonly error: E;
    }
  | { readonly _tag: "Opened"; readonly number: number; readonly value: V }
  | {
      readonly _tag: "GaveUp";
      readonly number: number;
      readonly error: E | undefined;
      readonly detail: string;
    }
  | { readonly _tag: "Stopped"; readonly number: number; readonly began: boolean }
  | { readonly _tag: "Lost"; readonly number: number; readonly detail: string }
  | { readonly _tag: "Rotate"; readonly from?: number | undefined }
  | { readonly _tag: "Retire" }
  | { readonly _tag: "Hold"; readonly hold: H }
  | { readonly _tag: "Let"; readonly number: number; readonly hold: H }
  | { readonly _tag: "Released"; readonly number: number; readonly released: Released };

export type Command<V, H> =
  | { readonly _tag: "Open"; readonly number: number }
  | { readonly _tag: "Watch"; readonly live: Live<V, H> }
  | { readonly _tag: "End"; readonly live: Live<V, H>; readonly why: Why }
  | { readonly _tag: "Release"; readonly live: Live<V, H>; readonly why: Why }
  | { readonly _tag: "Stop" };

export interface Step<V, H, E> {
  readonly state: Core<V, H, E>;
  readonly events: ReadonlyArray<readonly [number, State<E>]>;
  readonly commands: ReadonlyArray<Command<V, H>>;
  /** `Try`: the attempt may start. `Rotate`: the generation that replaces the serving one. */
  readonly reply?: number | undefined;
  /** `Hold`: the generation the hold was admitted on. */
  readonly borrowed?: Live<V, H> | undefined;
}

export const start = <V, H, E>(): Step<V, H, E> => ({
  state: { _tag: "Opening", number: 1, started: true, serving: undefined, ended: new Map() },
  events: [],
  commands: [{ _tag: "Open", number: 1 }],
});

export const servingOf = <V, H, E>(state: Core<V, H, E>) =>
  state._tag === "Retired" ? undefined : state.serving;

const without = <H>(holds: ReadonlySet<H>, hold: H) => {
  const rest = new Set(holds);

  rest.delete(hold);

  return rest;
};

export const transition = <V, H, E>(
  state: Core<V, H, E>,
  input: Input<V, H, E>,
  exclusive: boolean,
): Step<V, H, E> => {
  let next = state;
  const events: Array<readonly [number, State<E>]> = [];
  const commands: Array<Command<V, H>> = [];
  let reply: number | undefined;
  let borrowed: Live<V, H> | undefined;

  // Stop `live` serving: its work hears why, and its release starts once that work has let go.
  const end = (live: Live<V, H>, why: Why, detail?: string) => {
    const releasing = live.holds.size === 0;

    next = { ...next, ended: new Map(next.ended).set(live.number, { live, why, releasing }) };
    events.push([live.number, { _tag: "Ending", why, detail }]);
    commands.push({ _tag: "End", live, why });
    if (releasing) commands.push({ _tag: "Release", live, why });
  };

  // Open `number`, `serving` serving until it opens. An exclusive one starts once none is ending.
  const open = (number: number, serving: Live<V, H> | undefined) => {
    const started = !exclusive || next.ended.size === 0;

    next = { _tag: "Opening", number, started, serving, ended: next.ended };
    if (started) commands.push({ _tag: "Open", number });
  };

  switch (input._tag) {
    case "Try":
      if (state._tag === "Opening" && state.started && state.number === input.number) {
        reply = input.attempt;
        events.push([input.number, { _tag: "Opening", attempt: input.attempt }]);
      }
      break;
    case "Failed":
      events.push([input.number, { _tag: "Failed", attempt: input.attempt, error: input.error }]);
      break;
    case "GaveUp": {
      const { number, error, detail } = input;

      events.push([number, { _tag: "Down", error, detail }]);
      if (state._tag === "Opening" && state.number === number)
        next = { _tag: "Down", number, error, detail, serving: state.serving, ended: state.ended };
      else if (state._tag === "Retired" && state.opening === number)
        next = { ...state, opening: undefined };
      break;
    }
    case "Stopped":
      if (state._tag === "Retired" && state.opening === input.number) {
        next = { ...state, opening: undefined };
        if (input.began) events.push([input.number, { _tag: "Closed" }]);
      }
      break;
    case "Opened": {
      const live: Live<V, H> = { number: input.number, value: input.value, holds: new Set() };

      events.push([live.number, { _tag: "Open" }]);
      commands.push({ _tag: "Watch", live });
      if (state._tag === "Opening" && state.number === live.number) {
        next = { _tag: "Open", serving: live, ended: state.ended };
        if (state.serving !== undefined) end(state.serving, "rotated");
      } else {
        // Retired while its try ran: it ends as it opens.
        if (state._tag === "Retired") next = { ...state, opening: undefined };
        end(live, "retired");
      }
      break;
    }
    case "Lost": {
      const serving = servingOf(state);

      if (state._tag === "Retired" || serving === undefined || serving.number !== input.number)
        break;
      if (state._tag === "Opening") next = { ...state, serving: undefined };
      end(serving, "lost", input.detail);
      if (state._tag !== "Opening")
        open((state._tag === "Open" ? serving.number : state.number) + 1, undefined);
      break;
    }
    case "Rotate": {
      if (state._tag === "Retired") break;
      const serving = state.serving;

      if (input.from !== undefined && serving?.number !== input.from) break;
      if (state._tag === "Opening") {
        reply = state.number;
        break;
      }
      reply = (state._tag === "Open" ? state.serving.number : state.number) + 1;
      if (exclusive && serving !== undefined) end(serving, "rotated");
      open(reply, exclusive ? undefined : serving);
      break;
    }
    case "Retire": {
      if (state._tag === "Retired") break;
      const serving = state.serving;

      next = {
        _tag: "Retired",
        opening: state._tag === "Opening" && state.started ? state.number : undefined,
        ended: state.ended,
      };
      if (serving !== undefined) end(serving, "retired");
      commands.push({ _tag: "Stop" });
      break;
    }
    case "Hold": {
      if (state._tag === "Retired" || state.serving === undefined) break;
      const live = { ...state.serving, holds: new Set(state.serving.holds).add(input.hold) };

      next = { ...state, serving: live };
      borrowed = live;
      break;
    }
    case "Let": {
      const serving = servingOf(state);

      if (state._tag !== "Retired" && serving?.number === input.number) {
        if (serving.holds.has(input.hold))
          next = { ...state, serving: { ...serving, holds: without(serving.holds, input.hold) } };
        break;
      }
      const ended = state.ended.get(input.number);

      if (ended === undefined || !ended.live.holds.has(input.hold)) break;
      const live = { ...ended.live, holds: without(ended.live.holds, input.hold) };
      const releasing = live.holds.size === 0;

      next = {
        ...state,
        ended: new Map(state.ended).set(input.number, { ...ended, live, releasing }),
      };
      if (releasing) commands.push({ _tag: "Release", live, why: ended.why });
      break;
    }
    case "Released": {
      const ended = state.ended.get(input.number);

      if (ended === undefined || !ended.releasing) break;
      const rest = new Map(state.ended);

      rest.delete(input.number);
      next = { ...state, ended: rest };
      events.push([input.number, { _tag: "Closed", released: input.released }]);
      if (next._tag === "Opening" && !next.started && rest.size === 0) {
        next = { ...next, started: true };
        commands.push({ _tag: "Open", number: next.number });
      }
      break;
    }
  }

  return { state: next, events, commands, reply, borrowed };
};

/** What a caller waiting for a generation gets now: nothing yet while one opens. */
export const resolve = <V, H, E>(state: Core<V, H, E>) =>
  state._tag === "Retired"
    ? {
        _tag: "Unavailable" as const,
        reason: "retired" as const,
        error: undefined,
        detail: "retired",
      }
    : state.serving !== undefined
      ? { _tag: "Serve" as const }
      : state._tag === "Down"
        ? {
            _tag: "Unavailable" as const,
            reason: "down" as const,
            error: state.error,
            detail: state.detail,
          }
        : undefined;
