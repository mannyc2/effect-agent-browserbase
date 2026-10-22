/** Provider release evidence, independent of supervision or browser implementation. */
import { Schema } from "effect";

/** The provider confirmed the resource ended. */
export class Settled extends Schema.TaggedClass<Settled>()("Settled", {}) {}

/** The resource may still run, and bill, because its end could not be confirmed. */
export class Unconfirmed extends Schema.TaggedClass<Unconfirmed>()("Unconfirmed", {
  detail: Schema.String,
}) {}

export const Released = Schema.Union([Settled, Unconfirmed]);
export type Released = typeof Released.Type;
