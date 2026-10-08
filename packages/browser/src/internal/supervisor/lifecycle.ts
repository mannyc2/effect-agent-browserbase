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

/** Lost: its connection dropped, or its provider ended its session, as `cause` says. */
export class Lost extends Schema.TaggedClass<Lost>()("Lost", {
  cause: DisconnectCause,
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

export const GenerationState = Schema.Union([Opening, Reopening, Open, Lost, Down, Closed]);

export type GenerationState = typeof GenerationState.Type;

/** A generation that opened: its number, and what the runtime keeps to serve and end it. */
export interface Live<A> {
  readonly number: number;
  readonly value: A;
}

/**
 * At most one generation opens and at most one serves. Both do while a rotation makes the next
 * before it breaks the current, and `Down` keeps serving one that a rotation failed to replace.
 */
export type State<A> =
  | { readonly _tag: "Opening"; readonly number: number; readonly serving: Live<A> | undefined }
  | { readonly _tag: "Open"; readonly serving: Live<A> }
  | {
      readonly _tag: "Down";
      readonly number: number;
      readonly detail: string;
      readonly cause: unknown;
      readonly serving: Live<A> | undefined;
    }
  | { readonly _tag: "Retired" };

export type Input<A> =
  | { readonly _tag: "Opened"; readonly live: Live<A> }
  /** The open of `number` failed for good. */
  | {
      readonly _tag: "Failed";
      readonly number: number;
      readonly detail: string;
      readonly cause: unknown;
    }
  /** The open of `number` was stopped, as on retiring, before it opened. */
  | { readonly _tag: "Abandoned"; readonly number: number }
  | { readonly _tag: "Lost"; readonly number: number; readonly cause: DisconnectCause }
  /** A caller asks for the next generation, or the rotation time of `due` came. */
  | { readonly _tag: "Rotate"; readonly due?: number | undefined }
  | { readonly _tag: "Retire" }
  | { readonly _tag: "Released"; readonly number: number; readonly released: Released };

export type Command<A> =
  /** Open `number`, after the release of `after` has finished. */
  | { readonly _tag: "Open"; readonly number: number; readonly after: number | undefined }
  /** Watch a generation that opened for its loss and its rotation time. */
  | { readonly _tag: "Watch"; readonly live: Live<A> }
  | { readonly _tag: "Release"; readonly live: Live<A> };

export interface Step<A> {
  readonly state: State<A>;
  /** Generation numbers and their new states, to publish in this order. */
  readonly events: ReadonlyArray<readonly [number, GenerationState]>;
  readonly commands: ReadonlyArray<Command<A>>;
  /** For `Rotate`, the generation to wait for, unless retired. */
  readonly reply?: number | undefined;
}

export const start = <A>(): Step<A> => ({
  state: { _tag: "Opening", number: 1, serving: undefined },
  events: [[1, new Opening()]],
  commands: [{ _tag: "Open", number: 1, after: undefined }],
});

const servingOf = <A>(state: State<A>) => (state._tag === "Retired" ? undefined : state.serving);

/**
 * The state after `input`, with the events to publish and the commands to run. When generations
 * are `exclusive`, the next opens only once the current one's release has finished.
 */
export const transition = <A>(state: State<A>, input: Input<A>, exclusive: boolean): Step<A> => {
  const release = (live: Live<A>): Command<A> => ({ _tag: "Release", live });
  const stay: Step<A> = { state, events: [], commands: [] };

  /**
   * Open `number`, ending `current` now if it `ends`; exclusive generations open only once its
   * release has finished. Otherwise `current` serves until the next one opens.
   */
  const next = (
    number: number,
    reopen: boolean,
    current: Live<A> | undefined,
    ends: boolean,
  ): Step<A> => ({
    state: { _tag: "Opening", number, serving: ends ? undefined : current },
    events: [[number, reopen ? new Reopening() : new Opening()]],
    commands: [
      ...(ends && current !== undefined ? [release(current)] : []),
      { _tag: "Open", number, after: ends && exclusive ? current?.number : undefined },
    ],
  });

  switch (input._tag) {
    case "Opened": {
      const { live } = input;

      // A generation nobody waits for any more, as after `Retire`, is released at once.
      if (state._tag !== "Opening" || state.number !== live.number)
        return { ...stay, commands: [release(live)] };

      return {
        state: { _tag: "Open", serving: live },
        events: [[live.number, new Open()]],
        commands: [
          { _tag: "Watch", live },
          ...(state.serving === undefined ? [] : [release(state.serving)]),
        ],
      };
    }
    case "Failed": {
      const { number, detail, cause } = input;
      const events = [[number, new Down({ detail, cause })] as const];

      if (state._tag !== "Opening" || state.number !== input.number) return { ...stay, events };

      return {
        state: { _tag: "Down", number, detail, cause, serving: state.serving },
        events,
        commands: [],
      };
    }
    case "Abandoned":
      return { ...stay, events: [[input.number, new Closed({})]] };
    case "Released":
      return { ...stay, events: [[input.number, new Closed({ released: input.released })]] };
    case "Lost": {
      const lost = servingOf(state);

      if (state._tag === "Retired" || lost?.number !== input.number) return stay;
      const events = [[lost.number, new Lost({ cause: input.cause })] as const];

      // A rotation already opening the next generation carries on without the lost one.
      if (state._tag === "Opening")
        return { state: { ...state, serving: undefined }, events, commands: [release(lost)] };

      const reopened = next((state._tag === "Open" ? lost.number : state.number) + 1, true, lost, true);

      return { ...reopened, events: [...events, ...reopened.events] };
    }
    case "Rotate": {
      if (state._tag === "Retired") return stay;
      // A rotation time comes only for the generation still serving with nothing opening.
      if (input.due !== undefined && (state._tag !== "Open" || state.serving.number !== input.due))
        return stay;
      if (state._tag === "Opening") return { ...stay, reply: state.number };
      const number = (state._tag === "Open" ? state.serving.number : state.number) + 1;

      return { ...next(number, false, state.serving, exclusive), reply: number };
    }
    case "Retire": {
      const current = servingOf(state);

      if (state._tag === "Retired") return stay;

      return {
        state: { _tag: "Retired" },
        events: [],
        commands: current === undefined ? [] : [release(current)],
      };
    }
  }
};

export type Resolution<A> =
  | { readonly _tag: "Serve"; readonly live: Live<A> }
  | {
      readonly _tag: "Unavailable";
      readonly reason: "down" | "retired";
      readonly detail: string;
      readonly cause?: unknown;
    };

/**
 * What a caller waiting for generation `target`, or for any when it is undefined, gets in
 * `state`; undefined while it should go on waiting.
 */
export const resolve = <A>(
  state: State<A>,
  target: number | undefined,
): Resolution<A> | undefined => {
  const serve = (live: Live<A>) => ({ _tag: "Serve" as const, live });

  switch (state._tag) {
    case "Retired":
      return { _tag: "Unavailable", reason: "retired", detail: "the supervisor was retired" };
    case "Open":
      return target === undefined || state.serving.number >= target
        ? serve(state.serving)
        : undefined;
    case "Opening":
      return target === undefined && state.serving !== undefined ? serve(state.serving) : undefined;
    case "Down":
      if (target === undefined && state.serving !== undefined) return serve(state.serving);

      return target === undefined || state.number >= target
        ? { _tag: "Unavailable", reason: "down", detail: state.detail, cause: state.cause }
        : undefined;
  }
};
