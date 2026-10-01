// Preparation only: this registered check requires the same explicit hosted opt-in as every case.
import { Effect, Fiber, Stream } from "effect";
import * as Bootstrap from "effect-browser/bootstrap";
import { NavigateRequest, ObservedElement, ReadTextRequest } from "effect-browser/browser-data";
import * as Capture from "effect-browser/capture";
import { recipe } from "effect-browserbase/launch";

import { hostedCase } from "./harness.ts";

const h = hostedCase("page-authority");

// The same approved example.com host used by the existing hosted bootstrap checks.
const fixture = Bootstrap.init({
  id: "page-authority-fixture",
  origins: ["https://example.com"],
  content: `globalThis.__pageAuthorityReady = new Promise((resolve) => {
    const install = () => {
      const count = document.createElement("p");
      count.id = "page-counter";
      count.textContent = "0";
      const button = document.createElement("button");
      button.textContent = "Page increment";
      button.onclick = () => { count.textContent = String(Number(count.textContent) + 1); };
      const frame = document.createElement("iframe");
      frame.name = "authority-child";
      frame.srcdoc = "<p id=frame-counter>0</p><button id=increment>Frame increment</button><script>document.getElementById('increment').onclick=()=>{const count=document.getElementById('frame-counter');count.textContent=String(Number(count.textContent)+1)}</script>";
      frame.onload = () => resolve(true);
      document.body.append(count, button, frame);
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
    else install();
  });`,
  readiness: {
    expression: "globalThis.__pageAuthorityReady",
    timeoutMillis: 10_000,
    existingDocuments: "RequireFreshNavigation",
  },
});

await h.run(
  Effect.scoped(
    Effect.gen(function* () {
      const session = yield* h.open({ bootstrap: fixture });
      const a = session.initialPage;

      yield* a.navigate(NavigateRequest.make({ url: "https://example.com/" }));
      const bInfo = yield* session.createPage;
      const b = yield* session.page(bInfo);

      yield* session.selectPage(bInfo);
      yield* b.navigate(NavigateRequest.make({ url: "https://example.com/" }));
      const observedB = yield* b.observe({ maxControls: 8, maxTextBytes: 4096 });
      const buttonB = observedB.controls.find((control) => control.label === "Page increment");

      if (buttonB === undefined) return yield* h.established({ selectedPageControlIssued: false });

      const interval = yield* Capture.start(a, {
        lifetime: "page",
        maxFrames: 8,
        maxFrameBytes: 1024 * 1024,
        maxBufferedBytes: 8 * 1024 * 1024,
        maxDurationMillis: h.budget.captureSeconds * 1000,
      });

      const collected = yield* interval.frames.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );

      const frameInfo = (yield* a.listFrames()).find((frame) => frame.name === "authority-child");

      if (frameInfo === undefined) return yield* h.established({ childFrameIssued: false });
      const frame = yield* a.frame(frameInfo);
      const observedFrame = yield* frame.observe({ maxControls: 8, maxTextBytes: 4096 });

      const frameButton = observedFrame.controls.find(
        (control) => control.label === "Frame increment",
      );

      if (frameButton === undefined) return yield* h.established({ childControlIssued: false });
      yield* frame.clickElement(
        ObservedElement.make({
          observationId: observedFrame.observationId,
          elementId: frameButton.elementId,
        }),
      );

      const frameCount = yield* frame.readText(
        ReadTextRequest.make({ selector: "#frame-counter" }),
      );

      const observedA = yield* a.observe({ maxControls: 8, maxTextBytes: 4096 });
      const buttonA = observedA.controls.find((control) => control.label === "Page increment");

      if (buttonA === undefined)
        return yield* h.established({ unselectedPageControlIssued: false });
      yield* a.clickElement(
        ObservedElement.make({
          observationId: observedA.observationId,
          elementId: buttonA.elementId,
        }),
      );
      const countA = yield* a.readText(ReadTextRequest.make({ selector: "#page-counter" }));
      const countB = yield* b.readText(ReadTextRequest.make({ selector: "#page-counter" }));
      const frames = yield* Fiber.join(collected);
      const capture = yield* interval.stop;

      yield* a.close();
      const retired = yield* a.observe().pipe(Effect.result);

      yield* b.clickElement(
        ObservedElement.make({
          observationId: observedB.observationId,
          elementId: buttonB.elementId,
        }),
      );
      const nextB = yield* b.readText(ReadTextRequest.make({ selector: "#page-counter" }));
      const status = yield* session.status;
      const closed = yield* a.status;
      const cleanup = yield* session.closeChecked;

      yield* h.established({
        exactPage: countA.text === "1" && countB.text === "0",
        exactFrame: frameCount.text === "1",
        exactCapture:
          frames.length > 0 &&
          frames.every((frame) => frame.target.pageId === a.identity.pageId) &&
          capture.target.pageId === a.identity.pageId,
        retiredPage:
          closed.phase === "closed" &&
          retired._tag === "Failure" &&
          retired.failure.reason._tag === "Stale" &&
          retired.failure.outcome === "undispatched",
        siblingReferencePreserved: nextB.text === "1",
        originalOwnerOpen: status.phase === "open" && !status.unresolvedDispatch,
        checkedRelease: cleanup.remote === "confirmed",
      });

      return { frames: frames.length, captureStopped: capture.nativeStop, cleanup };
    }).pipe(Effect.provide(h.browser({ launch: recipe() }))),
  ),
);
