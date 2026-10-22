/** Seed a deterministic page without executing page code or inferring browser effects. */
import type { Seed } from "./model.ts";
import { makeIn } from "./page.ts";

export type { Seed, Element, ChangeTrack } from "./model.ts";

export const make = (
  seed: Seed = {},
  options: { readonly id?: string; readonly session?: string; readonly connection?: string } = {},
) => makeIn(seed, options);
