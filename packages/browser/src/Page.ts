/**
 * One browser tab: navigation, snapshots, pictures and input.
 *
 * Input dispatch is serialized across the browser's pages; navigation is serialized only with
 * its own page. An action waits for its own page (other operations, unresolved input replies)
 * before joining the browser-wide queue, and its timeout bounds those waits before a full timeout
 * bounds the action itself. A policy holds outside the input locks while other actions continue;
 * its target is revalidated before dispatch. Element targets are refs from a snapshot; point
 * targets are viewport coordinates in CSS pixels, the same coordinates as a screenshot's pixels.
 * Mouse and keyboard input share a bounded pipeline, so pacing does not wait for each protocol
 * reply. Target lookup happens before the input is sent.
 *
 * @since 0.3.0
 */
import { type Duration, type Effect, type Option, Schema, type Stream } from "effect";
import type { Page as PlaywrightPage } from "playwright-core";

import type { BrowserError, PolicyDenied } from "./BrowserError.ts";
import type { BrowserEvent } from "./BrowserEvent.ts";
import { type CaptureStats, type Frame, Image, type ScreencastOptions } from "./Frame.ts";
import { FormFieldSchema } from "./internal/input/evidence.inpage.ts";
import * as Guard from "./internal/input/guard.inpage.ts";
import { Snapshot, type SnapshotOptions } from "./Snapshot.ts";

export interface Point {
  readonly x: number;
  readonly y: number;
}

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
  point: Schema.Struct({ x: Schema.Finite, y: Schema.Finite }),
  element: Schema.String,
  /** The element's lowercase tag name. */
  tag: Schema.String,
  role: Schema.NullOr(Schema.String),
  name: Schema.String,
  cursor: Schema.String,
  href: Schema.optional(Schema.String),
}) {}

export interface ClickOptions {
  readonly button?: "left" | "right" | "middle" | undefined;
  /** 2 for a double click. */
  readonly clickCount?: number | undefined;
  /** Hold the button down this long before releasing it. */
  readonly holdMillis?: number | undefined;
}

export interface TypeOptions {
  /** Type into this text field: it is focused first, and its content replaced unless `replace` is false. */
  readonly into?: string | undefined;
  readonly replace?: boolean | undefined;
  /** Press Enter afterwards. */
  readonly submit?: boolean | undefined;
  /** Allow corrected slips when replacing an explicit eligible prose ref while humanized. Sensitive fields stay exact. */
  readonly prose?: boolean | undefined;
}

export interface PressOptions {
  /** Press the keys this many times. */
  readonly times?: number | undefined;
  /** Hold the keys down this long before releasing them, as a game control might need. */
  readonly holdMillis?: number | undefined;
}

export interface ScrollOptions {
  readonly dx?: number | undefined;
  /** Pixels to scroll down; negative scrolls up. Defaults to most of a viewport. */
  readonly dy?: number | undefined;
  /** Scroll whatever is under this point or element. Defaults to the middle of the viewport. */
  readonly at?: Target | undefined;
}

export interface ScreenshotOptions {
  /** Capture a new image even when a screencast frame is available. */
  readonly fresh?: boolean | undefined;
  /** A region of the viewport, captured in CSS pixels at the viewport's own scale. */
  readonly clip?:
    | { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
    | undefined;
  /** JPEG quality, 0 to 100. Defaults to 80. */
  readonly quality?: number | undefined;
}

/** What to include in an observation of the current viewport. */
export type ObservationMode = "outline" | "screenshot" | "both";

/** One observation, suitable for passing between an agent and its consumer. */
export class Observation extends Schema.Class<Observation>("effect-browser/Observation")({
  snapshot: Schema.optional(Snapshot),
  image: Schema.optional(Image),
  /** Host monotonic milliseconds from the browser's captured Effect Clock. */
  at: Schema.Finite,
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
  /** The page's URL, without a fragment that only names a place on the page. */
  url: Schema.String,
  /** The page's title, at most 120 characters. */
  title: Schema.String,
  action: Schema.String,
  target: Schema.optional(Schema.String),
  element: Schema.optional(Schema.String),
  /** Literal pixel targets only; ref coordinates are resolved after the policy allows them. */
  point: Schema.optional(Schema.Struct({ x: Schema.Finite, y: Schema.Finite })),
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

/** What replaces text typed into a `secret` field, in requests and in the recorded `Action`. */
export const redacted = "••••••••";

/** Succeed to allow, fail to deny, or await an external signal to hold the input. */
export type InputGuard = (request: InputRequest) => Effect.Effect<void, PolicyDenied>;

export interface Settings {
  readonly actionTimeout: Duration.Duration;
  readonly policyTimeout: Duration.Duration;
  readonly navigationTimeout: Duration.Duration;
  /** Move the pointer along curved paths and type with human pacing, for watched browsing. */
  readonly humanize: boolean;
  /** How long screencast frames stay in `recentFrames`, measured back from the newest. */
  readonly frameHistory: Duration.Duration;
  readonly guard: InputGuard | undefined;
}

export interface Page {
  readonly id: string;
  /** The Playwright page, for anything this API does not cover. Never give it to a model. */
  readonly playwright: PlaywrightPage;
  readonly url: Effect.Effect<string>;
  readonly title: Effect.Effect<string, BrowserError>;

  readonly goto: (url: string) => Effect.Effect<void, BrowserError>;
  /** The previous history entry, including one only a frame created; `NotFound` when none. */
  readonly back: Effect.Effect<void, BrowserError>;
  readonly reload: Effect.Effect<void, BrowserError>;
  /** Make this the visible tab. Background tabs paint rarely and send few screencast frames. */
  readonly bringToFront: Effect.Effect<void, BrowserError>;
  readonly close: Effect.Effect<void>;

  readonly snapshot: (options?: SnapshotOptions) => Effect.Effect<Snapshot, BrowserError>;
  /**
   * A picture of the viewport: the latest screencast frame when no action is changing the page and
   * it was painted after the latest input and delivered within the last 250 ms, else a new
   * screenshot.
   */
  readonly screenshot: (options?: ScreenshotOptions) => Effect.Effect<Image, BrowserError>;
  /**
   * The viewport now, with its timing: the newest screencast frame under the same rule as
   * `screenshot`, else a new screenshot timed by the host interval in which it was taken.
   */
  readonly currentFrame: Effect.Effect<Frame, BrowserError>;
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
  /** An outline, a picture, or both (the default), taken together. */
  readonly observe: (options?: {
    readonly mode?: ObservationMode;
    readonly full?: boolean;
    readonly maxChars?: number;
  }) => Effect.Effect<Observation, BrowserError>;
  readonly hasText: (text: string) => Effect.Effect<boolean, BrowserError>;

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

  readonly waitForText: (
    text: string,
    timeout?: Duration.Input,
  ) => Effect.Effect<void, BrowserError>;
  /**
   * Wait until the screen stops changing, such as reels coming to rest: no frame for `quietMillis`
   * (600 by default). Needs no running screencast; one it starts counts from its first frame.
   */
  readonly waitForStill: (options?: {
    readonly quietMillis?: number;
    readonly timeout?: Duration.Input;
  }) => Effect.Effect<void, BrowserError>;

  /**
   * Screencast frames for as long as the stream runs. Concurrent streams share one screencast and
   * its settings; explicit options that differ from a running screencast's fail with InvalidRequest.
   */
  readonly screencast: (options?: ScreencastOptions) => Stream.Stream<Frame, BrowserError>;
  /** Native delivery, filtering and observed subscriber loss across capture generations. */
  readonly captureStats: Effect.Effect<CaptureStats>;
  readonly latestFrame: Effect.Effect<Option.Option<Frame>>;
  /** Screencast frames painted within `frameHistory` of the newest, oldest first. */
  readonly recentFrames: Effect.Effect<ReadonlyArray<Frame>>;
  /** This page's events among the browser's latest `eventHistory`, oldest first. */
  readonly recentEvents: Effect.Effect<ReadonlyArray<BrowserEvent>>;
}
