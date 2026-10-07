/**
 * A compact, model-readable outline of what a page shows.
 *
 * Each control gets a ref such as `e12`. A ref stays valid while its element is on the page, and
 * refs are never reused within a page, so a ref from an old snapshot fails as stale rather than
 * naming a different element.
 *
 * @since 0.3.0
 */
import { Schema } from "effect";

export class Snapshot extends Schema.Class<Snapshot>("effect-browser/Snapshot")({
  url: Schema.String,
  title: Schema.String,
  /** One line per control, heading or text block, indented by landmark. */
  text: Schema.String,
  /** True when `text` was cut at `maxChars`. */
  truncated: Schema.Boolean,
  /**
   * Parts of the page left out because they lie above or below the viewport, each an element out
   * of view with all it holds (viewport snapshots only).
   */
  above: Schema.Finite,
  below: Schema.Finite,
  viewport: Schema.Struct({ width: Schema.Finite, height: Schema.Finite }),
  scroll: Schema.Struct({ y: Schema.Finite, height: Schema.Finite }),
}) {
  /** The snapshot as one block of text for a model: header, outline and what was left out. */
  get rendered(): string {
    const position =
      this.scroll.height > this.viewport.height
        ? `, scrolled to ${this.scroll.y} of ${this.scroll.height - this.viewport.height}px`
        : "";

    const omitted: Array<string> = [];

    if (this.above > 0) omitted.push(`${this.above} parts above`);
    if (this.below > 0) omitted.push(`${this.below} parts below`);

    const footer = [
      ...(omitted.length > 0 ? [`(${omitted.join(", ")} the viewport)`] : []),
      ...(this.truncated ? ["(cut short: narrow it with query)"] : []),
    ];

    return [
      `Page: ${this.title === "" ? "(untitled)" : this.title}`,
      `URL: ${this.url}`,
      `Viewport: ${this.viewport.width}x${this.viewport.height}${position}`,
      this.text === "" ? "(nothing readable in view)" : this.text,
      ...footer,
    ].join("\n");
  }
}

export interface SnapshotOptions {
  /** Read the whole page instead of the viewport. Defaults to false. */
  readonly full?: boolean | undefined;
  /** Keep only lines containing this text (case-insensitive). */
  readonly query?: string | undefined;
  /** Bound on the outline's length. Defaults to 12,000 characters. */
  readonly maxChars?: number | undefined;
}
