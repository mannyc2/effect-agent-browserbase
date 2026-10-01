// Preparation only: this registered check requires the same explicit hosted opt-in as every case.
import { Effect, Fiber, Schema, Stream } from "effect";
import * as Bootstrap from "effect-browser/bootstrap";
import {
  ClickRequest,
  NavigateRequest,
  ObservedElement,
  ReadTextRequest,
  TypeRequest,
} from "effect-browser/browser-data";
import * as Capture from "effect-browser/capture";
import { recipe } from "effect-browserbase/launch";

import { hostedCase } from "./harness.ts";

const h = hostedCase("page-authority");

// An operator-owned landing page plus `pending` endpoint that never completes its document.
// Validation and the bounded reachability check precede the one provider allocation.
const fixtureUrl = (() => {
  let url: URL;

  try {
    url = new URL(h.requiredSetting("BROWSERBASE_PAGE_AUTHORITY_URL"));
  } catch {
    throw new Error(
      "BROWSERBASE_PAGE_AUTHORITY_URL must be an exact credential-free HTTPS directory URL",
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
      "BROWSERBASE_PAGE_AUTHORITY_URL must be an exact credential-free HTTPS directory URL",
    );

  return url;
})();

const pendingUrl = new URL("pending", fixtureUrl).href;

const fixture = Bootstrap.init({
  id: "page-authority-fixture",
  origins: [fixtureUrl.origin],
  content: `globalThis.__pageAuthorityReady = new Promise((resolve) => {
    const install = () => {
      const count = document.createElement("p");
      count.id = "page-counter";
      count.textContent = "0";
      const button = document.createElement("button");
      button.textContent = "Page increment";
      button.onclick = () => { count.textContent = String(Number(count.textContent) + 1); };
      const never = document.createElement("a");
      never.textContent = "Never settles";
      never.href = ${JSON.stringify(pendingUrl)};
      const first = document.createElement("input");
      first.id = "first";
      first.setAttribute("aria-label", "First field");
      const second = document.createElement("input");
      second.id = "second";
      second.setAttribute("aria-label", "Second field");
      const keyboard = document.createElement("pre");
      keyboard.id = "keyboard-evidence";
      const reset = document.createElement("button");
      reset.id = "move-focus";
      reset.textContent = "Move focus during typing";
      let moveFocus = false;
      let inputs = 0;
      let entries = [];
      const publish = () => {
        keyboard.textContent = JSON.stringify({ first: first.value, second: second.value, events: entries });
      };
      reset.onclick = () => {
        first.value = "";
        second.value = "";
        entries = [];
        inputs = 0;
        moveFocus = true;
        publish();
      };
      for (const type of ["keydown", "keyup", "input"]) {
        document.addEventListener(type, (event) => {
          if (event.target !== first && event.target !== second) return;
          if (entries.length < 512) entries.push([type, event.key ?? null, event.code ?? null,
            event.repeat ?? false, event.shiftKey ?? false, event.ctrlKey ?? false,
            event.altKey ?? false, event.metaKey ?? false, event.isTrusted]);
          if (type === "input" && moveFocus && event.target === first && ++inputs === 1) second.focus();
          publish();
        });
      }
      const frame = document.createElement("iframe");
      frame.name = "authority-child";
      frame.srcdoc = "<p id=frame-counter>0</p><button id=increment>Frame increment</button><script>document.getElementById('increment').onclick=()=>{const count=document.getElementById('frame-counter');count.textContent=String(Number(count.textContent)+1)}</script>";
      frame.onload = () => resolve(true);
      document.body.replaceChildren(count, button, never, first, second, reset, keyboard, frame);
      publish();
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

const KeyboardEvidence = Schema.Struct({
  first: Schema.String.check(Schema.isMaxLength(256)),
  second: Schema.String.check(Schema.isMaxLength(256)),
  events: Schema.Array(
    Schema.Tuple([
      Schema.Literals(["keydown", "keyup", "input"]),
      Schema.NullOr(Schema.String.check(Schema.isMaxLength(32))),
      Schema.NullOr(Schema.String.check(Schema.isMaxLength(32))),
      Schema.Boolean,
      Schema.Boolean,
      Schema.Boolean,
      Schema.Boolean,
      Schema.Boolean,
      Schema.Boolean,
    ]),
  ).check(Schema.isMaxLength(512)),
});

const keyboardEvidence = (text: string) =>
  Schema.decodeEffect(Schema.fromJsonString(KeyboardEvidence))(text);

await h.run(
  Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.tryPromise(async () => {
        const response = await fetch(fixtureUrl, {
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        });

        await response.body?.cancel();
        if (!response.ok) throw new Error("The controlled Page authority fixture is unreachable");
      });
      const session = yield* h.open({ bootstrap: fixture });
      const a = session.initialPage;

      yield* a.navigate(NavigateRequest.make({ url: fixtureUrl.href }));
      const bInfo = yield* session.createPage;
      const b = yield* session.page(bInfo);

      yield* session.selectPage(bInfo);
      yield* b.navigate(NavigateRequest.make({ url: fixtureUrl.href }));
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
      yield* b.clickElement(
        ObservedElement.make({
          observationId: observedB.observationId,
          elementId: buttonB.elementId,
        }),
      );
      const pictureB = yield* b.screenshot({ fullPage: false });

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

      yield* b.click(ClickRequest.make({ selector: "#first" }));

      const text =
        Array.from({ length: 95 }, (_, index) => String.fromCodePoint(32 + index)).join("") +
        "aAé🙂";

      const beforeTyping = (yield* session.status).actions.used;
      const typed = yield* b.type(TypeRequest.make({ text, into: "#first" }));
      const afterTyping = (yield* session.status).actions.used;

      const keys = yield* keyboardEvidence(
        (yield* b.readText(ReadTextRequest.make({ selector: "#keyboard-evidence" }))).text,
      );

      const downs = keys.events.filter((event) => event[0] === "keydown");
      const ups = keys.events.filter((event) => event[0] === "keyup");

      yield* b.click(ClickRequest.make({ selector: "#move-focus" }));
      yield* b.click(ClickRequest.make({ selector: "#first" }));

      const focusLoss = yield* b
        .type(TypeRequest.make({ text: "a".repeat(32), into: "#first" }))
        .pipe(Effect.result);

      const partial = yield* keyboardEvidence(
        (yield* b.readText(ReadTextRequest.make({ selector: "#keyboard-evidence" }))).text,
      );

      const observedPeer = yield* b.observe({ maxControls: 8, maxTextBytes: 4096 });

      const peerButton = observedPeer.controls.find(
        (control) => control.label === "Page increment",
      );

      if (peerButton === undefined)
        return yield* h.established({ healthyPeerControlIssued: false });
      const unresolvedReading = yield* a.observe({ maxControls: 8, maxTextBytes: 4096 });

      const unresolvedLink = unresolvedReading.controls.find(
        (control) => control.label === "Never settles",
      );

      if (unresolvedLink === undefined)
        return yield* h.established({ unresolvedControlIssued: false });

      const unknown = yield* a
        .clickElement(
          ObservedElement.make({
            observationId: unresolvedReading.observationId,
            elementId: unresolvedLink.elementId,
          }),
        )
        .pipe(Effect.result);

      const retired = yield* a.observe().pipe(Effect.result);

      yield* b.clickElement(
        ObservedElement.make({
          observationId: observedPeer.observationId,
          elementId: peerButton.elementId,
        }),
      );
      const nextB = yield* b.readText(ReadTextRequest.make({ selector: "#page-counter" }));
      const status = yield* session.status;
      const closed = yield* a.status;

      yield* b.close();
      const afterLastPage = yield* session.status;
      const remaining = yield* session.listPages();
      const cleanup = yield* session.closeChecked;

      yield* h.established({
        exactPage: countA.text === "1" && countB.text === "1" && pictureB.bytes.byteLength > 0,
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
        siblingReferencePreserved: nextB.text === "2",
        unknownBackgroundContained:
          unknown._tag === "Failure" &&
          unknown.failure.outcome === "unknown" &&
          unknown.failure.containment?._tag === "PageClosed" &&
          unknown.failure.containment.pageId === a.identity.pageId &&
          unknown.failure.containment.generation === a.identity.generation,
        trustedOrderedTyping:
          keys.first === text &&
          keys.second === "" &&
          downs.map((event) => event[1]).join("") === text.slice(0, 97) &&
          downs.length === ups.length &&
          downs.every(
            (event, index) => event[1] === ups[index]?.[1] && event[2] === ups[index]?.[2],
          ) &&
          keys.events.every(
            (event) => event[8] && !event[3] && !event[5] && !event[6] && !event[7],
          ) &&
          downs.some((event) => event[1] === "A" && event[4]),
        oneTypingAction: afterTyping - beforeTyping === 1,
        focusStopsNextWindow:
          focusLoss._tag === "Failure" &&
          focusLoss.failure.reason._tag === "NotFocused" &&
          focusLoss.failure.outcome === "performed" &&
          focusLoss.failure.containment?._tag === "NotRequired" &&
          partial.first === "a" &&
          partial.second.length <= 15 &&
          partial.first.length + partial.second.length === 16 &&
          partial.events.filter((event) => event[0] === "keydown" || event[0] === "keyup")
            .length === 32,
        originalOwnerOpen: status.phase === "open" && !status.unresolvedDispatch,
        lastPageDistinctFromProviderTermination:
          remaining.length === 0 &&
          afterLastPage.phase === "open" &&
          !afterLastPage.unresolvedDispatch,
        checkedRelease: cleanup.remote === "confirmed",
      });

      return {
        frames: frames.length,
        captureStopped: capture.nativeStop,
        typing: {
          codePoints: [...text].length,
          keyDowns: downs.length,
          keyUps: ups.length,
          inputEvents: keys.events.filter((event) => event[0] === "input").length,
          actions: afterTyping - beforeTyping,
          hostIntervalMillis:
            Number(typed.completedMonotonicNanos - typed.startedMonotonicNanos) / 1_000_000,
          partialWindowInputCommands: partial.events.filter((event) => event[0] !== "input").length,
          nativeOutstandingReplies: "not-observable-through-public-api",
        },
        containment: unknown._tag === "Failure" ? unknown.failure.containment : null,
        pagesAfterLastClose: remaining.length,
        providerTermination: cleanup.remote,
        cleanup,
      };
    }).pipe(Effect.provide(h.browser({ launch: recipe() }))),
  ),
);
