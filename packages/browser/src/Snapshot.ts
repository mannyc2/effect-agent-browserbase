/**
 * A compact, model-readable outline of what a page shows.
 *
 * Each control gets a ref such as `e12`. A ref stays valid while its element is on the page, and
 * refs are never reused within a page, so a ref from an old snapshot fails as stale rather than
 * naming a different element.
 *
 * @stability stable
 * @since 0.3.0
 */
import { type Duration, type Effect, Function, Schema } from "effect";

import type { BrowserError } from "./BrowserError.ts";
import { Box, Subject } from "./BrowserEvent.ts";
import { millisOf } from "./internal/clock.ts";
import type { Point } from "./internal/geometry.ts";
import { functionsOf, isPage } from "./internal/page/functions.ts";
import type { Page } from "./Page.ts";

/**
 * A control the outline shows, as a value: its ref, what it is and what it holds.
 *
 * @stability stable
 * @category schemas
 * @since 0.3.0
 */
export class Control extends Schema.Class<Control>("effect-browser/Snapshot/Control")({
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

/**
 * @stability stable
 * @category schemas
 * @since 0.3.0
 */
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

/**
 * @stability stable
 * @category options
 * @since 0.3.0
 */
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
  /**
   * Give every control's box, as `WxH at (x,y)` in viewport CSS pixels, as a canvas's or a frame's
   * always has. Defaults to false.
   */
  readonly boxes?: boolean | undefined;
}

/**
 * What `find` looks for. Every rule given must hold; with none, it finds every element in scope
 * that has a role or is a control.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface FindQuery {
  /** Narrow matching to this CSS selector. Invalid CSS fails InvalidRequest. */
  readonly selector?: string | undefined;
  /** Require a visible match, optionally enabled. */
  readonly state?: "visible" | "enabled" | undefined;
  /** An ARIA role, such as `"button"` or `"heading"`, ignoring case. */
  readonly role?: string | undefined;
  /**
   * The accessible name: a string that reads the same once spaces are collapsed and case folded,
   * or a pattern found in it.
   */
  readonly name?: string | RegExp | undefined;
  /**
   * Text it shows, ignoring case and spacing, or a pattern. Text inside a control or a heading is
   * that control's or heading's, and only the smallest element showing it matches, not every
   * element around it.
   */
  readonly text?: string | RegExp | undefined;
  /** Whole words in its context (row, column, label or heading), ignoring case and spacing. */
  readonly near?: string | undefined;
  /** Only what a point action at this viewport point would reach: the control there, or else what is painted there. */
  readonly at?: Point | undefined;
  /** The viewport (the default), or the whole document. */
  readonly scope?: "viewport" | "document" | undefined;
}

/**
 * An element's state as its markup gives it: `checked` for what can be checked, `expanded`,
 * `selected` and `pressed` where the page says either way, and `level` for headings.
 *
 * @stability stable
 * @category schemas
 * @since 0.3.0
 */
export const ElementState = Schema.Struct({
  disabled: Schema.Boolean,
  focused: Schema.Boolean,
  checked: Schema.optional(Schema.Boolean),
  expanded: Schema.optional(Schema.Boolean),
  selected: Schema.optional(Schema.Boolean),
  pressed: Schema.optional(Schema.Boolean),
  level: Schema.optional(Schema.Int),
});

/**
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type ElementState = typeof ElementState.Type;

/**
 * An element `find` found: a ref for the actions, what it is, where it is and its state.
 *
 * @stability stable
 * @category schemas
 * @since 0.3.0
 */
export class Found extends Schema.Class<Found>("effect-browser/Snapshot/Found")({
  ref: Schema.String,
  subject: Subject,
  /** Its box, rounded. Reading the document, it may be out of view. */
  box: Box,
  inViewport: Schema.Boolean,
  state: ElementState,
}) {}

/**
 * The page's outline: one line per control, heading or text block, with a ref for each control,
 * in one call to the page.
 *
 * @stability stable
 * @category constructors
 * @since 0.3.0
 */
export const read: {
  (options?: SnapshotOptions): (page: Page) => Effect.Effect<Snapshot, BrowserError>;
  (page: Page, options?: SnapshotOptions): Effect.Effect<Snapshot, BrowserError>;
} = Function.dual(
  (args) => isPage(args[0]),
  (page: Page, options?: SnapshotOptions) => functionsOf(page).snapshot(options),
);

/**
 * The elements that match a query, in tree order, with refs the actions take, in one call to the
 * page. All that match are returned, so a caller tells them apart by their context; none is an
 * empty result, not a failure.
 *
 * @stability stable
 * @category combinators
 * @since 0.3.0
 */
export const find: {
  (query?: FindQuery): (page: Page) => Effect.Effect<ReadonlyArray<Found>, BrowserError>;
  (page: Page, query?: FindQuery): Effect.Effect<ReadonlyArray<Found>, BrowserError>;
} = Function.dual(
  (args) => isPage(args[0]),
  (page: Page, query?: FindQuery) => functionsOf(page).find(query),
);

/**
 * What a wait requires of the query's matches.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type UntilWant = "some" | "none" | { readonly other: string };

/**
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface UntilResult {
  readonly met: boolean;
  readonly mark: string;
}

/**
 * Wait, in one call to the page, until what `query` matches is as `want` says or `timeout` passes.
 * Replaced documents share one deadline. Unmet is `met: false`; an empty mark means no stable
 * document could be sampled.
 *
 * @stability stable
 * @category combinators
 * @since 0.3.0
 */
export const until: {
  (
    query: FindQuery,
    want: UntilWant,
    timeout: Duration.Input,
  ): (page: Page) => Effect.Effect<UntilResult, BrowserError>;
  (
    page: Page,
    query: FindQuery,
    want: UntilWant,
    timeout: Duration.Input,
  ): Effect.Effect<UntilResult, BrowserError>;
} = Function.dual(4, (page: Page, query: FindQuery, want: UntilWant, timeout: Duration.Input) =>
  functionsOf(page).until(query, want, millisOf(timeout)),
);
