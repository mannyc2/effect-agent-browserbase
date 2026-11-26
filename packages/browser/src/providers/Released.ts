/** Provider release evidence, independent of supervision or browser implementation. */
import { Schema } from "effect";

/** The provider confirmed the resource ended. */
export class Confirmed extends Schema.TaggedClass<Confirmed>()("Confirmed", {}) {}

/** The resource may still run, and bill, because its end could not be confirmed. */
export class Unconfirmed extends Schema.TaggedClass<Unconfirmed>()("Unconfirmed", {
  detail: Schema.String,
}) {}

export const Release = Schema.Union([Confirmed, Unconfirmed]);
export type Release = typeof Release.Type;
