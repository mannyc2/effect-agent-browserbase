import { Schema } from "effect";

import { Identifier } from "./BrowserData.ts";
import { CaptureQualification } from "./CaptureData.ts";
import { BrowserOperation, BrowserOutcome, Containment } from "./Errors.ts";

/** One journal identity on one captured host clock; neither is a native credential. */
export const StoreIdentity = Schema.Struct({ storeId: Identifier, clockId: Identifier });
export type StoreIdentity = typeof StoreIdentity.Type;

export interface Retention {
  readonly maxDurationMillis: number;
  readonly maxEvents: number;
  readonly maxBytes: number;
  readonly maxSubscribers: number;
  readonly maxEventBytes: number;
}

export const TimelineDefaults: Retention = Object.freeze({
  maxDurationMillis: 60000,
  maxEvents: 4096,
  maxBytes: 4 * 1024 * 1024,
  maxSubscribers: 32,
  maxEventBytes: 64 * 1024,
});

export const TimelineMaximums: Retention = Object.freeze({
  maxDurationMillis: 21600000,
  maxEvents: 65536,
  maxBytes: 64 * 1024 * 1024,
  maxSubscribers: 256,
  maxEventBytes: 1024 * 1024,
});

const maximumInteger = (1n << 128n) - 1n;

const Sequence = Schema.BigInt.check(
  Schema.isGreaterThanOrEqualToBigInt(0n),
  Schema.isLessThanOrEqualToBigInt(maximumInteger),
);

const SequenceJson = Schema.BigIntFromString.check(
  Schema.isGreaterThanOrEqualToBigInt(0n),
  Schema.isLessThanOrEqualToBigInt(maximumInteger),
);

const Counter = Schema.Natural.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
const Geometry = Schema.Struct({ x: Schema.Finite, y: Schema.Finite });

export const Cursor = Schema.Struct({ ...StoreIdentity.fields, sequence: Sequence });
export type Cursor = typeof Cursor.Type;
export const CursorJson = Schema.Struct({ ...StoreIdentity.fields, sequence: SequenceJson });

/** An offset from this clock domain's origin, never a portable absolute monotonic instant. */
export const Stamp = Schema.Struct({ clockId: Identifier, offsetNanos: Sequence });
export type Stamp = typeof Stamp.Type;
export const StampJson = Schema.Struct({ clockId: Identifier, offsetNanos: SequenceJson });

export const Selector = Schema.Union([Cursor, Schema.Struct({ at: Stamp })]);
export type Selector = typeof Selector.Type;
export const SelectorJson = Schema.Union([CursorJson, Schema.Struct({ at: StampJson })]);

/** Null frame/document fields disclose unavailable attribution instead of inventing it. */
export const EvidenceTarget = Schema.Struct({
  generation: Counter,
  pageId: Identifier,
  frameId: Schema.NullOr(Identifier),
  document: Schema.NullOr(Counter),
});

export type EvidenceTarget = typeof EvidenceTarget.Type;

export const Correlation = Schema.Struct({
  runId: Identifier,
  stepId: Identifier,
  attemptId: Identifier,
  fieldIndex: Schema.optionalKey(Schema.Natural.check(Schema.isLessThanOrEqualTo(127))),
});

export type Correlation = typeof Correlation.Type;

export const TerminalReason = Schema.Literals([
  "closed",
  "detached",
  "disconnected",
  "faulted",
  "uncertain",
  "expired",
  "stale",
  "contained",
  "cancelled",
]);

export type TerminalReason = typeof TerminalReason.Type;

export const CaptureReason = Schema.Literals([
  "stopped",
  "parent-unavailable",
  "malformed-frame",
  "frame-limit",
  "timestamp-discontinuity",
  "resized",
  "target-changed",
  "duration-limit",
]);

export type CaptureReason = typeof CaptureReason.Type;
const TerminalScope = Schema.Literals(["session", "page"]);

const ActionKind = Schema.Literals([
  "Navigate",
  "Click",
  "Hover",
  "Fill",
  "Type",
  "Press",
  "Select",
  "Scroll",
  "PointerMove",
  "Wheel",
  "Wait",
  "FillForm",
]);

const FailureReason = Schema.Literals([
  "Configuration",
  "UnregisteredSession",
  "Unsupported",
  "Busy",
  "QueueFull",
  "QueueExpired",
  "Closed",
  "Stale",
  "NotFound",
  "Missing",
  "Ambiguous",
  "Incomplete",
  "Drifted",
  "Malformed",
  "Limit",
  "Timeout",
  "ScheduleMissed",
  "TimingBudgetExceeded",
  "Transport",
  "Provider",
  "Authorization",
  "RateLimited",
  "Disconnected",
  "Active",
  "Disabled",
  "Expired",
  "Failed",
  "UnsafeUrl",
  "ContentType",
  "Timestamp",
  "Resized",
  "TargetChanged",
  "Interrupted",
  "ContextLease",
  "NotVisible",
  "Denied",
  "NotFocused",
]);

/** Every payload tag; an omission names the one it stands for when that tag was readable. */
export const PayloadTag = Schema.Literals([
  "Planned",
  "Prepared",
  "Dispatched",
  "Acknowledged",
  "FollowUp",
  "Pointer",
  "Press",
  "Keys",
  "Scroll",
  "Glide",
  "Navigated",
  "CaptureBoundary",
  "Capture",
  "FirstFrame",
  "Picture",
  "Settled",
  "Contained",
  "Failed",
  "Cancelled",
  "Lifecycle",
  "PageOpened",
  "PageClosed",
  "DisplayChanged",
  "MetadataChanged",
  "Terminal",
  "MetadataOmitted",
]);

export type PayloadTag = typeof PayloadTag.Type;

const makeInterval = <S extends typeof Stamp | typeof StampJson>(stamp: S) =>
  Schema.Struct({
    start: stamp,
    end: stamp,
    qualification: Schema.Literal("native-call-interval"),
  });

export const Interval = makeInterval(Stamp);
export type Interval = typeof Interval.Type;
export const IntervalJson = makeInterval(StampJson);

const makePayload = <S extends typeof Stamp | typeof StampJson, A extends Schema.Struct.Fields>(
  stamp: S,
  address: A,
) => {
  const interval = makeInterval(stamp);
  const operationId = Schema.optionalKey(Identifier);

  const phase = {
    operation: BrowserOperation,
    operationId: Identifier,
    late: Schema.Boolean,
    nativeOrdinal: Schema.optionalKey(Counter),
    mutation: Schema.optionalKey(Schema.Boolean),
  };

  return Schema.Union([
    Schema.TaggedStruct("Planned", { action: ActionKind }),
    Schema.TaggedStruct("Prepared", phase),
    Schema.TaggedStruct("Dispatched", phase),
    Schema.TaggedStruct("Acknowledged", phase),
    Schema.TaggedStruct("FollowUp", phase),
    Schema.TaggedStruct("Pointer", {
      kind: Schema.Literals(["pointer-move", "hover"]),
      position: Schema.NullOr(Geometry),
      interval,
      operationId,
    }),
    Schema.TaggedStruct("Press", {
      position: Schema.NullOr(Geometry),
      intended: Schema.optionalKey(
        Schema.Struct({
          position: Geometry,
          relativePosition: Geometry,
          qualification: Schema.Literal("checked-exact-node-sample"),
        }),
      ),
      interval,
      operationId,
    }),
    Schema.TaggedStruct("Keys", {
      kind: Schema.Literals(["press", "type"]),
      count: Counter,
      countUnit: Schema.Literals(["unicode-codepoints", "logical-strokes"]),
      interval,
      operationId,
    }),
    Schema.TaggedStruct("Scroll", {
      kind: Schema.Literals(["wheel", "scroll"]),
      delta: Schema.NullOr(Geometry),
      interval,
      operationId,
      qualification: Schema.optionalKey(Schema.Literal("exact-node-scroll-into-view")),
    }),
    /** Reserved for an actual bounded intended schedule; individual pointer calls are Pointer. */
    Schema.TaggedStruct("Glide", {
      operationId,
      schedule: Schema.Array(Schema.Struct({ at: stamp, position: Geometry })).check(
        Schema.isMinLength(2),
        Schema.isMaxLength(128),
      ),
      qualification: Schema.Literal("intended-schedule"),
    }),
    Schema.TaggedStruct("Navigated", { sameDocument: Schema.Boolean, ...address }),
    Schema.TaggedStruct("CaptureBoundary", {
      captureId: Identifier,
      captureBoundary: Counter,
      captureDocument: Counter,
      sameDocument: Schema.Boolean,
      afterSequence: Schema.NullOr(Counter),
      observed: stamp,
      qualification: Schema.Literal("received-boundary-attribution"),
      ...address,
    }),
    Schema.TaggedStruct("Capture", {
      captureId: Identifier,
      phase: Schema.Literals(["Reserved", "Watching", "Started", "Ended", "Stopped"]),
      latePhase: Schema.Boolean,
      observed: stamp,
      captureBoundary: Counter,
      captureDocument: Counter,
      qualification: CaptureQualification,
      reason: Schema.NullOr(CaptureReason),
      nativeStop: Schema.NullOr(Schema.Literals(["confirmed", "unconfirmed"])),
      received: Counter,
      delivered: Counter,
      discarded: Counter,
      overflow: Counter,
      late: Counter,
      duplicates: Counter,
      rejected: Counter,
      upstreamDrops: Schema.Literal("unknown"),
    }),
    Schema.TaggedStruct("FirstFrame", {
      captureId: Identifier,
      frameSequence: Counter,
      captureDocument: Counter,
      captureBoundary: Counter,
      sourceTimeMillis: Schema.Finite.check(Schema.isGreaterThan(0)),
      sourceClock: Schema.Literal("presentation-unix-millis"),
      received: stamp,
      width: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16384 })),
      height: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16384 })),
      viewportWidth: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16384 })),
      viewportHeight: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16384 })),
      qualification: Schema.Literal("received-boundary-attribution"),
    }),
    Schema.TaggedStruct("Picture", {
      mediaType: Schema.Literals(["image/png", "image/jpeg"]),
      nativeRequest: stamp,
      nativeReturn: stamp,
      requestDocument: Schema.NullOr(Counter),
      returnDocument: Schema.NullOr(Counter),
      width: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16384 }))),
      height: Schema.optionalKey(
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16384 })),
      ),
      qualification: Schema.Literal("native-call-interval"),
      operationId,
    }),
    Schema.TaggedStruct("Settled", {
      quietMillis: Schema.Finite.check(Schema.isGreaterThan(0)),
      withinMillis: Schema.Finite.check(Schema.isGreaterThan(0)),
      signals: Schema.Array(
        Schema.Literals(["dom-mutation", "scroll", "root-geometry", "viewport"]),
      ).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
      operationId,
    }),
    Schema.TaggedStruct("Contained", { containment: Containment }),
    Schema.TaggedStruct("Failed", {
      operation: BrowserOperation,
      reason: FailureReason,
      outcome: BrowserOutcome,
      operationId,
    }),
    Schema.TaggedStruct("Cancelled", { outcome: BrowserOutcome, operationId }),
    Schema.TaggedStruct("Lifecycle", {
      phase: Schema.Literals([
        "acquiring",
        "open",
        "paused",
        "detached",
        "faulted",
        "uncertain",
        "closing",
        "closed",
      ]),
    }),
    Schema.TaggedStruct("PageOpened", {}),
    Schema.TaggedStruct("PageClosed", {}),
    Schema.TaggedStruct("DisplayChanged", {
      selected: Schema.Boolean,
      displayState: Schema.Literals(["running", "held", "unknown"]),
    }),
    Schema.TaggedStruct("MetadataChanged", {}),
    Schema.TaggedStruct("Terminal", { scope: TerminalScope, reason: TerminalReason }),
    Schema.TaggedStruct("MetadataOmitted", {
      reason: Schema.Literals(["Malformed", "Oversized"]),
      originalTag: Schema.NullOr(PayloadTag),
    }),
  ]);
};

const hostAddress = {
  url: Schema.NullOr(Schema.String.check(Schema.isMaxLength(8192))),
  urlQualification: Schema.Literals(["NativeCached", "Unread", "Omitted"]),
};

/** Host metadata: addresses are qualified facts; text, descriptors, bytes and native objects stay absent. */
export const Payload = makePayload(Stamp, hostAddress);
export type Payload = typeof Payload.Type;
export const PayloadJson = makePayload(StampJson, hostAddress);
export const ClientPayload = makePayload(Stamp, {});
export type ClientPayload = typeof ClientPayload.Type;
export const ClientPayloadJson = makePayload(StampJson, {});

const envelopeFields = {
  version: Schema.Literal(1),
  ...StoreIdentity.fields,
  target: Schema.NullOr(EvidenceTarget),
  correlation: Schema.NullOr(Correlation),
};

const coherentClock = (value: {
  readonly clockId: string;
  readonly at: Stamp;
  readonly event: ClientPayload;
}): boolean => {
  if (value.at.clockId !== value.clockId) return false;
  const matches = (stamp: Stamp) => stamp.clockId === value.clockId;
  const event = value.event;

  switch (event._tag) {
    case "Pointer":
    case "Press":
    case "Keys":
    case "Scroll":
      return (
        matches(event.interval.start) &&
        matches(event.interval.end) &&
        event.interval.end.offsetNanos >= event.interval.start.offsetNanos
      );
    case "Picture":
      return (
        matches(event.nativeRequest) &&
        matches(event.nativeReturn) &&
        event.nativeReturn.offsetNanos >= event.nativeRequest.offsetNanos
      );
    case "FirstFrame":
      return matches(event.received);
    case "Capture":
    case "CaptureBoundary":
      return matches(event.observed);
    case "Glide":
      return event.schedule.every(
        (sample, index) =>
          matches(sample.at) &&
          (index === 0 ||
            sample.at.offsetNanos >= (event.schedule[index - 1]?.at.offsetNanos ?? 0n)),
      );
    case "Planned":
    case "Prepared":
    case "Dispatched":
    case "Acknowledged":
    case "FollowUp":
    case "Navigated":
    case "Settled":
    case "Contained":
    case "Failed":
    case "Cancelled":
    case "Lifecycle":
    case "PageOpened":
    case "PageClosed":
    case "DisplayChanged":
    case "MetadataChanged":
    case "Terminal":
    case "MetadataOmitted":
      return true;
  }
};

const clockCheck = Schema.makeFilter(coherentClock, {
  title: "coherent clock domain and ordered native intervals",
});

export const Event = Schema.Struct({
  ...envelopeFields,
  sequence: Sequence,
  at: Stamp,
  event: Payload,
}).check(clockCheck);

export type Event = typeof Event.Type;

export const EventJson = Schema.Struct({
  ...envelopeFields,
  sequence: SequenceJson,
  at: StampJson,
  event: PayloadJson,
}).check(clockCheck);

export const ClientEvent = Schema.Struct({
  ...envelopeFields,
  sequence: Sequence,
  at: Stamp,
  event: ClientPayload,
}).check(clockCheck);

export type ClientEvent = typeof ClientEvent.Type;

export const ClientEventJson = Schema.Struct({
  ...envelopeFields,
  sequence: SequenceJson,
  at: StampJson,
  event: ClientPayloadJson,
}).check(clockCheck);

export const Terminal = Schema.Struct({
  cursor: Cursor,
  at: Stamp,
  scope: TerminalScope,
  reason: TerminalReason,
});

export type Terminal = typeof Terminal.Type;

export const TerminalJson = Schema.Struct({
  cursor: CursorJson,
  at: StampJson,
  scope: TerminalScope,
  reason: TerminalReason,
});

const snapshotFields = { evicted: Counter, retainedBytes: Counter };

export const Snapshot = Schema.Struct({
  ...snapshotFields,
  events: Schema.Array(Event).check(Schema.isMaxLength(65536)),
  oldest: Schema.NullOr(Cursor),
  newest: Schema.NullOr(Cursor),
  resumeAfter: Cursor,
  evictedThrough: Cursor,
  terminal: Schema.NullOr(Terminal),
});

export type Snapshot = typeof Snapshot.Type;

export const SnapshotJson = Schema.Struct({
  ...snapshotFields,
  events: Schema.Array(EventJson).check(Schema.isMaxLength(65536)),
  oldest: Schema.NullOr(CursorJson),
  newest: Schema.NullOr(CursorJson),
  resumeAfter: CursorJson,
  evictedThrough: CursorJson,
  terminal: Schema.NullOr(TerminalJson),
});

export const SnapshotOptions = Schema.Struct({ from: Schema.optionalKey(Selector) });
export type SnapshotOptions = typeof SnapshotOptions.Type;

export class TimelineGap extends Schema.TaggedError<TimelineGap>()("TimelineGap", {
  requested: Selector,
  oldest: Schema.NullOr(Cursor),
  newest: Schema.NullOr(Cursor),
  resumeAfter: Cursor,
  evictedThrough: Cursor,
}) {}

export class TimelineCursorError extends Schema.TaggedError<TimelineCursorError>()(
  "TimelineCursorError",
  {
    reason: Schema.Literals(["Store", "Clock", "Future"]),
    requested: Selector,
    current: Cursor,
  },
) {}

export class TimelineLimit extends Schema.TaggedError<TimelineLimit>()("TimelineLimit", {
  maximum: Counter,
  observed: Counter,
}) {}

export class TimelineMalformed extends Schema.TaggedError<TimelineMalformed>()(
  "TimelineMalformed",
  {
    path: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
  },
) {}

export type TimelineError = TimelineGap | TimelineCursorError | TimelineLimit | TimelineMalformed;

/** Cached host state from the canonical native registry; it grants no Page authority. */
export const CachedPage = Schema.Struct({
  identity: EvidenceTarget,
  targetId: Schema.NullOr(Identifier),
  url: Schema.NullOr(Schema.String.check(Schema.isMaxLength(8192))),
  urlQualification: Schema.Literals(["NativeCached", "Unread", "Omitted"]),
  title: Schema.NullOr(Schema.String.check(Schema.isMaxLength(512))),
  titleQualification: Schema.Literals(["ObservedCached", "Unread", "Omitted"]),
  selected: Schema.Boolean,
  displayState: Schema.Literals(["running", "held", "unknown"]),
  phase: Schema.Literals(["open", "paused", "closing", "closed", "stale"]),
  containment: Containment,
});

export type CachedPage = typeof CachedPage.Type;

export const PagesInventory = Schema.TaggedStruct("Inventory", {
  pages: Schema.Array(CachedPage).check(Schema.isMaxLength(32)),
  resumeAfter: Cursor,
});

export type PagesInventory = typeof PagesInventory.Type;
export const PageEvent = Schema.Union([PagesInventory, Event]);
export type PageEvent = typeof PageEvent.Type;

export const ClientPage = Schema.Struct({
  identity: EvidenceTarget,
  selected: Schema.Boolean,
  displayState: CachedPage.fields.displayState,
  phase: CachedPage.fields.phase,
  containment: Containment,
});

export type ClientPage = typeof ClientPage.Type;

export const ClientPagesInventory = Schema.TaggedStruct("Inventory", {
  pages: Schema.Array(ClientPage).check(Schema.isMaxLength(32)),
  resumeAfter: Cursor,
});

export type ClientPagesInventory = typeof ClientPagesInventory.Type;
export const ClientPageEvent = Schema.Union([ClientPagesInventory, ClientEvent]);
export type ClientPageEvent = typeof ClientPageEvent.Type;

export const ClientPageEventJson = Schema.Union([
  Schema.TaggedStruct("Inventory", {
    pages: Schema.Array(ClientPage).check(Schema.isMaxLength(32)),
    resumeAfter: CursorJson,
  }),
  ClientEventJson,
]);
