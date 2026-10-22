/** One owned native input relay, shared by behavioral and optional latency checks. */
import { Clock, Deferred, Duration, Effect, Stream } from "effect";

import { Browser } from "../../src/Browser.ts";
import type { BrowserEvent } from "../../src/BrowserEvent.ts";
import * as BrowserClock from "../../src/Clock.ts";
import * as Openings from "../../src/internal/page/openings.ts";
import * as PageImpl from "../../src/internal/page/page.ts";
import * as Port from "../../src/internal/page/port.ts";
import type * as Page from "../../src/Page.ts";
import * as Presentation from "../../src/presentation/Presentation.ts";
import { unpaused } from "../fixtures.ts";
import * as TestCdp from "./TestCdp.ts";

export interface RecordedKey {
  readonly type: string;
  readonly key: string;
  readonly code: string;
  readonly at: number;
  readonly epoch: number;
  readonly handled: number;
  readonly trusted: boolean;
  readonly shift: boolean;
  readonly control: boolean;
}

export interface Dispatch {
  readonly method: string;
  readonly type: string | undefined;
  readonly key: string | undefined;
  readonly sent: number;
  readonly timestamp: number | undefined;
  delivered?: number;
  settled?: number;
}

interface RecordedPointer {
  readonly type: string;
  readonly epoch: number;
  readonly handled: number;
  readonly trusted: boolean;
}

export interface RecordedWindow {
  readonly inputEvents: Array<RecordedKey>;
  readonly pointerEvents: Array<RecordedPointer>;
  submissions: number;
}

export const keys = (page: Page.Page) =>
  Effect.promise(() =>
    TestCdp.nativePage(page).evaluate(() => (window as unknown as RecordedWindow).inputEvents),
  );

export const value = (page: Page.Page) =>
  Effect.promise(() => TestCdp.nativePage(page).locator("input").inputValue());

// The requested input seam is the real browser connection: delaying replies must not add RTT to
// every character, permit unbounded retained work, or lose a release when an action is interrupted.
export const setup = Effect.fnUntraced(function* (
  oneWayMillis: number,
  options: { readonly performed?: boolean; readonly guard?: Page.InputGuard } = {},
) {
  const native = TestCdp.nativeContext(yield* Browser).browser();

  if (native === null) return yield* Effect.die("the fixture requires a launched Chromium");

  const context = yield* Effect.acquireRelease(
    Effect.promise(() => native.newContext()),
    (context) => Effect.promise(() => context.close()),
  );

  const playwright = yield* Effect.promise(() => context.newPage());

  yield* Effect.promise(() =>
    playwright.setContent(
      "<form><label>Input <input autofocus></label><label>Notes <textarea></textarea></label><button>Submit</button></form>",
    ),
  );
  yield* Effect.promise(() =>
    playwright.evaluate(() => {
      const recorded = window as unknown as RecordedWindow;

      Object.assign(recorded, { inputEvents: [], pointerEvents: [], submissions: 0 });
      document.body.style.height = "2000px";
      for (const name of ["mousemove", "mousedown", "mouseup", "wheel"] as const)
        document.addEventListener(name, (event) => {
          recorded.pointerEvents.push({
            type: event.type,
            epoch: performance.timeOrigin + event.timeStamp,
            handled: performance.timeOrigin + performance.now(),
            trusted: event.isTrusted,
          });
        });
      document.addEventListener("submit", (event) => {
        event.preventDefault();
        recorded.submissions += 1;
      });
      for (const name of ["keydown", "keyup"] as const)
        document.addEventListener(name, (event) => {
          recorded.inputEvents.push({
            type: event.type,
            key: event.key,
            code: event.code,
            // Explicit protocol stamps describe intended time, so pacing still uses handling time.
            at: performance.now(),
            epoch: performance.timeOrigin + event.timeStamp,
            handled: performance.timeOrigin + performance.now(),
            trusted: event.isTrusted,
            shift: event.shiftKey,
            control: event.ctrlKey,
          });
        });
    }),
  );
  yield* Effect.promise(() => playwright.locator("input").focus());

  const faults = yield* TestCdp.make();

  const cdp = yield* faults.provide(
    Port.openSession(() => context.newCDPSession(playwright), playwright),
  );

  const dispatches: Array<Dispatch> = [];
  const active = new Map<TestCdp.Call, Dispatch>();
  const track: Array<BrowserEvent> = [];
  const capacityReached = Promise.withResolvers<void>();
  let gate: Deferred.Deferred<void> | undefined;
  let outstanding = 0;
  let maximumOutstanding = 0;
  let rejectNextKeyDown = false;
  let sequence = 0;
  let clockBias = 0;
  let nextDown: ReturnType<typeof Promise.withResolvers<void>> | undefined;

  faults.rule({}, { _tag: "Delay", duration: Duration.millis(oneWayMillis) });
  faults.rule({}, { _tag: "Delay", duration: Duration.millis(oneWayMillis) }, { phase: "after" });
  faults.rule(
    { method: "Runtime.evaluate", operation: "calibrate" },
    {
      _tag: "Transform",
      reply: (value) => {
        const reply = value as { result: { value: number } };

        return { ...reply, result: { ...reply.result, value: reply.result.value + clockBias } };
      },
    },
    { phase: "after" },
  );
  faults.observe((call, phase) => {
    const params = (call.params ?? {}) as { type?: string; key?: string; timestamp?: number };
    const input = call.method.startsWith("Input.") || call.method.startsWith("keyboard.");

    if (phase === "before") {
      const dispatch: Dispatch = {
        method: call.method,
        type: params.type,
        key: params.key,
        timestamp: params.timestamp,
        sent: performance.now(),
      };

      active.set(call, dispatch);
      dispatches.push(dispatch);
      if (call.method === "Input.dispatchKeyEvent" && params.type === "keyDown") {
        nextDown?.resolve();
        nextDown = undefined;
      }
      if (input) {
        outstanding++;
        maximumOutstanding = Math.max(maximumOutstanding, outstanding);
        if (outstanding === 64) capacityReached.resolve();
      }
      if (rejectNextKeyDown && params.type === "keyDown") {
        rejectNextKeyDown = false;
        faults.rule(
          { method: call.method, params: { key: params.key } },
          { _tag: "Fail", error: new Error("the key was delivered but its reply was lost") },
          { phase: "after", times: 1 },
        );
      }
    }
    const dispatch = active.get(call);

    if (phase === "received" && dispatch !== undefined) dispatch.delivered = performance.now();
    if (phase === "settled") {
      if (dispatch !== undefined) dispatch.settled = performance.now();
      if (input) outstanding--;
    }
  });
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      if (gate !== undefined) Deferred.doneUnsafe(gate, Effect.void);
    }),
  );

  const clock = yield* Clock.Clock;
  // How far ahead of the owner's clock the mapping reads, so a test can age its estimate.
  let ahead = 0;

  const mapping = BrowserClock.mapping(
    () => Number(clock.monotonicTimeNanosUnsafe()) / 1e6 + ahead,
  );

  // Registered as `Browser` registers a page: its target id, and the Page domain turned on.
  const { targetInfo } = yield* Effect.promise(() => cdp.send("Target.getTargetInfo"));
  const paging = cdp.send("Page.enable");

  const plain = yield* PageImpl.make({
    id: targetInfo.targetId,
    session: "input-test",
    connection: "fixture-connection",
    playwright,
    cdp,
    nativePort: faults.hooks.native,
    clock,
    mapping,
    publish: (event) => {
      track.push(event);

      return ++sequence;
    },
    recentEvents: Effect.sync(() => [...track]),
    openings: yield* Openings.make(playwright, cdp, new WeakMap(), () => "page"),
    url: targetInfo.url,
    untilLost: (reply) => reply,
    focused: Effect.void,
    paging: () => Effect.promise(() => paging),
    closedBy: () => "page",
    settings: {
      actionTimeout: Duration.seconds(30),
      policyTimeout: Duration.seconds(30),
      navigationTimeout: Duration.seconds(30),
      frameHistory: Duration.seconds(5),
      guard: options.guard,
    },
  });

  // Performed by default, as watched typing is the pace these tests hold.
  const page =
    options.performed === false
      ? plain
      : (yield* Presentation.make({ pacing: unpaused })).view(plain);

  yield* page.snapshot();
  dispatches.splice(0);

  return {
    page,
    dispatches,
    track,
    mapping,
    /** A capture maps the browser's clock, as on any watched page; input never measures it. */
    mapClock: page
      .screencast()
      .pipe(
        Stream.take(1),
        Stream.runDrain,
        Effect.timeout("10 seconds"),
        Effect.andThen(Effect.sync(() => dispatches.splice(0))),
      ),
    age: (millis: number) => {
      ahead += millis;
    },
    shiftClock: () => {
      clockBias = 500;
    },
    watchNextDown: () => {
      nextDown = Promise.withResolvers<void>();

      return nextDown.promise;
    },
    capacityReached: capacityReached.promise,
    holdReplies: () => {
      gate = Deferred.makeUnsafe<void>();
      faults.rule({ method: { prefix: "Input." } }, { _tag: "Hold", gate }, { phase: "after" });
      faults.rule({ method: { prefix: "keyboard." } }, { _tag: "Hold", gate }, { phase: "after" });
    },
    releaseReplies: () => {
      if (gate !== undefined) Deferred.doneUnsafe(gate, Effect.void);
    },
    rejectReply: () => {
      rejectNextKeyDown = true;
    },
    maximumOutstanding: () => maximumOutstanding,
  };
});
