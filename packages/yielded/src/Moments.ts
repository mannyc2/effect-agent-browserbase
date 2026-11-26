/**
 * Where moments sit in a Yielded run's thread, as data to save and resume: each turn's account,
 * placed after the messages it follows, the latest pictures, and the window the next moment
 * starts from. Independent of browser effects.
 *
 * @stability stable
 * @since 0.3.0
 */
import { Function, Schema } from "effect";
import { Window } from "effect-browser/Window";
import { Prompt } from "effect/ai";

/**
 * @stability stable
 * @category schemas
 * @since 0.3.0
 */
export const Placed = Schema.Struct({
  turn: Schema.String,
  after: Schema.Int,
  message: Prompt.UserMessage,
});

/**
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Placed = typeof Placed.Type;

/**
 * @stability stable
 * @category schemas
 * @since 0.3.0
 */
export class Moments extends Schema.Class<Moments>("@effect-browser/yielded/Moments")({
  placed: Schema.Array(Placed),
  recent: Schema.Array(Prompt.UserMessage),
  previous: Schema.optional(Window),
}) {}

/**
 * @stability stable
 * @category constructors
 * @since 0.3.0
 */
export const make = (): Moments => new Moments({ placed: [], recent: [] });

/**
 * Stable accounts stay in the source order; pictures alone age out of transient context.
 *
 * @stability stable
 * @category combinators
 * @since 0.3.0
 */
export const place: {
  (account: Placed, pictures: Prompt.UserMessage, previous: Window): (state: Moments) => Moments;
  (state: Moments, account: Placed, pictures: Prompt.UserMessage, previous: Window): Moments;
} = Function.dual(
  4,
  (state: Moments, account: Placed, pictures: Prompt.UserMessage, previous: Window): Moments =>
    state.placed.some((known) => known.turn === account.turn)
      ? state
      : new Moments({
          placed: [...state.placed, account],
          recent: [...state.recent, pictures].slice(-3),
          previous,
        }),
);

/**
 * `source` with each placed moment after the messages it follows.
 *
 * @stability stable
 * @category combinators
 * @since 0.3.0
 */
export const weave: {
  (placed: ReadonlyArray<Placed>): (source: Prompt.Prompt) => Prompt.Prompt;
  (source: Prompt.Prompt, placed: ReadonlyArray<Placed>): Prompt.Prompt;
} = Function.dual(2, (source: Prompt.Prompt, placed: ReadonlyArray<Placed>): Prompt.Prompt => {
  const messages: Array<Prompt.Message> = [];

  for (let index = 0; index <= source.content.length; index++) {
    messages.push(
      ...placed
        .filter((moment) => Math.min(moment.after, source.content.length) === index)
        .map((moment) => moment.message),
    );
    const message = source.content[index];

    if (message !== undefined) messages.push(message);
  }

  return Prompt.fromMessages(messages);
});
