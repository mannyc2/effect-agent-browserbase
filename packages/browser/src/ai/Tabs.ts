/**
 * The tabs the tools follow in a browser, as data to save and resume: which one is shown, which
 * were seen, and each one's stable ref. Independent of browser effects.
 *
 * @since 0.3.0
 */
import { Schema } from "effect";

export class Tabs extends Schema.Class<Tabs>("effect-browser/ai/Tabs")({
  shown: Schema.optional(Schema.String),
  seen: Schema.Array(Schema.String),
  refs: Schema.Record(Schema.String, Schema.String),
}) {}

export const make = (seen: ReadonlyArray<string> = []): Tabs => new Tabs({ seen, refs: {} });

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
