/**
 * Seed a deterministic page without executing page code or inferring browser effects, or give a
 * page pictures of a test's own.
 */
import { Effect } from "effect";

import { type Pictures as Own, Pictures as Slot } from "../internal/pictures/slot.ts";
import type { Page } from "../Page.ts";
import type { Seed } from "./internal/model.ts";
import { makeIn } from "./internal/page.ts";

export type { Seed, Element, ChangeTrack } from "./internal/model.ts";

export const make = (
  seed: Seed = {},
  options: { readonly id?: string; readonly session?: string; readonly connection?: string } = {},
) => makeIn(seed, options);

/** What a page's `Frame` functions read: its newest frames, crops, capture and paint. */
export type Pictures = Own;

/**
 * A copy of `page` whose `Frame` functions read what `pictures` makes of its own, so a test can
 * watch what a reader took or give it pictures of its own making. The page's members are its own.
 */
export const withPictures = <P extends Page>(
  page: P,
  pictures: (own: Pictures) => Pictures,
): Effect.Effect<P> => Effect.map(Slot.of(page), (own) => Slot.with(page, pictures(own)));
