import { Schema } from "effect";

/**
 * What can go wrong in the example's own code. Failures of the session itself
 * stay `BrowserError`; neither is folded into the other.
 */
export class FootageError extends Schema.TaggedError<FootageError>()("FootageError", {
  reason: Schema.Literals([
    /** No document answered a cue in time: the stagehand is not running on the filmed origin. */
    "stagehand-silent",
    /** The selector matched nothing with a size, so there is nowhere to point. */
    "target-missing",
    /** The page answered a cue with a report that does not belong to it. */
    "unexpected-report",
    "encoder",
    "no-frames",
  ]),
  detail: Schema.optionalKey(Schema.String),
  cause: Schema.optionalKey(Schema.Defect()),
}) {}
