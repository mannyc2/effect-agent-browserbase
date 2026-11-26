/**
 * Seed a deterministic page without executing page code or inferring browser effects.
 *
 * @stability stable
 * @since 0.3.0
 */
import type { Seed } from "./internal/model.ts";
import { makeIn } from "./internal/page.ts";

export type {
  /**
   * @stability stable
   * @category models
   * @since 0.3.0
   */
  Seed,
  /**
   * @stability stable
   * @category models
   * @since 0.3.0
   */
  Element,
  /**
   * @stability stable
   * @category models
   * @since 0.3.0
   */
  ChangeTrack,
} from "./internal/model.ts";

/**
 * @stability stable
 * @category constructors
 * @since 0.3.0
 */
export const make = (
  seed: Seed = {},
  options: { readonly id?: string; readonly session?: string; readonly connection?: string } = {},
) => makeIn(seed, options);
