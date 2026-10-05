import { setTimeout as sleep } from "node:timers/promises";

import { assert, layer } from "@effect/vitest";
import { Clock, Duration, Effect, Fiber, Option, Random, Ref, Semaphore } from "effect";
import type { CDPSession } from "playwright-core";

import { Browser } from "../src/Browser.ts";
import * as Chromium from "../src/Chromium.ts";
import * as Page from "../src/Page.ts";

interface RecordedKey {
  readonly type: string;
  readonly key: string;
  readonly code: string;
  readonly at: number;
  readonly trusted: boolean;
  readonly shift: boolean;
  readonly control: boolean;
}

interface Dispatch {
  readonly method: string;
  readonly type: string | undefined;
  readonly key: string | undefined;
  readonly sent: number;
  delivered?: number;
  settled?: number;
}

interface RecordedWindow {
  readonly inputEvents: Array<RecordedKey>;
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

      Object.assign(recorded, { inputEvents: [], submissions: 0 });
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
            at: event.timeStamp,
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
  const capacityReached = Promise.withResolvers<void>();
  let gate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  let outstanding = 0;
  let maximumOutstanding = 0;
  let rejectNextKeyDown = false;
  let sequence = 0;

  const invoke = async <A>(
    method: string,
    type: string | undefined,
    key: string | undefined,
    run: () => Promise<A>,
  ): Promise<A> => {
    const input = method.startsWith("Input.") || method.startsWith("keyboard.");
    const dispatch: Dispatch = { method, type, key, sent: performance.now() };
    const rejectReply = rejectNextKeyDown && type === "keyDown";

    if (rejectReply) rejectNextKeyDown = false;
    dispatches.push(dispatch);
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
      () => originalSend(method, params),
    );

  cdp.send = delayedSend;
  playwright.keyboard.down = (key) =>
    invoke("keyboard.down", "keyDown", key, () => originalDown(key));
  playwright.keyboard.up = (key) => invoke("keyboard.up", "keyUp", key, () => originalUp(key));
  yield* Effect.addFinalizer(() => Effect.sync(() => gate?.resolve()));

  const page = yield* Page.make({
    id: "input-test",
    playwright,
    cdp,
    clock: yield* Clock.Clock,
    pointer: yield* Ref.make(Option.none<Page.Point>()),
    inputLock: yield* Semaphore.make(1),
    publish: () => ++sequence,
    settings: {
      humanize: options.humanize ?? true,
      actionTimeout: Duration.seconds(30),
      policyTimeout: Duration.seconds(30),
      navigationTimeout: Duration.seconds(30),
      frameHistory: 1,
      guard: options.guard,
    },
  });

  yield* page.snapshot();
  dispatches.splice(0);

  return {
    page,
    dispatches,
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
          assert.strictEqual(
            relay.dispatches.filter((dispatch) => dispatch.method.startsWith("Input.")).length,
            raw.length,
          );
          assert.isAtMost(
            relay.dispatches.filter((dispatch) => dispatch.method === "Runtime.evaluate").length,
            3,
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
        assert.isFalse(requests[0]?.classifications.includes("form-submit"));

        yield* Effect.promise(() => relay.page.playwright.locator("input").focus());
        yield* relay.page.type("", { submit: true });
        assert.isTrue(requests[1]?.classifications.includes("form-submit"));
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
