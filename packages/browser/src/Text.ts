/**
 * What a page shows as text: a line per block, with table cells apart by tabs, read from the
 * viewport or from one element whole.
 *
 * @since 0.3.0
 */
import { type Effect, Function, Schema } from "effect";

import type { BrowserError } from "./BrowserError.ts";
import { functionsOf, isPage } from "./internal/page/functions.ts";
import type { Page } from "./Page.ts";

export interface TextOptions {
  /** `"viewport"` (the default) reads what the viewport shows; a ref reads that element whole. */
  readonly scope?: string | undefined;
  /** Bound on the text's length, cut at a line. Defaults to 12,000 characters. */
  readonly maxChars?: number | undefined;
  /** Show what fields hold; a secret field still reads `••••`. Defaults to false. */
  readonly unmask?: boolean | undefined;
}

/** What a page showed as text: a line per block, with table cells apart by tabs. */
export class Text extends Schema.Class<Text>("effect-browser/Text")({
  url: Schema.String,
  title: Schema.String,
  text: Schema.String,
  /** True when `text` was cut at `maxChars`. */
  truncated: Schema.Boolean,
  /** Host monotonic milliseconds from the browser's captured Effect Clock. */
  at: Schema.Finite,
}) {}

/**
 * The text the viewport shows, or one element whole, in one call to the page. Field values read
 * `••••` unless `unmask`, and a secret field's always do, as does one that was secret when the
 * library saw it.
 */
export const read: {
  (options?: TextOptions): (page: Page) => Effect.Effect<Text, BrowserError>;
  (page: Page, options?: TextOptions): Effect.Effect<Text, BrowserError>;
} = Function.dual(
  (args) => isPage(args[0]),
  (page: Page, options?: TextOptions) => functionsOf(page).text(options),
);
