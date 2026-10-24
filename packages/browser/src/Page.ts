/**
 * One browser tab: navigation, snapshots, pictures and input.
 *
 * A page waits only for itself: its operations take turns in one lane of its own. An action, which
 * sends input or navigates, has the page to itself, in the order admitted after policy approval; reads share
 * it, after the action in flight and every action asked before them, so a read describes the page
 * an action left. A wait for a turn ends at the operation's deadline as `Busy`, never `Timeout`,
 * and a full deadline then bounds the operation itself; `failFast` fails it at once instead.
 * Identical reads asked between the same actions share one call to the page, and one whose
 * callers gave up finishes for the next caller to ask it within 250 ms. A policy holds outside the lane while
 * other operations continue; its target is revalidated before dispatch. Element targets are refs
 * from a snapshot; point targets are viewport coordinates in CSS pixels, the same coordinates as a
 * screenshot's pixels. Mouse and keyboard input share a bounded pipeline, so pacing does not wait
 * for each protocol reply. Target lookup happens before the input is sent.
 *
 * @since 0.3.0
 */
import { type Clock, type Duration, Effect, Schema, type Scope, type Stream } from "effect";

import {
  Action,
  type ClickOptions as ClickOptionsSchema,
  type TypeOptions as TypeOptionsSchema,
  type PressOptions as PressOptionsSchema,
  type ScrollOptions as ScrollOptionsSchema,
} from "./Action.ts";
import { type BrowserError, type PolicyDenied } from "./BrowserError.ts";
import { Box, type BrowserEvent, PageLoaded, Subject } from "./BrowserEvent.ts";
import type { Changes } from "./Change.ts";
import { type CaptureStats, Frame, Image, type ScreencastOptions } from "./Frame.ts";
import * as Motion from "./Geometry.ts";
import { FormFieldSchema } from "./internal/input/evidence.inpage.ts";
import * as Guard from "./internal/input/guard.inpage.ts";
import { Correlation, FailFast } from "./internal/page/lane.ts";
import { type Snapshot, type SnapshotOptions } from "./Snapshot.ts";
import * as Url from "./Url.ts";
import type { Window } from "./Window.ts";

export type Point = Motion.Point;

/** A ref from a snapshot, such as `"e12"`, or a viewport point. */
export type Target = string | Point;

/** An integer rectangle in viewport CSS pixels. */
export class Region extends Schema.Class<Region>("effect-browser/Region")({
  x: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  y: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  width: Schema.Int.check(Schema.isGreaterThan(0)),
  height: Schema.Int.check(Schema.isGreaterThan(0)),
}) {}

/** A crop and its viewport origin: add that origin to a point read from the crop. */
export class Zoom extends Schema.Class<Zoom>("effect-browser/Zoom")({
  page: Schema.String,
  region: Region,
  image: Image,
}) {}

/** The target as it read before input. Point coordinates are never snapped to another position. */
export class ResolvedTarget extends Schema.Class<ResolvedTarget>("effect-browser/ResolvedTarget")({
  point: Motion.Point,
  ...Subject.fields,
  element: Schema.String,
  /** For a point target, the box of what it found there. */
  box: Schema.optional(Box),
  cursor: Schema.String,
  href: Schema.optional(Schema.String),
}) {}

/** Action options share the execution codec. */
export type ClickOptions = typeof ClickOptionsSchema.Type;
export type TypeOptions = typeof TypeOptionsSchema.Type;
export type PressOptions = typeof PressOptionsSchema.Type;
export type ScrollOptions = typeof ScrollOptionsSchema.Type;

/**
 * How current a picture must be. The newest screencast frame serves when it qualifies, at no cost;
 * otherwise a new screenshot is taken.
 */
export interface FrameOptions {
  /**
   * The oldest a reused frame may be, from its paint, at the earliest its timing allows, to now.
   * Defaults to 250 milliseconds; 0 always takes a new screenshot.
   */
  readonly maxAge?: Duration.Input | undefined;
  /**
   * `"input"`: reuse only a frame painted after this page's latest input, including input of an
   * interrupted action, and never while an action is changing the page. For a caller that has
   * just acted on the page.
   */
  readonly after?: "input" | undefined;
}

/** A screenshot reuses only a frame painted after the page's latest input, as `after: "input"`. */
export interface ScreenshotOptions {
  /** The oldest a reused frame may be, as for `frame`. Defaults to 250 milliseconds. */
  readonly maxAge?: Duration.Input | undefined;
  /** A region of the viewport, captured in CSS pixels at the viewport's own scale; always new. */
  readonly clip?: Box | undefined;
  /** JPEG quality, 0 to 100. Defaults to 80. */
  readonly quality?: number | undefined;
  /** `"jpeg"`, the default, or `"png"`, which is always a new picture. */
  readonly format?: "jpeg" | "png" | undefined;
}

/**
 * What `find` looks for. Every rule given must hold; with none, it finds every element in scope
 * that has a role or is a control.
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

export type ElementState = typeof ElementState.Type;

/** An element `find` found: a ref for the actions, what it is, where it is and its state. */
export class Found extends Schema.Class<Found>("effect-browser/Found")({
  ref: Schema.String,
  subject: Subject,
  /** Its box, rounded. Reading the document, it may be out of view. */
  box: Box,
  inViewport: Schema.Boolean,
  state: ElementState,
}) {}

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

export interface ReadyOptions {
  /** How long recorded content must stay unchanged. Screen stillness is a separate feature. */
  readonly quietMillis?: number | undefined;
  readonly timeout?: Duration.Input | undefined;
}

/** The window `changes` reads, and whether to show what fields hold. */
export interface ChangesOptions {
  /**
   * Where the window starts: the changes a previous read returned, to continue exactly where they
   * ended; a frame, at its paint; or host monotonic milliseconds, which mapped to the page's clock
   * may miss or repeat changes near the start if the browser's clock mapping changed since. Defaults
   * to the start of the record.
   */
  readonly since?: Changes | Frame | number | undefined;
  /**
   * Where it ends: a frame, at its paint, so a delayed frame's window holds nothing it does not
   * show; or host monotonic milliseconds. Defaults to now, and is never later.
   */
  readonly until?: Frame | number | undefined;
  /** Show what fields hold; a secret field still reads `••••`. Defaults to false. */
  readonly unmask?: boolean | undefined;
}

/** The window `window` reads, and whether to show what fields hold. */
export interface WindowOptions {
  /**
   * Where the window starts: a previous window, to continue exactly where it ended; a frame, at its
   * paint; host monotonic milliseconds; or a `Duration` back from `until`. A start after `until`
   * leaves the window empty there.
   */
  readonly since: Window | Frame | Duration.Duration | number;
  /**
   * Where it ends: a frame, at its paint, such as one a delayed consumer airs now; or host
   * monotonic milliseconds. Defaults to now, and is never later.
   */
  readonly until?: Frame | number | undefined;
  /** Show what fields hold in its changes; a secret field still reads `••••`. Defaults to false. */
  readonly unmask?: boolean | undefined;
}

/**
 * What the library knows of a page now, without asking it, each part with when it learned it, in
 * host monotonic milliseconds: a part's age is `at` less its time. Text read before the current
 * document began is left out, since it tells of a document that has gone.
 */
export class State extends Schema.Class<State>("effect-browser/PageState")({
  page: Schema.String,
  /** The tracking connection that owns this document counter. */
  connection: Schema.String,
  /** When this was taken. */
  at: Schema.Finite,
  /** Where the main frame last committed or moved, without userinfo or known secret parameters. */
  url: Schema.String,
  /** The page's document, as `Navigated` counts them. */
  document: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** When the main frame committed it; absent for the one the browser began tracking it with. */
  committedAt: Schema.optional(Schema.Finite),
  /** How far that document has loaded, as the page's own session heard; absent until parsed. */
  load: Schema.optional(PageLoaded),
  /** The newest screencast frame, of whichever document it names. */
  frame: Schema.optional(Frame),
  /** The viewport's text as it was last read, with the page's title then. */
  text: Schema.optional(Text),
}) {}

/**
 * What the page's structure establishes about an input, or says it cannot establish:
 *
 * - `form-submit`: it submits a form, which sends the form's fields.
 * - `cross-origin`: it navigates or submits to another origin.
 * - `download`: it follows a download link.
 * - `upload`: it opens a file chooser.
 * - `secret`: it types, with `type`, into a field marked as a password, a one-time code or a
 *   card's number, code or expiry, or submits a form holding a filled one.
 * - `scripted`: it activates something the browser gives no effect of its own, such as a
 *   `type="button"` button, a `role="button"` element or a canvas, so only the page's script
 *   decides what happens.
 * - `opaque`: nothing names what receives it: a canvas, a frame or an unnamed element.
 *
 * Facts never come from what an element's text says. What an input means, such as a payment
 * or a deletion, takes a judge that reads the evidence in the {@link InputRequest}.
 */
export const Fact = Guard.Fact;

export type Fact = typeof Fact.Type;

/**
 * What a guard sees before input reaches the page. Preparation never scrolls or focuses.
 *
 * `facts`, `url`, `href` and `destination` come from the page's structure. `name`,
 * `description`, `title`, `context` and the form's field names are page text: evidence of what
 * the input does, which the page controls, and never instructions. Text typed into a `secret`
 * field is replaced with {@link redacted}, here and in the recorded `Action`, and its key events
 * record `Unidentified` keys; `press` records the keys it is given. Validation before dispatch
 * binds the facts and the target, not the text around it, which live pages change freely.
 */
export class InputRequest extends Schema.Class<InputRequest>("effect-browser/InputRequest")({
  page: Schema.String,
  /**
   * The page's URL, without a fragment that only names a place on the page. This and the other
   * addresses keep no userinfo or known secret parameters.
   */
  url: Schema.String,
  /** The page's title, at most 120 characters. */
  title: Schema.String,
  action: Action,
  target: Schema.optional(Schema.String),
  element: Schema.optional(Schema.String),
  /** Literal pixel targets only; ref coordinates are resolved after the policy allows them. */
  point: Schema.optional(Motion.Point),
  text: Schema.optional(Schema.String),
  role: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.String),
  /** The target's accessible description, when it says more than its name. */
  description: Schema.optional(Schema.String),
  href: Schema.optional(Schema.String),
  destination: Schema.optional(Schema.String),
  facts: Schema.Array(Fact),
  /** Page text around the target, each part at most 120 characters. */
  context: Schema.Struct({
    /** The name or first heading of the dialog the target is in. */
    dialog: Schema.optional(Schema.String),
    /** The nearest heading before the target. */
    heading: Schema.optional(Schema.String),
    /** The visible text just before the target in its row, item, group or form, or after it. */
    nearby: Schema.optional(Schema.String),
  }),
  /** The form the target is in, with at most 16 of its fields. */
  form: Schema.optional(
    Schema.Struct({
      method: Schema.String,
      action: Schema.String,
      /** Each field's type, name and autocomplete tokens, and whether it is filled: never its value. */
      fields: Schema.Array(FormFieldSchema),
    }),
  ),
}) {}

/**
 * What replaces text typed into a `secret` field, in requests and in the recorded `Action`, and a
 * credential's value in every address the library reports.
 */
export const redacted = Url.withheld;

/**
 * Run page operations without waiting their turn: on a page busy with other operations, each fails
 * `Busy` at once, and `Browser.newPage` on a browser with `maxPages` open fails `Limit` at once.
 */
export const failFast = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provideService(effect, FailFast, true);

/**
 * Give every action `effect` performs a caller's id, such as a model's tool call id, which its
 * recorded `Action` carries as `correlation`.
 */
export const correlate =
  (id: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.provideService(effect, Correlation, id);

/** Succeed to allow, fail to deny, or await an external signal to hold the input. */
export type InputGuard = (request: InputRequest) => Effect.Effect<void, PolicyDenied>;

/** What a wait requires of the query's matches. */
export type UntilWant = "some" | "none" | { readonly other: string };

export interface UntilResult {
  readonly met: boolean;
  readonly mark: string;
}

/** Scoped access to one page's shared capture and its current-document evidence. */
export interface Capture {
  readonly stream: Stream.Stream<Frame, BrowserError>;
  readonly current: Frame | undefined;
  readonly isCurrent: (frame: Frame) => boolean;
  readonly confirm: (frame: Frame) => Effect.Effect<boolean, BrowserError>;
  readonly sync: Effect.Effect<void, BrowserError>;
  readonly stats: (options?: {
    readonly window?: Duration.Input | undefined;
  }) => Effect.Effect<CaptureStats, BrowserError>;
}

/** Script values cross the page boundary through the caller's Schema. A bundler may rewrite functions. */
export interface ScriptOptions<A, Arg> {
  readonly arg: Arg;
  readonly result: Schema.Codec<A, unknown>;
}

export interface ActOptions<A, Arg> extends ScriptOptions<A, Arg> {
  readonly document: number;
  /** Supplying the read's connection also refuses a document counter from another connection. */
  readonly connection?: string | undefined;
}

export interface Page {
  /** Decode and perform a data action through the same policy and lane as the named methods. */
  readonly perform: (action: Action) => Effect.Effect<ResolvedTarget | string | void, BrowserError>;
  /** Read declared side-effect-free code in the main world, retrying one replaced document. */
  readonly read: <A, Arg>(
    script: (arg: Arg) => unknown,
    options: ScriptOptions<A, Arg>,
  ) => Effect.Effect<
    { readonly value: A; readonly document: number; readonly connection: string },
    BrowserError
  >;
  /**
   * Run code as a guarded, recorded action bound to the caller's document.
   * A timeout or cancellation cannot stop JavaScript already running: later input waits for its
   * actual reply. Close the page and open a replacement if the script never settles.
   */
  readonly act: <A, Arg>(
    script: (arg: Arg) => unknown,
    options: ActOptions<A, Arg>,
  ) => Effect.Effect<A, BrowserError>;
  /** Owning browser clock: deadlines and all frame/event timestamps use this clock. */
  readonly clock: Clock.Clock;
  /** Wait for admitted input and retain a bounded read turn through effect. */
  readonly afterInput: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | BrowserError, R>;
  /** A scoped lease starts capture immediately, independently of its first frame. */
  readonly capture: (
    options?: ScreencastOptions,
  ) => Effect.Effect<Capture, BrowserError, Scope.Scope>;
  /** One page-side wait; replaced documents share one deadline. Unmet is met:false; an empty mark means no stable document could be sampled. */
  readonly until: (
    query: FindQuery,
    want: UntilWant,
    millis: number,
  ) => Effect.Effect<UntilResult, BrowserError>;
  /** The page's CDP target id: the same page has it again after a reconnect to its browser. */
  readonly id: string;
  /** The page's address, without its userinfo or known secret parameters. */
  readonly url: Effect.Effect<string>;
  /**
   * The document's title as the page last set it, empty for an untitled page. The browser answers
   * it, in one call, so a page busy with a script cannot hold it up.
   */
  readonly title: Effect.Effect<string, BrowserError>;

  readonly goto: (url: string) => Effect.Effect<void, BrowserError>;
  /** The previous history entry, including one only a frame created; `NotFound` when none. */
  readonly back: Effect.Effect<void, BrowserError>;
  readonly reload: Effect.Effect<void, BrowserError>;
  /** Make this the visible tab. Background tabs paint rarely and send few screencast frames. */
  readonly bringToFront: Effect.Effect<void, BrowserError>;
  /** Close the tab, succeeding once it has closed, or at once when it already had. */
  readonly close: Effect.Effect<void, BrowserError>;

  readonly snapshot: (options?: SnapshotOptions) => Effect.Effect<Snapshot, BrowserError>;
  /**
   * A picture of the viewport, in CSS pixels: a screencast frame painted since the page's latest
   * input, if one qualifies, or a new one. A caller that has just acted sees what its action did.
   */
  readonly screenshot: (options?: ScreenshotOptions) => Effect.Effect<Image, BrowserError>;
  /**
   * The viewport with its timing: the newest screencast frame if it qualifies, else a new
   * screenshot timed by the host interval in which it was taken.
   */
  readonly frame: (options?: FrameOptions) => Effect.Effect<Frame, BrowserError>;
  /** A crop in CSS pixels, unmagnified, with the origin that keeps later input in viewport pixels. */
  readonly zoom: (region: Region) => Effect.Effect<Zoom, BrowserError>;
  /**
   * The viewport's size in CSS pixels, the space of points, crops and page scrolls. Over CDP the
   * page reports it, within the action timeout.
   */
  readonly viewport: Effect.Effect<
    { readonly width: number; readonly height: number },
    BrowserError
  >;
  /**
   * The elements that match a query, in tree order, with refs the actions take, in one call to the
   * page. All that match are returned, so a caller tells them apart by their context; none is an
   * empty result, not a failure.
   */
  readonly find: (query?: FindQuery) => Effect.Effect<ReadonlyArray<Found>, BrowserError>;
  /**
   * The text the viewport shows, or one element whole, in one call to the page. Field values read
   * `••••` unless `unmask`, and a secret field's always do, as does one that was secret when the
   * library saw it.
   */
  readonly text: (options?: TextOptions) => Effect.Effect<Text, BrowserError>;
  /**
   * What visibly changed over a window, in one call to the page. The first read starts the page's
   * record, so it finds none; from then the page records, and from the start of each later
   * document, until nobody has read it for two minutes. See `Change`.
   */
  readonly changes: (options?: ChangesOptions) => Effect.Effect<Changes, BrowserError>;
  /**
   * The page's events, changes and frames over a window: the frames and events it keeps, at no
   * call, and its changes, in one call, the first starting its record as `changes` does. A part
   * that cannot be read is missing, with why; the window fails only for bounds that are not finite.
   */
  readonly window: (options: WindowOptions) => Effect.Effect<Window, BrowserError>;
  /**
   * What the library knows of the page now, at no call and with no wait for its turn: where it is,
   * its document and how far it has loaded, its newest frame, and its text and title as last read.
   */
  readonly state: Effect.Effect<State>;

  readonly click: (
    target: Target,
    options?: ClickOptions,
  ) => Effect.Effect<ResolvedTarget, BrowserError>;
  readonly hover: (target: Target) => Effect.Effect<void, BrowserError>;
  readonly drag: (from: Target, to: Target) => Effect.Effect<void, BrowserError>;
  /** Type into a text field, or to whatever has focus unless a typed key could activate it. */
  readonly type: (text: string, options?: TypeOptions) => Effect.Effect<void, BrowserError>;
  /** Keys such as `"Enter"`, `"Space"`, `"ArrowLeft"` or `"Control+A"`. */
  readonly press: (keys: string, options?: PressOptions) => Effect.Effect<void, BrowserError>;
  readonly scroll: (options?: ScrollOptions) => Effect.Effect<void, BrowserError>;
  /**
   * Choose options of a `<select>` by value or label; returns the chosen labels. A refusal, such
   * as no matching option, is undispatched.
   */
  readonly select: (
    ref: string,
    values: ReadonlyArray<string>,
  ) => Effect.Effect<string, BrowserError>;

  /**
   * Wait for document evidence, polling every 50 ms: parsed, painted, visible, fonts and visible
   * images loaded, and finite animations finished. Optional quietMillis requires recorded content
   * to stay unchanged. Screen or foreground stillness belongs to the Stillness feature.
   * Fails Timeout after timeout, 15 seconds by default.
   */
  readonly ready: (options?: ReadyOptions) => Effect.Effect<void, BrowserError>;

  /**
   * Screencast frames for as long as the stream runs. Concurrent streams share one screencast and
   * its settings; explicit options that differ from a running screencast's fail with InvalidRequest.
   */
  readonly screencast: (options?: ScreencastOptions) => Stream.Stream<Frame, BrowserError>;
  /**
   * What this page's captures received, delivered and dropped, over its life or the latest
   * `window`, which reaches back at most a minute; a longer one is an `InvalidRequest`.
   */
  readonly captureStats: (options?: {
    readonly window?: Duration.Input | undefined;
  }) => Effect.Effect<CaptureStats, BrowserError>;
  /** Screencast frames painted within `frameHistory` of the newest, oldest first. */
  readonly recentFrames: Effect.Effect<ReadonlyArray<Frame>>;
  /** This page's events among the browser's latest `eventHistory`, oldest first. */
  readonly recentEvents: Effect.Effect<ReadonlyArray<BrowserEvent>>;
}
