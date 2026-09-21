import { Schema } from "effect";

import { Identifier } from "./References.ts";
import { PositiveInt, SafeFilename, type UploadReceipt } from "./Transfers.ts";

export class Viewport extends Schema.Class<Viewport>("BrowserbaseViewport")(
  Schema.Struct({
    width: PositiveInt.check(Schema.isLessThanOrEqualTo(4096)),
    height: PositiveInt.check(Schema.isLessThanOrEqualTo(4096)),
  }).check(
    Schema.makeFilter((v) => v.width * v.height <= 8_388_608, {
      title: "at most 8,388,608 viewport pixels",
    }),
  ),
) {}

/** Page/frame IDs are connection-local; targetId is a separate Chromium identity. */

export class Target extends Schema.Class<Target>("BrowserbaseTarget")({
  generation: Schema.Natural,
  pageId: Identifier,
  frameId: Identifier,
}) {}

export class PageInfo extends Schema.Class<PageInfo>("BrowserbasePageInfo")({
  pageId: Identifier,
  targetId: Identifier,
  url: Schema.String.check(Schema.isMaxLength(8192)),
  title: Schema.String.check(Schema.isMaxLength(512)),
  selected: Schema.Boolean,
}) {}

export class FrameInfo extends Schema.Class<FrameInfo>("BrowserbaseFrameInfo")({
  frameId: Identifier,
  parentFrameId: Schema.NullOr(Identifier),
  url: Schema.String.check(Schema.isMaxLength(8192)),
  name: Schema.String.check(Schema.isMaxLength(256)),
}) {}

export class ObservedControl extends Schema.Class<ObservedControl>("BrowserbaseObservedControl")({
  elementId: Identifier,
  kind: Schema.Literals(["link", "button", "input", "select", "textarea", "other"]),
  label: Schema.String.check(Schema.isMaxLength(256)),
  disabled: Schema.Boolean,
}) {}

/**
 * How a viewport reading was bounded and what it left out. These are counts, so they are safe
 * to show a model. Visibility is geometry and hit-testing, never a pixel comparison: text is
 * kept when its line boxes intersect the viewport and the browser finds its own element at a
 * sampled point. `uncertainText` lay under something that takes no pointer events, which
 * hit-testing cannot see through, so it is left out rather than called visible.
 */
export class ViewportEvidence extends Schema.Class<ViewportEvidence>("BrowserbaseViewportEvidence")(
  {
    width: Schema.Finite,
    height: Schema.Finite,
    /** Text that crossed a viewport edge; only its lines on screen were kept. */
    clippedText: Schema.Natural,
    /** Left out: the browser found another element at the sampled point. */
    coveredText: Schema.Natural,
    uncertainText: Schema.Natural,
    /** Controls that intersect the viewport but cannot be reached there. */
    unreachableControls: Schema.Natural,
    /** The traversal budget ran out first, so this reading is known to be incomplete. */
    exhausted: Schema.Boolean,
  },
) {}

/**
 * Revision is admission fencing, not a claim of a complete DOM version or atomic snapshot. A
 * `viewport` reading holds only what is on screen and reachable; a `document` reading is the
 * whole body, wherever it is. Nothing here carries a destination, a form or a field value.
 */
export class Observation extends Schema.Class<Observation>("BrowserbaseObservation")({
  target: Target,
  observationId: Identifier,
  revision: Schema.Natural,
  scope: Schema.Literals(["document", "viewport"]),
  url: Schema.String.check(Schema.isMaxLength(8192)),
  text: Schema.String.check(Schema.isMaxLength(131072)),
  controls: Schema.Array(ObservedControl).check(Schema.isMaxLength(64)),
  controlsTruncated: Schema.Boolean,
  textTruncated: Schema.Boolean,
  viewport: ViewportEvidence,
}) {}

export class ObservedElement extends Schema.Class<ObservedElement>("BrowserbaseObservedElement")({
  observationId: Identifier,
  elementId: Identifier,
}) {}

/** Live, connection-owned receipt. It is not a durable promise that remote clocks remain held. */
export class PageSuspension extends Schema.Class<PageSuspension>("BrowserbasePageSuspension")({
  pageId: Identifier,
  targetId: Identifier,
  suspensionId: Identifier,
}) {}

export class PageExecutionState extends Schema.Class<PageExecutionState>(
  "BrowserbasePageExecutionState",
)({
  pageId: Identifier,
  targetId: Identifier,
  state: Schema.Literals(["running", "suspended", "unknown"]),
  suspensionId: Schema.optionalKey(Identifier),
}) {}

/** Explicit opt-out: this integration does not claim whole-browser network containment. */
export class BrowserPolicy extends Schema.Class<BrowserPolicy>("BrowserbaseBrowserPolicy")({
  network: Schema.Struct({ _tag: Schema.Literal("Unrestricted") }),
  maxActions: PositiveInt.check(Schema.isLessThanOrEqualTo(1000)),
  maxElapsedMillis: PositiveInt.check(Schema.isLessThanOrEqualTo(21_600_000)),
  maxReturnedBytes: PositiveInt.check(Schema.isLessThanOrEqualTo(8 * 1024 * 1024)),
}) {
  /**
   * Conservative bounds for trusted host code: 100 actions, five minutes, 2 MiB returned.
   * The network choice is spelled out in the name because Browserbase cannot prove a
   * narrower one; override any bound, never the network.
   */
  static unrestricted(
    bounds: Partial<
      Pick<BrowserPolicy, "maxActions" | "maxElapsedMillis" | "maxReturnedBytes">
    > = {},
  ): BrowserPolicy {
    return BrowserPolicy.make({
      network: { _tag: "Unrestricted" },
      maxActions: bounds.maxActions ?? 100,
      maxElapsedMillis: bounds.maxElapsedMillis ?? 5 * 60_000,
      maxReturnedBytes: bounds.maxReturnedBytes ?? 2 * 1024 * 1024,
    });
  }
}

export const TargetUrl = Schema.NonEmptyString.check(
  Schema.isMaxLength(8192),
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);

      return (
        ["http:", "https:"].includes(url.protocol) &&
        url.hostname !== "" &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  }),
);

export const Selector = Schema.NonEmptyString.check(Schema.isMaxLength(1024));

export class NavigateRequest extends Schema.Class<NavigateRequest>("BrowserbaseNavigateRequest")({
  url: TargetUrl,
}) {}

/**
 * A navigation left in flight. `timeoutMillis` is how long the browser may take to reach
 * DOMContentLoaded; omitted, it is the action timeout, as it is for `navigate`.
 */
export class StartNavigationRequest extends Schema.Class<StartNavigationRequest>(
  "BrowserbaseStartNavigationRequest",
)({
  url: TargetUrl,
  timeoutMillis: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 600000 })),
  ),
}) {}

export class ReadTextRequest extends Schema.Class<ReadTextRequest>("BrowserbaseReadTextRequest")({
  selector: Schema.optionalKey(Selector),
}) {}

export class ClickRequest extends Schema.Class<ClickRequest>("BrowserbaseClickRequest")({
  selector: Selector,
}) {}

export class FillRequest extends Schema.Class<FillRequest>("BrowserbaseFillRequest")({
  selector: Selector,
  value: Schema.String.check(Schema.isMaxLength(65536)),
}) {}

export class ScrollRequest extends Schema.Class<ScrollRequest>("BrowserbaseScrollRequest")({
  deltaX: Schema.Int.check(Schema.isBetween({ minimum: -100000, maximum: 100000 })),
  deltaY: Schema.Int.check(Schema.isBetween({ minimum: -100000, maximum: 100000 })),
}) {}

/**
 * CSS pixels in the main frame's viewport, the space Chromium dispatches pointer input in. It
 * is not a document offset, a device pixel, or a coordinate inside a child frame.
 */
export class ViewportPoint extends Schema.Class<ViewportPoint>("BrowserbaseViewportPoint")({
  x: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 16384 })),
  y: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 16384 })),
}) {}

/** A box in the viewport of the frame it was read from, in CSS pixels. */
export class ViewportRect extends Schema.Class<ViewportRect>("BrowserbaseViewportRect")({
  x: Schema.Finite,
  y: Schema.Finite,
  width: Schema.Finite,
  height: Schema.Finite,
}) {}

/**
 * What a host needs to decide whether a control may be acted on. Host-only: a destination can
 * carry a token, so none of this is part of the model-facing `Observation`. It never includes a
 * field's value or any markup.
 */
export class ControlFacts extends Schema.Class<ControlFacts>("BrowserbaseControlFacts")({
  kind: ObservedControl.fields.kind,
  label: ObservedControl.fields.label,
  disabled: Schema.Boolean,
  editable: Schema.Boolean,
  inputType: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(32))),
  autocomplete: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(128))),
  /** A resolved link target, or where this control submits its form. Absent when over-long. */
  destination: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2048))),
  formMethod: Schema.optionalKey(Schema.Literals(["get", "post", "dialog"])),
  box: ViewportRect,
  placement: Schema.Literals(["inside", "partial", "outside"]),
  /** `self`: the browser finds this control at its visible centre. Not a pixel comparison. */
  hitTest: Schema.Literals(["self", "covered", "uncertain", "unsampled"]),
  /** Only then is `box` in the main frame's viewport, the space pointer input uses. */
  mainFrame: Schema.Boolean,
}) {}

/**
 * Passive evidence for a recorder: what was on screen, and optionally a picture of it. It issues
 * no element references and never replaces the observation an agent's tools act on, so
 * inspecting, checkpointing and then acting on the inspected node all compose.
 *
 * It is host-only, because it carries control facts. Text and picture are read one after the
 * other, never atomically: the interval says when, and `documentChanged` says the document was
 * replaced in between, so the two may describe different documents.
 */
export class Checkpoint extends Schema.Class<Checkpoint>("BrowserbaseCheckpoint")({
  target: Target,
  revision: Schema.Natural,
  url: Schema.String.check(Schema.isMaxLength(8192)),
  text: Schema.String.check(Schema.isMaxLength(131072)),
  textTruncated: Schema.Boolean,
  controls: Schema.Array(ControlFacts).check(Schema.isMaxLength(64)),
  controlsTruncated: Schema.Boolean,
  viewport: ViewportEvidence,
  picture: Schema.optionalKey(
    Schema.Struct({ mediaType: Schema.Literal("image/png"), bytes: Schema.Uint8Array }),
  ),
  documentChanged: Schema.Boolean,
  startedMonotonicNanos: Schema.BigInt,
  completedMonotonicNanos: Schema.BigInt,
}) {}

const ReadingBounds = {
  maxTextBytes: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 131072 })),
  ),
  maxControls: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 64 }))),
};

/** Omitted bounds default at admission; `scope` defaults to the whole document. */
export const ObservationOptions = Schema.Struct({
  scope: Schema.optionalKey(Schema.Literals(["document", "viewport"])),
  ...ReadingBounds,
});

export type ObservationOptions = typeof ObservationOptions.Type;

/** A checkpoint always reads the viewport. `picture` adds a PNG of it, within the byte policy. */
export const CheckpointOptions = Schema.Struct({
  ...ReadingBounds,
  picture: Schema.optionalKey(Schema.Boolean),
});

export type CheckpointOptions = typeof CheckpointOptions.Type;

/** One native pointer move. Easing and pacing are the caller's: send the points you want. */
export class PointerMoveRequest extends Schema.Class<PointerMoveRequest>(
  "BrowserbasePointerMoveRequest",
)({ to: ViewportPoint }) {}

/** Moves the pointer onto one exact element where it is. It never scrolls to reach it. */
export class HoverRequest extends Schema.Class<HoverRequest>("BrowserbaseHoverRequest")({
  selector: Selector,
}) {}

const WheelDelta = Schema.Finite.check(Schema.isBetween({ minimum: -100000, maximum: 100000 }));

/**
 * One native wheel event where the pointer is, or at `at` after moving there first. The browser
 * chooses what scrolls, exactly as it would for a person, so a nested scroll container under
 * the pointer scrolls instead of the page.
 */
export class WheelRequest extends Schema.Class<WheelRequest>("BrowserbaseWheelRequest")({
  deltaX: WheelDelta,
  deltaY: WheelDelta,
  at: Schema.optionalKey(ViewportPoint),
}) {}

/**
 * The keys a `press` may name, spelled as the `KeyboardEvent.key` the page will see. The set is
 * closed on purpose: a key name is parsed by the native engine, so none reaches it unreviewed.
 */
export const NamedKey = Schema.Literals([
  "Enter",
  "Tab",
  "Backspace",
  "Delete",
  "Escape",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

export type NamedKey = typeof NamedKey.Type;

/** One printable ASCII character, space included: every one is a key on the US layout. */
const PrintableKey = Schema.String.check(Schema.isPattern(/^[\x20-\x7e]$/));

export const KeyModifier = Schema.Literals(["Shift", "Control", "Alt", "Meta"]);

export type KeyModifier = typeof KeyModifier.Type;

/** One key, down then up, with any modifiers held around it. */
export const KeyStroke = Schema.Struct({
  key: Schema.Union([NamedKey, PrintableKey]),
  modifiers: Schema.optionalKey(
    Schema.Array(KeyModifier).check(
      Schema.makeFilter((held) => new Set(held).size === held.length, {
        title: "each modifier at most once",
      }),
    ),
  ),
});

export type KeyStroke = typeof KeyStroke.Type;

/**
 * One real key stroke. It goes to whatever has focus in the page, exactly as it would for a
 * person, unless `into` names the one element that must already have it. It never focuses that
 * element, because that would hide a scripted focus inside a native-input operation: click it
 * first.
 */
export class PressRequest extends Schema.Class<PressRequest>("BrowserbasePressRequest")({
  ...KeyStroke.fields,
  into: Schema.optionalKey(Selector),
}) {}

/** Counted in characters, not UTF-16 units, because that is how many strokes it costs. */
const TypedText = Schema.NonEmptyString.check(
  Schema.makeFilter((text) => [...text].length <= 256, { title: "at most 256 characters" }),
  Schema.makeFilter(
    (text) =>
      [...text].every((character) => {
        const point = character.codePointAt(0) ?? 0;

        // An unpaired surrogate is not a character, and would not survive the wire as one.
        return point > 0x1f && point !== 0x7f && (point < 0xd800 || point > 0xdfff);
      }),
    { title: "no control characters or unpaired surrogates" },
  ),
);

/**
 * Text as the real key strokes that produce it, two native commands for each character, one
 * after another under a single action timeout: send a long passage as several shorter runs.
 * A character the US layout cannot produce is inserted as text, as an input method commits it,
 * and raises no key events. Control characters are refused, so a line break can never press
 * Enter from inside a run of text: a named key is always its own `press`. `into` works as it
 * does for `PressRequest`: a guard on where the text lands, never a focus.
 */
export class TypeRequest extends Schema.Class<TypeRequest>("BrowserbaseTypeRequest")({
  text: TypedText,
  into: Schema.optionalKey(Selector),
}) {}

/**
 * What native input was dispatched, where and when. `position` is the point this owner
 * commanded, or null when it has not yet placed the pointer on this page. The interval is on
 * the host monotonic clock that stamps `CapturedFrame.receivedMonotonicNanos`, so input and
 * pixels share one timeline. A wheel event is dispatched, not awaited: the receipt does not
 * claim the page finished scrolling, or that any frame shows it. A receipt never says which
 * key was pressed or what was typed.
 */
export class InputReceipt extends Schema.Class<InputReceipt>("BrowserbaseInputReceipt")({
  target: Target,
  kind: Schema.Literals(["pointer-move", "hover", "wheel", "press", "type"]),
  position: Schema.NullOr(ViewportPoint),
  delta: Schema.optionalKey(Schema.Struct({ x: WheelDelta, y: WheelDelta })),
  startedMonotonicNanos: Schema.BigInt,
  completedMonotonicNanos: Schema.BigInt,
}) {}

export class ScreenshotRequest extends Schema.Class<ScreenshotRequest>(
  "BrowserbaseScreenshotRequest",
)({ fullPage: Schema.Boolean }) {}

export class NavigationResult extends Schema.Class<NavigationResult>("BrowserbaseNavigationResult")(
  { url: TargetUrl },
) {}

export class ActionResult extends Schema.Class<ActionResult>("BrowserbaseActionResult")({
  url: TargetUrl,
}) {}

export class TextResult extends Schema.Class<TextResult>("BrowserbaseTextResult")({
  text: Schema.String.check(Schema.isMaxLength(8 * 1024 * 1024)),
}) {}

export class ScreenshotResult extends Schema.Class<ScreenshotResult>("BrowserbaseScreenshotResult")(
  {
    mediaType: Schema.Literal("image/png"),
    bytes: Schema.Uint8Array,
  },
) {}

const FileMediaType = Schema.NonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-z0-9][a-z0-9!#$&^_+.-]*\/[a-z0-9][a-z0-9!#$&^_+.-]*$/),
);

/** Small selection is in-memory by design: bytes the caller already holds, never a path. */
export class InlineFile extends Schema.Class<InlineFile>("BrowserbaseInlineFile")({
  name: SafeFilename,
  mediaType: FileMediaType,
  bytes: Schema.Uint8Array.check(
    Schema.makeFilter((value) => value.byteLength >= 1 && value.byteLength <= 1024 * 1024, {
      title: "between one byte and one mebibyte",
    }),
  ),
}) {}

export const InlineFiles = Schema.Array(InlineFile).check(
  Schema.isMaxLength(8),
  Schema.makeFilter(
    (files) =>
      files.length > 0 &&
      files.reduce((total, file) => total + file.bytes.byteLength, 0) <= 4 * 1024 * 1024,
    { title: "at most four mebibytes of in-memory selection" },
  ),
);

/**
 * The uploaded branch carries receipts, not paths. Attachment authority is the identity of a
 * receipt this package issued for this exact session, so decoding one back into a new value
 * would discard the very evidence being checked.
 */
export type FileSelection =
  | { readonly _tag: "Inline"; readonly files: ReadonlyArray<InlineFile> }
  | { readonly _tag: "Uploaded"; readonly uploads: ReadonlyArray<UploadReceipt> };

export interface SelectFilesRequest {
  readonly selector: string;
  readonly selection: FileSelection;
}

export const AutomationOptions = Schema.Struct({
  actionTimeoutMillis: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60000 })),
  ),
  maxPages: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32 }))),
  initialPage: Schema.optionalKey(
    Schema.Union([
      Schema.Struct({ targetId: Identifier }),
      Schema.Struct({ newPage: Schema.Literal(true) }),
    ]),
  ),
  popupPolicy: Schema.optionalKey(Schema.Literals(["retain", "close", "pause"])),
  dialogPolicy: Schema.optionalKey(Schema.Literals(["dismiss", "pause"])),
  pageControl: Schema.optionalKey(Schema.Boolean),
});

export type AutomationOptions = typeof AutomationOptions.Type;
