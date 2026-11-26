/**
 * The failure every browser tool returns to the model, and its controller fails with: what
 * happened and what it leaves, with what to do about it, and whether the input reached the
 * browser. `code` is `"invalid"` for a request the tools refused before acting, and `"browser"`
 * for a browser operation that failed. The tools return it as their result (`failureMode:
 * "return"`), so the model reads it and the run goes on.
 *
 * @since 0.3.0
 */
import { Schema } from "effect";

import type { BrowserError } from "../BrowserError.ts";
import { dispatchOf, told } from "./internal/receipts.ts";

export class ToolError extends Schema.TaggedError<ToolError>("effect-browser/ai/ToolError")(
  "ToolError",
  {
    code: Schema.Literals(["invalid", "browser"]),
    message: Schema.String,
    /** Whether the input went: never replay one that is not `not-dispatched`. */
    dispatch: Schema.optionalKey(Schema.Literals(["not-dispatched", "possibly-dispatched"])),
  },
) {}

export const isToolError = Schema.is(ToolError);

/** A browser operation's failure as the tools report it. */
export const fromBrowserError = (error: BrowserError) =>
  new ToolError({
    code: error.reason._tag === "InvalidRequest" ? "invalid" : "browser",
    message: told(error),
    dispatch: dispatchOf(error),
  });
