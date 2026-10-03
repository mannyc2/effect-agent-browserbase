import { expect, it } from "@effect/vitest";
import { Effect, Schema, Stream } from "effect";
import * as Tools from "effect-agent-browser/tools";
import { Step, type StepAttempt } from "effect-browser/plan-data";
import { CachedPage, Event, Snapshot, type Payload } from "effect-browser/timeline-data";

import { build, fromAttempt, fromReceipts } from "./bench/StepDigest.ts";
import { scriptedSession } from "./fixtures/ScriptedSession.ts";

const target = { generation: 0, pageId: "page", frameId: "frame", document: 2 };

const page = Schema.decodeSync(CachedPage)({
  identity: target,
  targetId: null,
  url: "https://example.test/new",
  urlQualification: "NativeCached",
  title: "New screen",
  titleQualification: "ObservedCached",
  selected: true,
  displayState: "running",
  phase: "open",
  containment: { _tag: "NotRequired" },
});

const stamp = (offsetNanos: bigint, clockId = "clock") => ({ clockId, offsetNanos });

const event = (sequence: bigint, payload: Payload, document: number | null = 2) =>
  Schema.decodeSync(Event)({
    version: 1,
    storeId: "store",
    clockId: "clock",
    target: { ...target, document },
    correlation: null,
    sequence,
    at: stamp(sequence * 1000000n),
    event: payload,
  });

const snapshot = (events: ReadonlyArray<Event>, evicted = 0) =>
  Schema.decodeSync(Snapshot)({
    events,
    evicted,
    retainedBytes: 200,
    oldest: null,
    newest: null,
    resumeAfter: { storeId: "store", clockId: "clock", sequence: 5n },
    evictedThrough: { storeId: "store", clockId: "clock", sequence: 0n },
    terminal: null,
  });

const firstFrame = (document: number): Payload => ({
  _tag: "FirstFrame",
  captureId: "capture",
  frameSequence: 0,
  captureDocument: document,
  captureBoundary: document,
  sourceTimeMillis: 1000,
  sourceClock: "presentation-unix-millis",
  received: stamp(1000000n),
  width: 1280,
  height: 720,
  viewportWidth: 1280,
  viewportHeight: 720,
  qualification: "received-boundary-attribution",
});

it("digest uses only the current page and document and qualifies missing clocks and settlement", () => {
  const timeline = snapshot([
    event(
      0n,
      {
        _tag: "CaptureBoundary",
        captureId: "capture",
        captureBoundary: 2,
        captureDocument: 2,
        sameDocument: false,
        afterSequence: 1,
        observed: stamp(0n),
        qualification: "received-boundary-attribution",
        url: "https://example.test/new",
        urlQualification: "NativeCached",
      },
      null,
    ),
    event(1n, firstFrame(1), null),
    event(2n, {
      _tag: "Navigated",
      sameDocument: false,
      url: "https://example.test/new",
      urlQualification: "NativeCached",
    }),
    event(3n, firstFrame(2), null),
    event(4n, { _tag: "Settled", quietMillis: 50, withinMillis: 1000, signals: ["dom-mutation"] }),
  ]);

  const digest = build({
    steps: [{ action: "Click", targetLabel: "Next", outcome: "performed" }],
    timeline,
    now: stamp(11000000n),
    page,
    sinceSequence: 1n,
  });

  expect(digest).toEqual({
    steps: [{ action: "Click", targetLabel: "Next", outcome: "performed" }],
    navigation: { sameDocument: false, address: "https://example.test/new", title: "New screen" },
    settlement: "observed",
    firstFrameAgeMillis: 10,
    firstFrameQualification: "received-boundary-attribution",
    failure: null,
    complete: true,
  });
  expect(
    build({ steps: [], timeline, now: stamp(11000000n, "foreign"), page }).firstFrameAgeMillis,
  ).toBeNull();
  expect(
    build({ steps: [], timeline, now: stamp(11000000n), page, sinceSequence: 4n }).settlement,
  ).toBe("not-observed");
  expect(
    build({
      steps: [],
      timeline: snapshot([event(1n, firstFrame(1), 1)]),
      now: stamp(11000000n),
      page,
    }).firstFrameAgeMillis,
  ).toBeNull();
  expect(
    build({ steps: [], timeline, now: stamp(11000000n), page, droppedReceipts: 1 }).complete,
  ).toBe(false);
});

it("unknown attempts and failures stay unknown even if late native acknowledgements arrive", () => {
  const attempt: StepAttempt = {
    id: "attempt",
    stepId: "next",
    sourceStep: Schema.decodeSync(Step)({
      id: "next",
      action: {
        _tag: "Click",
        target: { _tag: "Descriptor", descriptor: { kind: "button", label: "Next" } },
      },
    }),
    action: "Click",
    phase: "Terminal",
    phases: [],
    result: { _tag: "Unknown", outcome: "unknown" },
    outcome: "unknown",
    completed: false,
    containment: { _tag: "PageClosed", pageId: "page", generation: 0 },
  };

  const timeline = snapshot(
    [
      event(1n, { _tag: "Failed", operation: "click", reason: "Timeout", outcome: "unknown" }),
      event(2n, { _tag: "Acknowledged", operation: "click", operationId: "operation", late: true }),
    ],
    1,
  );

  const digest = build({ steps: [fromAttempt(attempt)], timeline, now: stamp(3000000n), page });

  expect(digest.steps).toEqual([{ action: "Click", targetLabel: "Next", outcome: "unknown" }]);
  expect(digest.failure).toEqual({ outcome: "unknown", reason: "Timeout" });
  expect(digest.complete).toBe(false);
  expect(digest.settlement).toBe("not-observed");
});

it.effect(
  "original ToolHost receipt handles resolve into labelled facts without a model projection",
  () =>
    Effect.gen(function* () {
      const browser = yield* scriptedSession();
      const page = browser.initialPage;
      const observation = yield* page.observe();
      const control = observation.controls.find((value) => value.label === "Control");

      if (control === undefined) return yield* Effect.die("Fixture control missing");
      const host = yield* Tools.makeHost(browser, page);

      yield* host.run(
        Effect.gen(function* () {
          const tools = yield* Tools.toolkit;

          yield* Stream.runCollect(
            yield* tools.handle(
              "browser_click",
              { observationId: observation.observationId, elementId: control.elementId },
              "click",
            ),
          );
        }),
      );
      expect(yield* fromReceipts(yield* host.receipts)).toEqual([
        { action: "Click", targetLabel: "Control", outcome: "performed" },
      ]);
    }).pipe(Effect.scoped),
);
