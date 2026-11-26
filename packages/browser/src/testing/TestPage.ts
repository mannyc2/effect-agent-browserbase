/** Seed a deterministic page without executing page code or inferring browser effects. */
import type { Seed } from "./internal/model.ts";
import { makeIn } from "./internal/page.ts";

export type { Seed, Element, ChangeTrack } from "./internal/model.ts";

export const make = (
  seed: Seed = {},
  options: { readonly id?: string; readonly session?: string; readonly connection?: string } = {},
) => makeIn(seed, options);
