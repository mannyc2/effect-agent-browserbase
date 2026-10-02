// Registered preparation only. The harness owns every allocation and requires explicit opt-in.
import { Cause, Deferred, Effect, Exit, Fiber, Schema, Stream } from "effect";
import * as Bootstrap from "effect-browser/bootstrap";
import { ObservedElement } from "effect-browser/browser-data";
import * as Capture from "effect-browser/capture";
import type { PerformedEncoded } from "effect-browser/plan-data";
import type { Event } from "effect-browser/timeline-data";
import { recipe } from "effect-browserbase/launch";

import { hostedCase } from "./harness.ts";

const h = hostedCase("performed-presentation");

const fixtureUrl = (() => {
  let url: URL;

  try {
    url = new URL(h.requiredSetting("BROWSERBASE_PERFORMED_PRESENTATION_URL"));
  } catch {
    throw new Error(
      "BROWSERBASE_PERFORMED_PRESENTATION_URL must be an exact credential-free HTTPS directory URL",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.endsWith("/")
  )
    throw new Error(
      "BROWSERBASE_PERFORMED_PRESENTATION_URL must be an exact credential-free HTTPS directory URL",
    );

  return url;
})();

// This controlled scene paints throughout the capture. It cannot qualify still/background
// painting on an arbitrary site. These are fixture controls, never presentation artwork.
const fixture = Bootstrap.init({
  id: "performed-presentation-fixture",
  origins: [fixtureUrl.origin],
  content: `globalThis.__performedPresentationReady = new Promise((resolve) => {
    const install = () => {
      const style = document.createElement("style");
      style.textContent = "body{font:18px sans-serif}button,input{margin:20px;padding:12px}#motion{width:80px;height:40px;background:red;animation:move .5s linear infinite alternate}@keyframes move{to{transform:translateX(120px);background:blue}}";
      const first = document.createElement("input");
      first.id = "first";
      first.setAttribute("aria-label", "Performed field");
      const count = document.createElement("p");
      count.id = "count";
      count.textContent = "0";
      const button = document.createElement("button");
      button.textContent = "Performed increment";
      button.onclick = () => { count.textContent = String(Number(count.textContent) + 1); };
      const evidence = document.createElement("pre");
      evidence.id = "evidence";
      const motion = document.createElement("div");
      motion.id = "motion";
      const visibility = document.createElement("p");
      visibility.id = "visibility";
      const showVisibility = () => { visibility.textContent = document.visibilityState; };
      document.addEventListener("visibilitychange", showVisibility);
      showVisibility();
      const events = [];
      const publish = () => { evidence.textContent = JSON.stringify({ value: first.value, events }); };
      for (const kind of ["keydown", "keyup"]) first.addEventListener(kind, (event) => {
        if (events.length < 64) events.push([kind, event.key, event.code, event.shiftKey,
          event.isTrusted, document.activeElement === first, performance.now()]);
        publish();
      });
      first.addEventListener("input", publish);
      document.head.append(style);
      document.body.replaceChildren(first, button, count, motion, visibility, evidence);
      publish();
      resolve(true);
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
    else install();
  });`,
  readiness: {
    expression: "globalThis.__performedPresentationReady",
    timeoutMillis: 10_000,
    existingDocuments: "RequireFreshNavigation",
  },
});

const KeyEvidence = Schema.Struct({
  value: Schema.String.check(Schema.isMaxLength(256)),
  events: Schema.Array(
    Schema.Tuple([
      Schema.Literals(["keydown", "keyup"]),
      Schema.String.check(Schema.isMaxLength(32)),
      Schema.String.check(Schema.isMaxLength(32)),
      Schema.Boolean,
      Schema.Boolean,
      Schema.Boolean,
      Schema.Finite,
    ]),
  ).check(Schema.isMaxLength(64)),
});

const style: PerformedEncoded = {
  seed: 991,
  motion: {
    name: "default",
    pointer: { duration: { minMillis: 200, maxMillis: 200 }, aimInset: 0.2, curvature: 0.05 },
    keys: { interval: { minMillis: 30, maxMillis: 30 }, hold: { minMillis: 20, maxMillis: 20 } },
    scroll: { duration: { minMillis: 100, maxMillis: 100 }, intervalMillis: 20 },
  },
};

await h.run(
  Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.tryPromise(async () => {
        const response = await fetch(fixtureUrl, {
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        });

        await response.body?.cancel();
        if (!response.ok)
          throw new Error("The controlled performed presentation fixture is unreachable");
      });
      const session = yield* h.open({ bootstrap: fixture });
      // A created Page opens as the front tab of a headful window and puts the Page behind it in
      // the background, where its document stops painting. The filmed stage is therefore the
      // newest Page, and the original Page is the peer whose references must survive.
      const peer = session.initialPage;

      yield* peer.navigate({ url: fixtureUrl.href });
      const stage = yield* session.createPage();

      yield* stage.navigate({ url: fixtureUrl.href });

      const peerInfo = (yield* session.listPages()).find(
        (info) => info.pageId === peer.identity.pageId,
      );

      if (peerInfo === undefined) return yield* h.established({ peerListed: false });
      // Display selection names the peer; it never retargets the stage's actions.
      yield* session.selectPage(peer);
      const peerObserved = yield* peer.observe({ maxControls: 8, maxTextBytes: 4096 });

      const peerButton = peerObserved.controls.find(
        (control) => control.label === "Performed increment",
      );

      if (peerButton === undefined) return yield* h.established({ peerReferenceIssued: false });
      const observed = yield* stage.observe({ maxControls: 8, maxTextBytes: 4096 });
      const field = observed.controls.find((control) => control.label === "Performed field");
      const button = observed.controls.find((control) => control.label === "Performed increment");

      if (field === undefined || button === undefined)
        return yield* h.established({ exactPageControlsIssued: false });
      yield* stage.pointerMove({ to: { x: 10, y: 10 } });

      const readerState = () => ({
        count: 0,
        sequences: [] as Array<bigint>,
        tags: new Map<string, number>(),
        firstFrames: new Map<string, number>(),
        intendedPress: false,
      });

      const a = readerState();
      const b = readerState();
      const journalStopped = yield* Deferred.make<void>();
      let captureId: string | undefined;

      const collect = (state: ReturnType<typeof readerState>) => (envelope: Event) =>
        Effect.gen(function* () {
          if (state.count >= 2048) return yield* h.established({ boundedJournalFacts: false });
          state.count++;
          state.sequences.push(envelope.sequence);
          const event = envelope.event;

          state.tags.set(event._tag, (state.tags.get(event._tag) ?? 0) + 1);
          if (event._tag === "FirstFrame")
            state.firstFrames.set(event.captureId, event.frameSequence);
          if (
            state === b &&
            event._tag === "Capture" &&
            event.captureId === captureId &&
            event.phase === "Stopped"
          )
            yield* Deferred.succeed(journalStopped, undefined);
          if (event._tag === "Press")
            state.intendedPress ||=
              event.position === null &&
              event.intended?.qualification === "checked-exact-node-sample";
        });

      const read = (state: ReturnType<typeof readerState>) =>
        Effect.gen(function* () {
          const snapshot = yield* stage.timeline.snapshot();

          yield* Effect.forEach(snapshot.events, collect(state), { discard: true });
          yield* stage.timeline
            .events(snapshot.resumeAfter)
            .pipe(Stream.runForEach(collect(state)));
        });

      const visibility = {
        stage: (yield* stage.readText({ selector: "#visibility" })).text,
        peer: (yield* peer.readText({ selector: "#visibility" })).text,
      };

      // Capture films painted frames, so a hidden stage would only time out below.
      yield* h.established({ capturedPageVisible: visibility.stage === "visible" });
      const readerA = yield* read(a).pipe(Effect.forkScoped);
      const readerB = yield* read(b).pipe(Effect.forkScoped);

      const interval = yield* Capture.start(stage, {
        lifetime: "page",
        maxFrames: 32,
        maxFrameBytes: 1024 * 1024,
        maxBufferedBytes: 8 * 1024 * 1024,
        maxDurationMillis: h.budget.captureSeconds * 1000,
      });

      captureId = interval.id;
      const first = yield* Deferred.make<void>();
      const afterCancel = yield* Deferred.make<void>();
      const sequences = new Set<number>();
      let delivered = 0;
      let canceled = false;
      let exactCapture = true;

      const frames = yield* interval.frames.pipe(
        Stream.runForEach((frame) =>
          Effect.gen(function* () {
            if (delivered >= 1024) return yield* h.established({ boundedCaptureFacts: false });
            delivered++;
            sequences.add(frame.sequence);
            exactCapture &&= frame.target.pageId === stage.identity.pageId;
            yield* Deferred.succeed(first, undefined);
            if (canceled) yield* Deferred.succeed(afterCancel, undefined);
          }),
        ),
        Effect.forkScoped,
      );

      yield* Deferred.await(first).pipe(Effect.timeout(8000));
      const before = (yield* session.status).actions.used;
      const requestedAt = yield* session.monotonicTimeNanos;
      // An absolute start on the original owner's monotonic clock, not the moment of the call.
      const startAt = requestedAt + 400_000_000n;

      // At Browserbase round trips (about 72 ms) this plan takes about 8.5 s. Its budget bounds the
      // check: remote pacing is measured, not promised.
      const ran = yield* stage.run(
        {
          version: 1,
          steps: [
            { id: "aim", action: { _tag: "PointerMove", to: { x: 450, y: 250 } } },
            {
              id: "fill",
              action: {
                _tag: "Fill",
                target: {
                  _tag: "Descriptor",
                  descriptor: { kind: field.kind, label: field.label, matchScope: "document" },
                },
                value: { _tag: "Literal", value: "Ab!" },
              },
            },
            {
              id: "press",
              action: {
                _tag: "Click",
                target: {
                  _tag: "Descriptor",
                  descriptor: { kind: button.kind, label: button.label, matchScope: "document" },
                },
              },
            },
          ],
        },
        { style, startAt, within: "15 seconds" },
      );

      const finishedAt = yield* session.monotonicTimeNanos;
      const after = (yield* session.status).actions.used;

      const keys = yield* Schema.decodeEffect(Schema.fromJsonString(KeyEvidence))(
        (yield* stage.readText({ selector: "#evidence" })).text,
      );

      const count = yield* stage.readText({ selector: "#count" });

      const aExit = yield* Effect.sync(() => readerA.pollUnsafe());

      if (aExit !== undefined) {
        if (Exit.isFailure(aExit)) return yield* Effect.failCause(aExit.cause);

        return yield* h.established({ readerAStayedLive: false });
      }
      yield* Fiber.interrupt(readerA);
      const aCanceled = yield* Effect.sync(() => readerA.pollUnsafe());
      const continuingAt = b.count;

      canceled = true;
      yield* stage.run(
        {
          version: 1,
          steps: [
            { id: "after-reader-cancel", action: { _tag: "PointerMove", to: { x: 600, y: 300 } } },
          ],
        },
        { style, within: "15 seconds" },
      );
      yield* Deferred.await(afterCancel).pipe(Effect.timeout(2000));
      yield* peer.clickElement(
        ObservedElement.make({
          observationId: peerObserved.observationId,
          elementId: peerButton.elementId,
        }),
      );
      const peerCount = yield* peer.readText({ selector: "#count" });

      const peerKeys = yield* Schema.decodeEffect(Schema.fromJsonString(KeyEvidence))(
        (yield* peer.readText({ selector: "#evidence" })).text,
      );

      const summary = yield* interval.stop;

      yield* Fiber.join(frames);
      yield* Deferred.await(journalStopped).pipe(
        Effect.race(
          Fiber.join(readerB).pipe(Effect.andThen(h.established({ readerBStayedLive: false }))),
        ),
        Effect.timeout(2000),
      );
      const bExit = yield* Effect.sync(() => readerB.pollUnsafe());

      if (bExit !== undefined) {
        if (Exit.isFailure(bExit)) return yield* Effect.failCause(bExit.cause);

        return yield* h.established({ readerBStayedLive: false });
      }
      yield* Fiber.interrupt(readerB);
      const cleanup = yield* session.closeChecked;

      const started = ran.timing.startedMonotonicNanos;
      const deadlineFromStart = ran.timing.deadlineMonotonicNanos - (startAt + 15_000_000_000n);

      yield* h.established({
        sameLogicalBudget: after - before === 3 && ran.steps.length === 3,
        // The run keeps the requested instant, measures lateness from it and bounds `within` from
        // it, all on the clock that `requestedAt` and `finishedAt` read.
        scheduledOnOriginalOwnerClock:
          ran.timing.seed === style.seed &&
          ran.timing.intendedMonotonicNanos === startAt &&
          ran.timing.requestedMonotonicNanos >= requestedAt &&
          ran.timing.requestedMonotonicNanos < startAt &&
          started !== null &&
          started <= finishedAt &&
          ran.timing.latenessNanos === (started > startAt ? started - startAt : 0n) &&
          deadlineFromStart >= -1_000_000n &&
          deadlineFromStart <= 1_000_000n,
        startedNoEarlierThanStartAt: started !== null && started >= startAt,
        trustedFocusedShiftedInput:
          keys.value === "Ab!" &&
          keys.events.every((event) => event[4] && event[5]) &&
          keys.events.some((event) => event[0] === "keydown" && event[1] === "A" && event[3]),
        exactPageAndPeerReference:
          count.text === "1" &&
          peerCount.text === "1" &&
          peerKeys.value === "" &&
          peerKeys.events.length === 0,
        // Both readers saw the same ordered events, the capture's first frame among them, until
        // one was canceled; the other went on.
        twoActualIndependentReaders:
          a.firstFrames.get(interval.id) !== undefined &&
          a.firstFrames.get(interval.id) === b.firstFrames.get(interval.id) &&
          a.sequences.length > 0 &&
          b.sequences.length > a.sequences.length &&
          a.sequences.every((sequence, index) => b.sequences[index] === sequence) &&
          b.count > continuingAt,
        readerACanceledOnly:
          aCanceled !== undefined &&
          Exit.isFailure(aCanceled) &&
          Cause.hasInterruptsOnly(aCanceled.cause),
        intendedPressQualified: b.intendedPress,
        firstFrameReferencesAcceptedBytes:
          b.firstFrames.get(interval.id) !== undefined &&
          sequences.has(b.firstFrames.get(interval.id) ?? -1),
        originalCaptureSurvivesReaderCancel:
          delivered > 1 &&
          exactCapture &&
          summary.reason === "stopped" &&
          summary.nativeStop === "confirmed",
        checkedProviderRelease: cleanup.remote === "confirmed",
      });

      const pending = new Map<string, number>();
      const holds: Array<number> = [];

      for (const event of keys.events) {
        if (event[0] === "keydown") pending.set(event[2], event[6]);
        else {
          const down = pending.get(event[2]);

          if (down !== undefined) holds.push(event[6] - down);
          pending.delete(event[2]);
        }
      }

      return {
        logicalActions: after - before,
        visibility,
        startAt,
        timing: ran.timing,
        keyEvents: keys.events.length,
        observedDomHoldMillis: holds,
        focusQualification:
          "observed exact document activeElement at trusted DOM event; OS/operator focus and future input delivery are not guaranteed",
        readerAEvents: a.count,
        readerBEvents: b.count,
        readerATags: Object.fromEntries(a.tags),
        readerBTags: Object.fromEntries(b.tags),
        capture: {
          received: summary.received,
          delivered: summary.delivered,
          discarded: summary.discarded,
          nativeStop: summary.nativeStop,
          upstreamDrops: "unknown",
        },
        pacingQualification:
          "host schedule and native ACK timing measured at actual provider round trips; no exact remote delivery or still-page painting claim",
        cleanup,
      };
    }).pipe(Effect.provide(h.browser({ launch: recipe() }))),
  ),
);
