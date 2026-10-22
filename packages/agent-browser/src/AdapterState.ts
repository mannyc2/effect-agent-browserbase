/** Serializable tab selection and context placement, independent of browser effects. */
import { Schema } from "effect";
import { Zoom } from "effect-browser/Page";
import { Snapshot } from "effect-browser/Snapshot";
import { Window } from "effect-browser/Window";
import { Prompt } from "effect/ai";

export class Tabs extends Schema.Class<Tabs>("effect-agent-browser/AdapterState/Tabs")({
  shown: Schema.optional(Schema.String),
  seen: Schema.Array(Schema.String),
  refs: Schema.Record(Schema.String, Schema.String),
}) {}

export const tabs = (seen: ReadonlyArray<string> = []): Tabs => new Tabs({ seen, refs: {} });

/** The newest unseen tab wins unless following is disabled; a closed selection falls back. */
export const follow = (
  state: Tabs,
  open: ReadonlyArray<string>,
  policy: "select" | "front" | "never",
) => {
  const newest = open.filter((id) => !state.seen.includes(id)).at(-1);

  const selected =
    policy !== "never" && newest !== undefined
      ? newest
      : (open.find((id) => id === state.shown) ?? open[0]);

  const refs = { ...state.refs };

  for (const id of open)
    if (refs[id] === undefined) {
      let next = Object.keys(refs).length + 1;

      while (Object.values(refs).includes(`tab${next}`)) next++;
      refs[id] = `tab${next}`;
    }

  return {
    selected,
    state: new Tabs({ shown: selected, seen: [...new Set([...state.seen, ...open])], refs }),
  };
};

export const selected = (state: Tabs, open: ReadonlyArray<string>, ref: string) =>
  open.find((id) => state.refs[id] === ref);

export const Placed = Schema.Struct({
  turn: Schema.String,
  after: Schema.Int,
  message: Prompt.UserMessage,
});

export type Placed = typeof Placed.Type;

export class Moments extends Schema.Class<Moments>("effect-agent-browser/AdapterState/Moments")({
  placed: Schema.Array(Placed),
  recent: Schema.Array(Prompt.UserMessage),
  previous: Schema.optional(Window),
}) {}

export const moments = (): Moments => new Moments({ placed: [], recent: [] });

/** Stable accounts stay in the source order; pictures alone age out of transient context. */
export const place = (
  state: Moments,
  account: Placed,
  pictures: Prompt.UserMessage,
  previous: Window,
): Moments =>
  state.placed.some((known) => known.turn === account.turn)
    ? state
    : new Moments({
        placed: [...state.placed, account],
        recent: [...state.recent, pictures].slice(-3),
        previous,
      });

export const weave = (source: Prompt.Prompt, placed: ReadonlyArray<Placed>): Prompt.Prompt => {
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
};

/** Finished conversation and adapter context; in-flight agent runs remain owned by Yielded. */
export class Seed extends Schema.Class<Seed>("effect-agent-browser/AdapterState/Seed")({
  history: Prompt.Prompt,
  threadId: Schema.optional(Schema.String),
  tabs: Schema.optional(Tabs),
  moments: Schema.optional(Moments),
  zooms: Schema.Array(Zoom),
  observations: Schema.Array(Snapshot),
}) {}

export const load = Schema.decodeUnknownEffect(Schema.toCodecJson(Seed));
