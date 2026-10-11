// The live views a docs page can place in its prose, with the attributes each takes. The markdown
// plugin checks every directive against these at build time.
import { Schema } from "effect";

export const islandAttributes = {
  /** `::Replay{id="polymarket"}`: a packed replay's player. */
  Replay: Schema.Struct({ id: Schema.String }),
};
