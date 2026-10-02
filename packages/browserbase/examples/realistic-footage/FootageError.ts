import { Schema } from "effect";

/**
 * What can go wrong in the example's own code. Failures of the session itself
 * stay `BrowserError`; neither is folded into the other.
 */
export class FootageError extends Schema.TaggedError<FootageError>()("FootageError", {
  reason: Schema.Literals([
    "presentation-limit",
    "timeline-gap",
    "encoder",
    "no-frames",
    /** The capture ended before the film did; a film is one interval, bounded at ten minutes. */
    "capture-ended",
  ]),
  detail: Schema.optionalKey(Schema.String),
  cause: Schema.optionalKey(Schema.Defect()),
}) {}
