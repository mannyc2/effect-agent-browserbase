import { setTimeout as sleep } from "node:timers/promises";

import { assert, layer } from "@effect/vitest";
import { Clock, Duration, Effect, Fiber, Option, Random, Ref, Semaphore, Stream } from "effect";
import type { CDPSession } from "playwright-core";

import { Browser } from "../src/Browser.ts";
import type { BrowserEvent } from "../src/BrowserEvent.ts";
import * as Chromium from "../src/Chromium.ts";
import * as PageImpl from "../src/internal/page/page.ts";
import * as BrowserClock from "../src/internal/pictures/clock.ts";
import * as Motion from "../src/Motion.ts";
import type * as Page from "../src/Page.ts";

interface RecordedKey {
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

interface Dispatch {
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

interface RecordedWindow {
  readonly inputEvents: Array<RecordedKey>;
  readonly pointerEvents: Array<RecordedPointer>;
  submissions: number;
}

const keys = (page: Page.Page) =>
  Effect.promise(() =>
    page.playwright.evaluate(() => (window as unknown as RecordedWindow).inputEvents),
  );

const value = (page: Page.Page) =>
  Effect.promise(() => page.playwright.locator("input").inputValue());

// The requested input seam is the real browser connection: delaying replies must not add RTT to
// every character, permit unbounded retained work, or lose a release when an action is interrupted.
const setup = Effect.fnUntraced(function* (
  oneWayMillis: number,
  options: { readonly humanize?: boolean; readonly guard?: Page.InputGuard } = {},
) {
  const native = (yield* Browser).context.browser();

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

  const cdp = yield* Effect.promise(() => context.newCDPSession(playwright));
  const originalSend = cdp.send.bind(cdp);
  const originalDown = playwright.keyboard.down.bind(playwright.keyboard);
  const originalUp = playwright.keyboard.up.bind(playwright.keyboard);
  const dispatches: Array<Dispatch> = [];
  const track: Array<BrowserEvent> = [];
  const capacityReached = Promise.withResolvers<void>();
  let gate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  let outstanding = 0;
  let maximumOutstanding = 0;
  let rejectNextKeyDown = false;
  let sequence = 0;
  let clockBias = 0;
  let nextDown: ReturnType<typeof Promise.withResolvers<void>> | undefined;

  const invoke = async <A>(
    method: string,
    type: string | undefined,
    key: string | undefined,
    run: () => Promise<A>,
    timestamp?: number,
  ): Promise<A> => {
    const input = method.startsWith("Input.") || method.startsWith("keyboard.");
    const dispatch: Dispatch = { method, type, key, timestamp, sent: performance.now() };
    const rejectReply = rejectNextKeyDown && type === "keyDown";

    if (rejectReply) rejectNextKeyDown = false;
    dispatches.push(dispatch);
    if (method === "Input.dispatchKeyEvent" && type === "keyDown") {
      nextDown?.resolve();
      nextDown = undefined;
    }
    if (input) {
      outstanding += 1;
      maximumOutstanding = Math.max(maximumOutstanding, outstanding);
      if (outstanding === 64) capacityReached.resolve();
    }
    try {
      await sleep(oneWayMillis);
      const result = await run();

      dispatch.delivered = performance.now();
      if (input && gate !== undefined) await gate.promise;
      await sleep(oneWayMillis);
      if (rejectReply) throw new Error("the key was delivered but its reply was lost");

      return result;
    } finally {
      dispatch.settled = performance.now();
      if (input) outstanding -= 1;
    }
  };

  const delayedSend: CDPSession["send"] = (method, params) =>
    invoke(
      method,
      params !== undefined && "type" in params && typeof params.type === "string"
        ? params.type
        : undefined,
      params !== undefined && "key" in params && typeof params.key === "string"
        ? params.key
        : undefined,
      () =>
        originalSend(method, params).then((result) => {
          // Recalibration is an explicit clock discontinuity; native input and frame pixels remain real.
          if (
            method === "Runtime.evaluate" &&
            params !== undefined &&
            "expression" in params &&
            params.expression === "performance.timeOrigin + performance.now()" &&
            "result" in result &&
            typeof result.result === "object" &&
            result.result !== null &&
            "value" in result.result &&
            typeof result.result.value === "number"
          )
            result.result.value += clockBias;

          return result;
        }),
      params !== undefined && "timestamp" in params && typeof params.timestamp === "number"
        ? params.timestamp
        : undefined,
    );

  cdp.send = delayedSend;
  playwright.keyboard.down = (key) =>
    invoke("keyboard.down", "keyDown", key, () => originalDown(key));
  playwright.keyboard.up = (key) => invoke("keyboard.up", "keyUp", key, () => originalUp(key));
  yield* Effect.addFinalizer(() => Effect.sync(() => gate?.resolve()));

  const page = yield* PageImpl.make({
    id: "input-test",
    playwright,
    cdp,
    clock: yield* Clock.Clock,
    mapping: BrowserClock.mapping(Option.none()),
    motion: yield* Motion.Motion,
    pointer: yield* Ref.make(Option.none<Page.Point>()),
    inputLock: yield* Semaphore.make(1),
    publish: (event) => {
      track.push(event);

      return ++sequence;
    },
    recentEvents: Effect.sync(() => [...track]),
    settings: {
      humanize: options.humanize ?? true,
      actionTimeout: Duration.seconds(30),
      policyTimeout: Duration.seconds(30),
      navigationTimeout: Duration.seconds(30),
      frameHistory: Duration.seconds(5),
      guard: options.guard,
    },
  });

  yield* page.snapshot();
  dispatches.splice(0);

  return {
    page,
    dispatches,
    track,
    shiftClock: () => {
      clockBias = 500;
    },
    watchNextDown: () => {
      nextDown = Promise.withResolvers<void>();

      return nextDown.promise;
    },
    capacityReached: capacityReached.promise,
    holdReplies: () => {
      gate = Promise.withResolvers<void>();
    },
    releaseReplies: () => gate?.resolve(),
    rejectReply: () => {
      rejectNextKeyDown = true;
    },
    maximumOutstanding: () => maximumOutstanding,
  };
});

layer(Chromium.layer(), { excludeTestServices: true, timeout: Duration.seconds(60) })(
  "Input",
  (it) => {
    it.effect("keeps trusted printable typing paced at 70 and 320 ms RTT", () =>
      Effect.gen(function* () {
        const intervals: Array<number> = [];
        const traces: Array<ReadonlyArray<Dispatch>> = [];
        const text = "Az09!? letter and cool blue sky";

        for (const oneWayMillis of [35, 160]) {
          const relay = yield* setup(oneWayMillis);

          yield* relay.page.type(text).pipe(Random.withSeed("remote-input"));
          const events = yield* keys(relay.page);
          const downs = events.filter((event) => event.type === "keydown");
          const ups = events.filter((event) => event.type === "keyup");

          const raw = relay.dispatches.filter(
            (dispatch) => dispatch.method === "Input.dispatchKeyEvent",
          );

          assert.strictEqual(yield* value(relay.page), text);
          assert.deepStrictEqual(
            downs.map((event) => event.key),
            [...text],
          );
          assert.deepStrictEqual(ups.map((event) => event.key).toSorted(), [...text].toSorted());
          const held = new Set<string>();

          const holds = downs.map((down) => {
            const up = events.find(
              (event) => event.type === "keyup" && event.code === down.code && event.at > down.at,
            );

            if (up === undefined) throw new Error("a typed key was never released");

            return up.at - down.at;
          });

          for (const event of events) {
            if (event.type === "keydown") {
              assert.isFalse(
                held.has(event.code),
                "a repeated physical key must be released first",
              );
              held.add(event.code);
            } else assert.isTrue(held.delete(event.code), "every release belongs to one press");
          }
          assert.isEmpty(held);
          const meanHold = holds.reduce((sum, hold) => sum + hold, 0) / holds.length;

          assert.isAbove(meanHold, 75);
          assert.isBelow(meanHold, 165);
          assert.isTrue(
            downs.some((down, index) => {
              const next = downs[index + 1];

              return (
                next !== undefined &&
                next.code !== down.code &&
                next.at < down.at + (holds[index] ?? 0)
              );
            }),
            "different keys can overlap without waiting for their replies",
          );
          assert.isTrue(events.every((event) => event.trusted));
          assert.strictEqual(raw.length, text.length * 2);
          for (const [index, command] of raw.entries()) {
            const event = events[index];

            if (command.timestamp === undefined || event === undefined)
              return yield* Effect.die("a raw key is missing its native timestamp evidence");
            assert.isAbove(command.timestamp, 1_000_000_000);
            assert.closeTo(event.epoch, command.timestamp * 1000, 1);
            assert.isAbove(event.handled - event.epoch, oneWayMillis / 2);
          }
          assert.strictEqual(
            relay.dispatches.filter((dispatch) => dispatch.method.startsWith("Input.")).length,
            raw.length,
          );
          // Typing never evaluates per key: it checks its target once. A page's first input
          // also maps its clock once: a world check and three probes, which registration no
          // longer waits for.
          assert.isAtMost(
            relay.dispatches.filter((dispatch) => dispatch.method === "Runtime.evaluate").length,
            1 + 4,
          );
          assert.isAtMost(relay.maximumOutstanding(), 64);

          const gaps = downs.slice(1).map((event, index) => event.at - (downs[index]?.at ?? 0));
          const average = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;

          assert.isAbove(average, 110);
          assert.isBelow(average, 235);
          intervals.push(average);
          traces.push(raw);

          yield* relay.page.type("é💡").pipe(Random.withSeed("unicode-input"));
          assert.strictEqual(yield* value(relay.page), text + "é💡");
        }

        assert.isBelow(Math.abs((intervals[1] ?? 0) - (intervals[0] ?? 0)), 60);
        const slowerDowns = traces[1]?.filter((dispatch) => dispatch.type === "keyDown") ?? [];

        assert.isAbove(slowerDowns.length, 1);
        assert.isBelow(slowerDowns[1]?.sent ?? Infinity, slowerDowns[0]?.settled ?? 0);
      }),
    );

    it.effect("preserves native mouse and wheel timestamps through 70 and 320ms relays", () =>
      Effect.gen(function* () {
        const nativeType = {
          mouseMoved: "mousemove",
          mousePressed: "mousedown",
          mouseReleased: "mouseup",
          mouseWheel: "wheel",
        } as const;

        for (const oneWayMillis of [35, 160]) {
          const relay = yield* setup(oneWayMillis);

          yield* relay.page.hover({ x: 500, y: 300 });
          yield* relay.page.click({ x: 500, y: 300 });
          yield* relay.page.scroll({ at: { x: 500, y: 300 }, dy: 50 });
          yield* Effect.promise(() =>
            relay.page.playwright.waitForFunction(() =>
              (window as unknown as RecordedWindow).pointerEvents.some(
                (event) => event.type === "wheel",
              ),
            ),
          );

          const events = yield* Effect.promise(() =>
            relay.page.playwright.evaluate(
              () => (window as unknown as RecordedWindow).pointerEvents,
            ),
          );

          const commands = relay.dispatches.filter(
            (command) => command.method === "Input.dispatchMouseEvent",
          );

          assert.isTrue(events.every((event) => event.trusted));
          for (const type of Object.values(nativeType))
            assert.isTrue(
              events.some((event) => event.type === type),
              "missing trusted " + type,
            );
          assert.isTrue(commands.every((command) => command.timestamp !== undefined));
          for (const event of events) {
            const command = commands.find((candidate) => {
              const type = candidate.type;

              return (
                type !== undefined &&
                type in nativeType &&
                nativeType[type as keyof typeof nativeType] === event.type &&
                candidate.timestamp !== undefined &&
                Math.abs(candidate.timestamp * 1000 - event.epoch) < 1
              );
            });

            assert.isDefined(
              command,
              "the native handler must observe the dispatched epoch timestamp",
            );
            assert.isAbove(event.handled - event.epoch, oneWayMillis / 2);
          }
        }
      }),
    );

    it.effect("freezes a typing run's clock mapping across capture recalibration and cleanup", () =>
      Effect.gen(function* () {
        for (const interrupt of [false, true]) {
          const relay = yield* setup(35);
          const firstDown = relay.watchNextDown();

          const typing = yield* relay.page
            .type("the quick brown fox")
            .pipe(Random.withSeed("clock-refresh"), Effect.forkChild);

          yield* Effect.promise(() => firstDown);
          relay.shiftClock();

          const frames = yield* relay.page
            .screencast()
            .pipe(Stream.take(1), Stream.runCollect, Effect.timeout("5 seconds"));

          const frame = frames[0];

          if (frame === undefined) return yield* Effect.die("capture produced no paint evidence");
          assert.isAbove(frame.receivedAt - frame.hostTime, 400);

          if (interrupt) {
            const held = relay.watchNextDown();

            yield* Effect.promise(() => held).pipe(Effect.timeout("5 seconds"));
            yield* Fiber.interrupt(typing);
          } else yield* Fiber.join(typing);
          yield* relay.page.type("z");

          const commands = relay.dispatches.filter(
            (command) => command.method === "Input.dispatchKeyEvent",
          );

          const events = relay.track.filter((event) => event._tag === "KeyChanged");

          assert.strictEqual(commands.length, events.length);
          assert.isAbove(commands.length, 4);

          const offsets = commands.map((command, index) => {
            const event = events[index];

            if (command.timestamp === undefined || event === undefined)
              throw new Error("input lacks its matching dispatch event");
            assert.strictEqual(command.key, event.key);
            assert.strictEqual(command.type === "keyDown" ? "down" : "up", event.phase);

            return command.timestamp * 1000 - event.at;
          });

          const original = offsets[0];

          if (original === undefined) return yield* Effect.die("the typing run did not dispatch");
          for (const offset of offsets.slice(0, -2)) assert.closeTo(offset, original, 0.01);
          for (const offset of offsets.slice(-2)) assert.closeTo(offset - original, 500, 20);

          const observed = yield* keys(relay.page);
          const heldCodes = new Set<string>();

          for (const event of observed) {
            if (event.type === "keydown") {
              assert.isFalse(heldCodes.has(event.code));
              heldCodes.add(event.code);
            } else assert.isTrue(heldCodes.delete(event.code), "cleanup releases each press once");
          }
          assert.isEmpty(heldCodes);
          assert.strictEqual(observed.at(-2)?.key, "z");
          assert.strictEqual(observed.at(-1)?.key, "z");
          if (!interrupt) assert.strictEqual(yield* value(relay.page), "the quick brown foxz");
        }
      }),
    );

    it.effect("types plain text through trusted keys and inserts newlines without submitting", () =>
      Effect.gen(function* () {
        const requests: Array<Page.InputRequest> = [];

        const relay = yield* setup(0, {
          humanize: false,
          guard: (request) =>
            Effect.sync(() => {
              requests.push(request);
            }),
        });

        yield* Effect.promise(() => relay.page.playwright.locator("textarea").focus());
        yield* relay.page.type("aé\n💡b");
        assert.strictEqual(
          yield* Effect.promise(() => relay.page.playwright.locator("textarea").inputValue()),
          "aé\n💡b",
        );
        const events = yield* keys(relay.page);

        assert.deepStrictEqual(
          events.filter((event) => event.type === "keydown").map((event) => event.key),
          ["a", "b"],
        );
        assert.isTrue(events.every((event) => event.trusted));
        assert.strictEqual(
          relay.dispatches.filter((dispatch) => dispatch.method === "Input.dispatchKeyEvent")
            .length,
          4,
        );
        assert.strictEqual(
          relay.dispatches.filter((dispatch) => dispatch.method === "Input.insertText").length,
          3,
        );
        assert.strictEqual(
          yield* Effect.promise(() =>
            relay.page.playwright.evaluate(() => (window as unknown as RecordedWindow).submissions),
          ),
          0,
        );
        assert.isFalse(requests[0]?.facts.includes("form-submit"));

        yield* Effect.promise(() => relay.page.playwright.locator("input").focus());
        yield* relay.page.type("", { submit: true });
        assert.isTrue(requests[1]?.facts.includes("form-submit"));
        assert.strictEqual(
          yield* Effect.promise(() =>
            relay.page.playwright.evaluate(() => (window as unknown as RecordedWindow).submissions),
          ),
          1,
        );
      }),
    );

    it.effect(
      "bounds unresolved typing and waits for its replies before admitting later input",
      () =>
        Effect.gen(function* () {
          const relay = yield* setup(0);

          relay.holdReplies();

          const typing = yield* relay.page
            .type("a".repeat(500))
            .pipe(Random.withSeed("bounded-input"), Effect.forkChild);

          yield* Effect.promise(() => relay.capacityReached).pipe(Effect.timeout("10 seconds"));
          yield* Effect.sleep("200 millis");
          assert.strictEqual(relay.maximumOutstanding(), 64);
          const interrupted = yield* Fiber.interrupt(typing).pipe(Effect.forkChild);
          const later = yield* relay.page.type("z").pipe(Effect.forkChild);

          const before = relay.dispatches.filter((dispatch) =>
            dispatch.method.startsWith("Input."),
          ).length;

          yield* Effect.sleep("150 millis");
          assert.strictEqual(
            relay.dispatches.filter((dispatch) => dispatch.method.startsWith("Input.")).length,
            before,
          );
          relay.releaseReplies();
          yield* Fiber.join(interrupted);
          yield* Fiber.join(later);
          assert.strictEqual(yield* value(relay.page), "a".repeat(32) + "z");
          assert.strictEqual(relay.maximumOutstanding(), 64);
        }),
    );

    it.effect("releases an interrupted held chord once and leaves later typing unmodified", () =>
      Effect.gen(function* () {
        const relay = yield* setup(160);

        const holding = yield* relay.page
          .press("Shift+ArrowLeft", { holdMillis: 5000 })
          .pipe(Effect.forkChild);

        yield* Effect.promise(() =>
          relay.page.playwright.waitForFunction(() =>
            (window as unknown as RecordedWindow).inputEvents.some(
              (event) => event.type === "keydown" && event.key === "ArrowLeft",
            ),
          ),
        );
        yield* Fiber.interrupt(holding);
        yield* relay.page.type("x");
        const events = yield* keys(relay.page);

        assert.deepStrictEqual(
          events.map((event) => [event.type, event.key]),
          [
            ["keydown", "Shift"],
            ["keydown", "ArrowLeft"],
            ["keyup", "ArrowLeft"],
            ["keyup", "Shift"],
            ["keydown", "x"],
            ["keyup", "x"],
          ],
        );
        assert.isTrue(events.every((event) => event.trusted));
        assert.isFalse(events.at(-2)?.shift);
        assert.isFalse(events.at(-2)?.control);
        assert.strictEqual(yield* value(relay.page), "x");
        const downs = relay.dispatches.filter((dispatch) => dispatch.method === "keyboard.down");

        assert.strictEqual(downs.length, 2);
        assert.isBelow(downs[1]?.sent ?? Infinity, downs[0]?.settled ?? 0);
      }),
    );

    it.effect("releases every scheduled text key once when typing is interrupted", () =>
      Effect.gen(function* () {
        const relay = yield* setup(160);

        const typing = yield* relay.page
          .type("the quick brown fox")
          .pipe(Random.withSeed("typing-cleanup"), Effect.forkChild);

        yield* Effect.promise(() =>
          relay.page.playwright.waitForFunction(() =>
            (window as unknown as RecordedWindow).inputEvents.some(
              (event) => event.type === "keydown",
            ),
          ),
        );
        yield* Fiber.interrupt(typing);
        yield* relay.page.type("z");
        const observed = yield* keys(relay.page);
        const held = new Set<string>();

        for (const event of observed) {
          if (event.type === "keydown") {
            assert.isFalse(held.has(event.code));
            held.add(event.code);
          } else assert.isTrue(held.delete(event.code));
        }
        assert.isEmpty(held);
        assert.strictEqual(observed.at(-2)?.key, "z");
        assert.strictEqual(observed.at(-1)?.key, "z");
        assert.isFalse(observed.at(-2)?.shift);
        assert.isFalse(observed.at(-2)?.control);
      }),
    );

    it.effect(
      "reports a lost key reply as dispatched without replaying text or retaining a key",
      () =>
        Effect.gen(function* () {
          const relay = yield* setup(35);

          relay.rejectReply();

          const result = yield* Effect.flip(
            relay.page.type("abcdef").pipe(Random.withSeed("lost-input-reply")),
          );

          assert.strictEqual(result.reason._tag, "Failed");
          assert.isTrue(result.dispatched);
          const partial = yield* value(relay.page);

          assert.isAbove(partial.length, 0);
          assert.isTrue("abcdef".startsWith(partial));
          const events = yield* keys(relay.page);

          const downs = events
            .filter((event) => event.type === "keydown")
            .map((event) => event.key);

          const ups = events.filter((event) => event.type === "keyup").map((event) => event.key);

          assert.deepStrictEqual(ups, downs);
          assert.strictEqual(new Set(downs).size, downs.length);
          yield* relay.page.type("z");
          assert.strictEqual(yield* value(relay.page), partial + "z");
        }),
    );
  },
);
