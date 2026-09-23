import { type Effect, type Option, Schema } from "effect";

import type { BrowserSession } from "../../Browser.ts";
import {
  Identifier,
  ObservedControl,
  SafeFilename,
  TargetUrl,
  type ViewportPoint,
} from "../../BrowserData.ts";
import {
  type BrowserOperation,
  type BrowserError,
  type BrowserOutcome,
  type BrowserReason,
} from "../../Errors.ts";

const uniqueBy = <A>(key: (value: A) => string, title: string) =>
  Schema.makeFilter((items: ReadonlyArray<A>) => new Set(items.map(key)).size === items.length, {
    title,
  });

/** Host-only facts a scripted control reports beyond what its observed fields imply. */
export const ControlFactsScript = Schema.Struct({
  editable: Schema.optionalKey(Schema.Boolean),
  formMethod: Schema.optionalKey(Schema.Literals(["get", "post", "dialog"])),
  hitTest: Schema.optionalKey(Schema.Literals(["self", "covered", "uncertain", "unsampled"])),
  placement: Schema.optionalKey(Schema.Literals(["inside", "partial", "outside"])),
  autocomplete: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(128))),
  box: Schema.optionalKey(
    Schema.Struct({
      x: Schema.Finite,
      y: Schema.Finite,
      width: Schema.Finite,
      height: Schema.Finite,
    }),
  ),
});

/**
 * One control a scripted document offers. `id` becomes the issued `elementId`, so a scripted
 * model turn can name it statically. Nothing here is a live capability.
 */
export const ControlScript = Schema.Struct({
  id: Identifier,
  kind: ObservedControl.fields.kind,
  label: ObservedControl.fields.label,
  disabled: Schema.optionalKey(Schema.Boolean),
  checked: Schema.optionalKey(Schema.Boolean),
  selected: Schema.optionalKey(Schema.Boolean),
  inputType: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(32))),
  required: Schema.optionalKey(Schema.Boolean),
  multiple: Schema.optionalKey(Schema.Boolean),
  /** The scripted select this option belongs to; it must be in the same document. */
  selectElementId: Schema.optionalKey(Identifier),
  /**
   * The link target, or the form action a submit control sends to: reported as the control's
   * destination fact, and where activating it leads. Only a `link`, or a `button`/`input` whose
   * `inputType` is `submit` or `image`, has one, because that is all a real document reports.
   */
  destination: Schema.optionalKey(TargetUrl),
  /** Where activation leads with no destination fact: what an `onclick` handler does. */
  activates: Schema.optionalKey(TargetUrl),
  /** Outside the viewport: absent from viewport readings and refused by hover. */
  offscreen: Schema.optionalKey(Schema.Boolean),
  /** What `readText({ selector: "#id" })` returns; defaults to the label. */
  text: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(65536))),
  /** Clicking for a download completes one with this name. */
  download: Schema.optionalKey(SafeFilename),
  facts: Schema.optionalKey(ControlFactsScript),
}).check(
  Schema.makeFilter(
    (control: {
      readonly kind: string;
      readonly inputType?: string;
      readonly destination?: string;
    }) =>
      control.destination === undefined ||
      control.kind === "link" ||
      ((control.kind === "button" || control.kind === "input") &&
        (control.inputType === "submit" || control.inputType === "image")),
    { title: "a destination only on a link or a submit control" },
  ),
);

export type ControlScript = typeof ControlScript.Type;

export const DocumentScript = Schema.Struct({
  url: TargetUrl,
  title: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(512))),
  text: Schema.String.check(Schema.isMaxLength(131072)),
  controls: Schema.optionalKey(
    Schema.Array(ControlScript).check(
      Schema.isMaxLength(64),
      uniqueBy((control: ControlScript) => control.id, "unique control ids"),
    ),
  ),
});

export type DocumentScript = typeof DocumentScript.Type;

/**
 * The documents a scripted browser can show. A navigation to a listed address reaches that
 * document; an unlisted address reaches an empty document with that address.
 */
export const Script = Schema.Struct({
  documents: Schema.Array(DocumentScript).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(64),
    uniqueBy((document: DocumentScript) => document.url, "unique document addresses"),
  ),
  /** The first page's document at connect; defaults to the first listed document. */
  start: Schema.optionalKey(TargetUrl),
});

export type Script = typeof Script.Type;

export class ScriptedReference extends Schema.Class<ScriptedReference>("ScriptedBrowserReference")({
  provider: Schema.Literal("scripted"),
  id: Identifier,
}) {}

export class ScriptedCleanupIssue extends Schema.Class<ScriptedCleanupIssue>(
  "ScriptedCleanupIssue",
)({
  step: Schema.Literals(["fence", "capture", "initialization", "disconnect"]),
  reason: Schema.Literals(["timeout", "failed", "interrupted"]),
}) {}

/** Connection teardown facts for a scripted browser; there is no process or provider status. */
export class ScriptedCleanupResult extends Schema.Class<ScriptedCleanupResult>(
  "ScriptedCleanupResult",
)({
  reference: ScriptedReference,
  connection: Schema.Literals(["closed", "failed", "not-connected", "pending"]),
  issues: Schema.Array(ScriptedCleanupIssue).check(Schema.isMaxLength(16)),
}) {}

/** The operations whose next admitted call a test may script. */
export const ScriptableOperation = Schema.Literals([
  "navigate",
  "navigate-stop",
  "observe",
  "checkpoint",
  "control-facts",
  "revalidate",
  "read-text",
  "screenshot",
  "wait",
  "click",
  "fill",
  "select-option",
  "scroll",
  "click-and-wait",
  "download-action",
  "select-files",
  "file-chooser",
  "pointer-move",
  "hover",
  "wheel",
  "press",
  "type",
  "list-pages",
  "list-frames",
  "select-page",
  "select-frame",
  "new-page",
  "close-page",
  "resize",
  "page-suspend",
  "page-resume",
  "capture-stop",
] satisfies ReadonlyArray<BrowserOperation>);

export type ScriptableOperation = typeof ScriptableOperation.Type;

/** A held native call: the test learns that it arrived, then decides when it may finish. */
export interface Gate {
  /** Resolves once the held call has reached the engine. */
  readonly reached: Effect.Effect<void>;
  /** Lets the held call finish normally. */
  readonly open: Effect.Effect<void>;
}

/**
 * What the next admitted call of one operation does instead of following the document model.
 * `Fail` with `outcome: "unknown"` dispatches first and then fails, so the owner fences the
 * session; the other outcomes never dispatch. `Hold` parks the call until its gate opens, before
 * or after native dispatch. `Disconnect` drops the connection inside the call.
 */
export type ScriptedOutcome =
  | { readonly _tag: "Fail"; readonly reason: BrowserReason; readonly outcome: BrowserOutcome }
  | { readonly _tag: "Hold"; readonly gate: Gate; readonly dispatched: boolean }
  | { readonly _tag: "Disconnect"; readonly dispatched?: boolean };

/** Evidence of one admitted call. It never carries filled values, typed text or addresses. */
export interface RecordedCall {
  readonly sequence: number;
  readonly operation: BrowserOperation;
  readonly pageId: string;
  readonly elementId?: string;
  readonly selector?: string;
  /** The engine was asked to act: the moment after which an outcome can be unknown. */
  readonly dispatched: boolean;
  readonly settled: "completed" | "failed" | "pending";
}

/** One frame a test hands to a running capture interval; omitted fields take defaults. */
export interface ScriptedFrame {
  readonly bytes?: Uint8Array;
  /** Presentation time in Unix milliseconds; defaults to forty milliseconds after the last frame. */
  readonly timestamp?: number;
  readonly viewportWidth?: number;
  readonly viewportHeight?: number;
}

/** What a page would see when it calls a registered binding: a reply, or a bare rejection. */
export type BindingReply = { readonly ok: true; readonly output: unknown } | { readonly ok: false };

export interface ScriptedControl {
  readonly calls: Effect.Effect<ReadonlyArray<RecordedCall>>;
  /** Arm the next admitted call of one operation. Arms are consumed one-shot in arming order. */
  readonly next: (operation: ScriptableOperation, outcome: ScriptedOutcome) => Effect.Effect<void>;
  readonly gate: Effect.Effect<Gate>;
  readonly document: {
    /** The selected page's document as it is now; `Closed` once there is no selected page. */
    readonly current: Effect.Effect<DocumentScript, BrowserError>;
    /**
     * The document is replaced, as a navigation replaces it: every retained node and every
     * pending wait on that page becomes stale, and a capture learns of a new document.
     */
    readonly replace: (next: DocumentScript) => Effect.Effect<void, BrowserError>;
    /**
     * The same document changes, as its own script would change it: controls that keep their
     * id keep their identity, removed ones detach, waits re-evaluate, nothing goes stale.
     */
    readonly update: (next: DocumentScript) => Effect.Effect<void, BrowserError>;
    /** What `fill` and `type` put into which control id. Never part of `calls`. */
    readonly values: Effect.Effect<ReadonlyMap<string, string>>;
    /** File names attached to which control id by file selection. */
    readonly files: Effect.Effect<ReadonlyMap<string, ReadonlyArray<string>>>;
  };
  /** The last point a pointer command placed, or null when none was placed yet. */
  readonly pointer: Effect.Effect<ViewportPoint | null>;
  readonly capture: {
    /** Deliver one frame to the interval capturing the selected page. */
    readonly emit: (frame?: ScriptedFrame) => Effect.Effect<void, BrowserError>;
  };
  /** A page-side call of a registered `Bootstrap.binding`, through the real admission path. */
  readonly invoke: (
    name: string,
    input: unknown,
    options?: { readonly origin?: string },
  ) => Effect.Effect<BindingReply>;
  /** The native connection drops; the owner reports the session as disconnected. */
  readonly disconnect: Effect.Effect<void>;
}

/** The real public session over the scripted engine, decorated the way owned sessions are. */
export interface ScriptedSession<E = never> extends BrowserSession<E> {
  readonly reference: ScriptedReference;
  readonly control: ScriptedControl;
  readonly closeChecked: Effect.Effect<ScriptedCleanupResult, BrowserError>;
  readonly close: Effect.Effect<ScriptedCleanupResult>;
  readonly cleanupResult: Effect.Effect<Option.Option<ScriptedCleanupResult>>;
}
