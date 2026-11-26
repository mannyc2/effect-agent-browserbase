/**
 * A part of a page's implementation that a module's functions reach, such as `Frame`'s pictures.
 * A page keeps it under a symbol, outside `Page`'s type, so it is no member of the page, and a copy
 * that spreads the page keeps it.
 */
import { Effect, Predicate } from "effect";

import type { Page } from "../../Page.ts";

export interface Slot<A> {
  /** Whether a value is a page with this part: how a function's `dual` tells its page apart. */
  readonly is: (u: unknown) => u is Page;
  /** The page's part. A page the library did not make has none, which is a defect. */
  readonly of: (page: Page) => Effect.Effect<A>;
  /** A copy of the page with this part. */
  readonly with: <P extends Page>(page: P, part: A) => P;
}

export const make = <A>(name: string): Slot<A> => {
  const key = Symbol.for(`effect-browser/Page/${name}`);

  const has = (u: unknown): u is Page & Readonly<Record<typeof key, A>> =>
    Predicate.hasProperty(u, key);

  return {
    is: has,
    of: (page) =>
      has(page)
        ? Effect.succeed(page[key])
        : Effect.die(new Error(`This page has no ${name}: only effect-browser makes pages.`)),
    with: (page, part) => ({ ...page, [key]: part }),
  };
};
