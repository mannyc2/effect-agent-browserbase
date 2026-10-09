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

/** A control the outline shows, as a value: its ref, what it is and what it holds. */
export class Control extends Schema.Class<Control>("effect-browser/Control")({
  ref: Schema.String,
  /** Its role, such as `button` or `textbox`, or `clickable` for an element without one. */
  kind: Schema.String,
  /** Its accessible name. */
  name: Schema.String,
  /** What it holds: a field's text, `••••` for a secret one, or a select's chosen labels. */
  value: Schema.String,
  /** A select's option labels, at most 64. */
  options: Schema.optional(Schema.Array(Schema.String)),
  /** How many options a select has, when it has options. */
  optionCount: Schema.optional(Schema.Int),
  disabled: Schema.optional(Schema.Boolean),
  /** Whether it is checked, for what can be checked. */
  checked: Schema.optional(Schema.Boolean),
  /** True for a field that takes typed text. */
  editable: Schema.optional(Schema.Boolean),
}) {}

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
  /** The controls the outline shows, in its order. */
  controls: Schema.Array(Control),
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
  /**
   * Read only inside the elements this CSS selector matches, such as `form` or `#results`. A
   * selector that matches nothing reads nothing; one that is not CSS is an `InvalidRequest`.
   */
  readonly within?: string | undefined;
  /** Bound on the outline's length. Defaults to 12,000 characters. */
  readonly maxChars?: number | undefined;
}
