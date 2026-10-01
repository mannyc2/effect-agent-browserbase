import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import * as Timeline from "effect-browser/timeline";
import {
  ClientPageEventJson,
  CursorJson,
  type Event,
  EventJson,
  type PageEvent,
  type Payload,
  SelectorJson,
  type Snapshot,
  SnapshotJson,
} from "effect-browser/timeline-data";

// The timeline's JSON is a wire format: these encodings were captured from the hand-written
// codecs before the JSON schemas were derived, and must stay byte-identical.

const stamp = (offsetNanos: bigint) => ({ clockId: "clock-1", offsetNanos });

const interval = {
  start: stamp(10n),
  end: stamp(20n),
  qualification: "native-call-interval",
} as const;

const phase = { operation: "click", operationId: "op-1", late: false } as const;

const event = (sequence: bigint, payload: Payload, attributed = true): Event => ({
  version: 1,
  storeId: "store-1",
  clockId: "clock-1",
  target: attributed ? { generation: 2, pageId: "page-1", frameId: "frame-1", document: 3 } : null,
  correlation: attributed
    ? { runId: "run-1", stepId: "step-1", attemptId: "attempt-1", fieldIndex: 0 }
    : null,
  sequence,
  at: stamp(5n),
  event: payload,
});

/** One event per payload tag, with optional fields both present and absent. */
const payloads: ReadonlyArray<Payload> = [
  { _tag: "Planned", action: "FillForm" },
  { _tag: "Prepared", ...phase },
  { _tag: "Dispatched", ...phase, nativeOrdinal: 1, mutation: true },
  {
    _tag: "Acknowledged",
    ...phase,
    acknowledgement: { subphase: "key-burst", logicalComplete: false },
  },
  { _tag: "FollowUp", operation: "type", operationId: "op-2", late: true },
  { _tag: "Pointer", kind: "hover", position: { x: 1.5, y: 2 }, interval, operationId: "op-3" },
  {
    _tag: "Press",
    position: null,
    intended: {
      position: { x: 4, y: 5 },
      relativePosition: { x: 1, y: 1 },
      qualification: "checked-exact-node-sample",
    },
    interval,
  },
  {
    _tag: "Keys",
    kind: "type",
    count: 3,
    countUnit: "unicode-codepoints",
    interval,
    operationId: "op-4",
  },
  {
    _tag: "Scroll",
    kind: "scroll",
    delta: { x: 0, y: 700 },
    interval,
    qualification: "exact-node-scroll-into-view",
  },
  {
    _tag: "Glide",
    operationId: "op-5",
    schedule: [
      { at: stamp(30n), position: { x: 0, y: 0 } },
      { at: stamp(2n ** 70n), position: { x: 10.25, y: 20 } },
    ],
    qualification: "intended-schedule",
  },
  {
    _tag: "Navigated",
    sameDocument: false,
    url: "https://example.test/a",
    urlQualification: "NativeCached",
  },
  {
    _tag: "CaptureBoundary",
    captureId: "capture-1",
    captureBoundary: 1,
    captureDocument: 2,
    sameDocument: true,
    afterSequence: null,
    observed: stamp(40n),
    qualification: "received-boundary-attribution",
    url: null,
    urlQualification: "Unread",
  },
  {
    _tag: "Capture",
    captureId: "capture-1",
    phase: "Stopped",
    latePhase: false,
    observed: stamp(50n),
    captureBoundary: 0,
    captureDocument: 1,
    qualification: {
      authority: "open",
      containment: { _tag: "NotRequired" },
      ownerPhase: "open",
      ownerGeneration: 2,
    },
    reason: "stopped",
    nativeStop: "confirmed",
    received: 10,
    delivered: 9,
    discarded: 1,
    overflow: 0,
    late: 1,
    duplicates: 0,
    rejected: 0,
    upstreamDrops: "unknown",
  },
  {
    _tag: "FirstFrame",
    captureId: "capture-1",
    frameSequence: 0,
    captureDocument: 1,
    captureBoundary: 0,
    sourceTimeMillis: 1790000000000.5,
    sourceClock: "presentation-unix-millis",
    received: stamp(60n),
    width: 1280,
    height: 720,
    viewportWidth: 1280,
    viewportHeight: 720,
    qualification: "received-boundary-attribution",
  },
  {
    _tag: "Picture",
    mediaType: "image/png",
    nativeRequest: stamp(70n),
    nativeReturn: stamp(80n),
    requestDocument: 1,
    returnDocument: null,
    width: 10,
    qualification: "native-call-interval",
    operationId: "op-6",
  },
  {
    _tag: "Settled",
    quietMillis: 100,
    withinMillis: 1000,
    signals: ["dom-mutation", "viewport"],
    operationId: "op-7",
  },
  { _tag: "Contained", containment: { _tag: "PagePaused", pageId: "page-1", generation: 2 } },
  {
    _tag: "Failed",
    operation: "click",
    reason: "NotFocused",
    outcome: "undispatched",
    operationId: "op-8",
  },
  { _tag: "Cancelled", outcome: "unknown" },
  { _tag: "Lifecycle", phase: "open" },
  { _tag: "PageOpened" },
  { _tag: "PageClosed" },
  { _tag: "DisplayChanged", selected: true, displayState: "held" },
  { _tag: "MetadataChanged" },
  { _tag: "Terminal", scope: "page", reason: "contained" },
  { _tag: "MetadataOmitted", reason: "Oversized", originalTag: "Glide" },
];

const events = payloads.map((payload, index) =>
  event(BigInt(index + 1), payload, payload._tag !== "Lifecycle"),
);

const cursor = (sequence: bigint) => ({ storeId: "store-1", clockId: "clock-1", sequence });

const snapshot: Snapshot = {
  evicted: 1,
  retainedBytes: 512,
  events: events.slice(0, 1),
  oldest: cursor(1n),
  newest: cursor(1n),
  resumeAfter: cursor(1n),
  evictedThrough: cursor(0n),
  terminal: { cursor: cursor(1n), at: stamp(90n), scope: "session", reason: "closed" },
};

const inventory: PageEvent = {
  _tag: "Inventory",
  pages: [
    {
      identity: { generation: 2, pageId: "page-1", frameId: null, document: null },
      targetId: "target-1",
      url: "https://example.test/private",
      urlQualification: "NativeCached",
      title: "Private title",
      titleQualification: "ObservedCached",
      selected: true,
      displayState: "running",
      phase: "open",
      containment: { _tag: "NotRequired" },
    },
  ],
  resumeAfter: cursor(7n),
};

/** The payload part of an encoded event, read back from its JSON. */
const payloadOf = (encoded: unknown) =>
  JSON.stringify((encoded as { readonly event: unknown }).event);

const json = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(Effect.map((value) => JSON.stringify(value)));

it.effect("timeline JSON keeps its captured wire format", () =>
  Effect.gen(function* () {
    const encoded = yield* Effect.forEach(events, (value) => Schema.encodeEffect(EventJson)(value));

    expect(JSON.stringify(encoded[0])).toBe(ENVELOPE);
    expect(JSON.stringify(encoded[19])).toBe(UNATTRIBUTED);
    expect(encoded.map(payloadOf)).toEqual(PAYLOADS);
    // Only these two payloads carry host addresses, which the client projection removes.
    expect(
      yield* Effect.forEach(
        events.filter(
          ({ event }) => event._tag === "Navigated" || event._tag === "CaptureBoundary",
        ),
        (value) => Timeline.encodeClient(value).pipe(Effect.map(payloadOf)),
      ),
    ).toEqual(CLIENT_PAYLOADS);
    expect(yield* json(Schema.encodeEffect(SnapshotJson)(snapshot))).toBe(SNAPSHOT);
    expect(yield* json(Schema.encodeEffect(CursorJson)(cursor(2n ** 80n)))).toBe(CURSOR);
    expect(yield* json(Schema.encodeEffect(SelectorJson)({ at: stamp(2n ** 100n) }))).toBe(AT);
    expect(yield* json(Timeline.encodePages(inventory))).toBe(INVENTORY);
    expect(
      yield* json(
        Timeline.projectPages(inventory).pipe(
          Effect.flatMap(Schema.encodeEffect(ClientPageEventJson)),
        ),
      ),
    ).toBe(INVENTORY);
  }),
);

it.effect("every encoded event decodes back to the original", () =>
  Effect.gen(function* () {
    for (const value of events)
      expect(yield* Timeline.decode(yield* Timeline.encode(value))).toEqual(value);
    expect(yield* Timeline.decodeCursor(yield* Timeline.encodeCursor(cursor(2n ** 80n)))).toEqual(
      cursor(2n ** 80n),
    );
    expect(
      yield* Schema.decodeEffect(SnapshotJson)(yield* Timeline.encodeSnapshot(snapshot)),
    ).toEqual(snapshot);
  }),
);

// Captured from the hand-written codecs: one envelope, then each payload tag's own encoding.
const ENVELOPE =
  '{"version":1,"storeId":"store-1","clockId":"clock-1","target":{"generation":2,"pageId":"page-1","frameId":"frame-1","document":3},"correlation":{"runId":"run-1","stepId":"step-1","attemptId":"attempt-1","fieldIndex":0},"sequence":"1","at":{"clockId":"clock-1","offsetNanos":"5"},"event":{"_tag":"Planned","action":"FillForm"}}';

const UNATTRIBUTED =
  '{"version":1,"storeId":"store-1","clockId":"clock-1","target":null,"correlation":null,"sequence":"20","at":{"clockId":"clock-1","offsetNanos":"5"},"event":{"_tag":"Lifecycle","phase":"open"}}';

const PAYLOADS = [
  '{"_tag":"Planned","action":"FillForm"}',
  '{"_tag":"Prepared","operation":"click","operationId":"op-1","late":false}',
  '{"_tag":"Dispatched","operation":"click","operationId":"op-1","late":false,"nativeOrdinal":1,"mutation":true}',
  '{"_tag":"Acknowledged","operation":"click","operationId":"op-1","late":false,"acknowledgement":{"subphase":"key-burst","logicalComplete":false}}',
  '{"_tag":"FollowUp","operation":"type","operationId":"op-2","late":true}',
  '{"_tag":"Pointer","kind":"hover","position":{"x":1.5,"y":2},"interval":{"start":{"clockId":"clock-1","offsetNanos":"10"},"end":{"clockId":"clock-1","offsetNanos":"20"},"qualification":"native-call-interval"},"operationId":"op-3"}',
  '{"_tag":"Press","position":null,"intended":{"position":{"x":4,"y":5},"relativePosition":{"x":1,"y":1},"qualification":"checked-exact-node-sample"},"interval":{"start":{"clockId":"clock-1","offsetNanos":"10"},"end":{"clockId":"clock-1","offsetNanos":"20"},"qualification":"native-call-interval"}}',
  '{"_tag":"Keys","kind":"type","count":3,"countUnit":"unicode-codepoints","interval":{"start":{"clockId":"clock-1","offsetNanos":"10"},"end":{"clockId":"clock-1","offsetNanos":"20"},"qualification":"native-call-interval"},"operationId":"op-4"}',
  '{"_tag":"Scroll","kind":"scroll","delta":{"x":0,"y":700},"interval":{"start":{"clockId":"clock-1","offsetNanos":"10"},"end":{"clockId":"clock-1","offsetNanos":"20"},"qualification":"native-call-interval"},"qualification":"exact-node-scroll-into-view"}',
  '{"_tag":"Glide","operationId":"op-5","schedule":[{"at":{"clockId":"clock-1","offsetNanos":"30"},"position":{"x":0,"y":0}},{"at":{"clockId":"clock-1","offsetNanos":"1180591620717411303424"},"position":{"x":10.25,"y":20}}],"qualification":"intended-schedule"}',
  '{"_tag":"Navigated","sameDocument":false,"url":"https://example.test/a","urlQualification":"NativeCached"}',
  '{"_tag":"CaptureBoundary","captureId":"capture-1","captureBoundary":1,"captureDocument":2,"sameDocument":true,"afterSequence":null,"observed":{"clockId":"clock-1","offsetNanos":"40"},"qualification":"received-boundary-attribution","url":null,"urlQualification":"Unread"}',
  '{"_tag":"Capture","captureId":"capture-1","phase":"Stopped","latePhase":false,"observed":{"clockId":"clock-1","offsetNanos":"50"},"captureBoundary":0,"captureDocument":1,"qualification":{"authority":"open","containment":{"_tag":"NotRequired"},"ownerPhase":"open","ownerGeneration":2},"reason":"stopped","nativeStop":"confirmed","received":10,"delivered":9,"discarded":1,"overflow":0,"late":1,"duplicates":0,"rejected":0,"upstreamDrops":"unknown"}',
  '{"_tag":"FirstFrame","captureId":"capture-1","frameSequence":0,"captureDocument":1,"captureBoundary":0,"sourceTimeMillis":1790000000000.5,"sourceClock":"presentation-unix-millis","received":{"clockId":"clock-1","offsetNanos":"60"},"width":1280,"height":720,"viewportWidth":1280,"viewportHeight":720,"qualification":"received-boundary-attribution"}',
  '{"_tag":"Picture","mediaType":"image/png","nativeRequest":{"clockId":"clock-1","offsetNanos":"70"},"nativeReturn":{"clockId":"clock-1","offsetNanos":"80"},"requestDocument":1,"returnDocument":null,"width":10,"qualification":"native-call-interval","operationId":"op-6"}',
  '{"_tag":"Settled","quietMillis":100,"withinMillis":1000,"signals":["dom-mutation","viewport"],"operationId":"op-7"}',
  '{"_tag":"Contained","containment":{"_tag":"PagePaused","pageId":"page-1","generation":2}}',
  '{"_tag":"Failed","operation":"click","reason":"NotFocused","outcome":"undispatched","operationId":"op-8"}',
  '{"_tag":"Cancelled","outcome":"unknown"}',
  '{"_tag":"Lifecycle","phase":"open"}',
  '{"_tag":"PageOpened"}',
  '{"_tag":"PageClosed"}',
  '{"_tag":"DisplayChanged","selected":true,"displayState":"held"}',
  '{"_tag":"MetadataChanged"}',
  '{"_tag":"Terminal","scope":"page","reason":"contained"}',
  '{"_tag":"MetadataOmitted","reason":"Oversized","originalTag":"Glide"}',
];

const CLIENT_PAYLOADS = [
  '{"_tag":"Navigated","sameDocument":false}',
  '{"_tag":"CaptureBoundary","captureId":"capture-1","captureBoundary":1,"captureDocument":2,"sameDocument":true,"afterSequence":null,"observed":{"clockId":"clock-1","offsetNanos":"40"},"qualification":"received-boundary-attribution"}',
];

const SNAPSHOT =
  '{"evicted":1,"retainedBytes":512,"events":[{"version":1,"storeId":"store-1","clockId":"clock-1","target":{"generation":2,"pageId":"page-1","frameId":"frame-1","document":3},"correlation":{"runId":"run-1","stepId":"step-1","attemptId":"attempt-1","fieldIndex":0},"sequence":"1","at":{"clockId":"clock-1","offsetNanos":"5"},"event":{"_tag":"Planned","action":"FillForm"}}],"oldest":{"storeId":"store-1","clockId":"clock-1","sequence":"1"},"newest":{"storeId":"store-1","clockId":"clock-1","sequence":"1"},"resumeAfter":{"storeId":"store-1","clockId":"clock-1","sequence":"1"},"evictedThrough":{"storeId":"store-1","clockId":"clock-1","sequence":"0"},"terminal":{"cursor":{"storeId":"store-1","clockId":"clock-1","sequence":"1"},"at":{"clockId":"clock-1","offsetNanos":"90"},"scope":"session","reason":"closed"}}';

const CURSOR = '{"storeId":"store-1","clockId":"clock-1","sequence":"1208925819614629174706176"}';
const AT = '{"at":{"clockId":"clock-1","offsetNanos":"1267650600228229401496703205376"}}';

const INVENTORY =
  '{"_tag":"Inventory","pages":[{"identity":{"generation":2,"pageId":"page-1","frameId":null,"document":null},"selected":true,"displayState":"running","phase":"open","containment":{"_tag":"NotRequired"}}],"resumeAfter":{"storeId":"store-1","clockId":"clock-1","sequence":"7"}}';
