/**
 * Provider release evidence, independent of supervision or browser implementation.
 *
 * @stability stable
 * @since 0.3.0
 */
import { Schema } from "effect";

/**
 * The provider confirmed the resource ended.
 *
 * @stability stable
 * @category schemas
 * @since 0.3.0
 */
export class Confirmed extends Schema.TaggedClass<Confirmed>()("Confirmed", {}) {}

/**
 * The resource may still run, and bill, because its end could not be confirmed.
 *
 * @stability stable
 * @category schemas
 * @since 0.3.0
 */
export class Unconfirmed extends Schema.TaggedClass<Unconfirmed>()("Unconfirmed", {
  detail: Schema.String,
}) {}

/**
 * @stability stable
 * @category schemas
 * @since 0.3.0
 */
export const Release = Schema.Union([Confirmed, Unconfirmed]);

/**
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Release = typeof Release.Type;
