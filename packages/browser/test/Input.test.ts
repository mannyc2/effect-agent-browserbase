import { assert, layer } from "@effect/vitest";
import { Duration, Effect, Fiber, Random, Schedule, Stream } from "effect";

import type * as Page from "../src/Page.ts";
import * as Chromium from "../src/providers/Chromium.ts";
import { keys, setup, value, type Dispatch, type RecordedWindow } from "./support/InputRelay.ts";
import * as TestCdp from "./support/TestCdp.ts";

layer(TestCdp.provideLayer(Chromium.layer()), {
  excludeTestServices: true,
  timeout: Duration.seconds(60),
})("Input", (it) => {
  it.effect("keeps trusted printable typing paced at 70 and 320 ms RTT", () =>
    TestCdp.withCdp(
      Effect.gen(function* () {
        const traces: Array<ReadonlyArray<Dispatch>> = [];
        const text = "Az09!? letter and cool blue sky";

        for (const oneWayMillis of [35, 160]) {
          const relay = yield* setup(oneWayMillis);

          yield* relay.mapClock;
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
          assert.isTrue(
            holds.every((hold) => hold >= 0),
            "releases follow their presses",
          );
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
          // Typing never evaluates per key: it checks its target once.
          assert.strictEqual(
            relay.dispatches.filter((dispatch) => dispatch.method === "Runtime.evaluate").length,
            1,
          );
          assert.isAtMost(relay.maximumOutstanding(), 64);

          traces.push(raw);

          yield* relay.page.type("é💡").pipe(Random.withSeed("unicode-input"));
          assert.strictEqual(yield* value(relay.page), text + "é💡");
        }

        const slowerDowns = traces[1]?.filter((dispatch) => dispatch.type === "keyDown") ?? [];

        assert.isAbove(slowerDowns.length, 1);
        assert.isBelow(slowerDowns[1]?.sent ?? Infinity, slowerDowns[0]?.settled ?? 0);
      }),
    ),
  );

  it.effect("preserves native mouse and wheel timestamps through 70 and 320ms relays", () =>
    TestCdp.withCdp(
      Effect.gen(function* () {
        const nativeType = {
          mouseMoved: "mousemove",
          mousePressed: "mousedown",
          mouseReleased: "mouseup",
          mouseWheel: "wheel",
        } as const;

        for (const oneWayMillis of [35, 160]) {
          const relay = yield* setup(oneWayMillis);

          yield* relay.mapClock;
          yield* relay.page.hover({ x: 500, y: 300 });
          yield* relay.page.click({ x: 500, y: 300 });
          yield* relay.page.scroll({ at: { x: 500, y: 300 }, dy: 50 });
          yield* Effect.promise(() =>
            TestCdp.nativePage(relay.page).waitForFunction(() =>
              (window as unknown as RecordedWindow).pointerEvents.some(
                (event) => event.type === "wheel",
              ),
            ),
          );

          const events = yield* Effect.promise(() =>
            TestCdp.nativePage(relay.page).evaluate(
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
    ),
  );

  it.effect("keeps Chromium's receipt time for input until a capture has mapped the clock", () =>
    TestCdp.withCdp(
      Effect.gen(function* () {
        const relay = yield* setup(35, { performed: false });

        yield* relay.page.click({ x: 500, y: 300 });
        yield* relay.page.type("ab");
        const sent = relay.dispatches.filter((command) => command.method.startsWith("Input."));

        assert.isNotEmpty(sent);
        assert.isTrue(sent.every((command) => command.timestamp === undefined));
        // Input never measures the clock, which would make a world for its probes first.
        assert.isFalse(
          relay.dispatches.some((command) => command.method === "Page.createIsolatedWorld"),
        );
        yield* relay.mapClock;
        yield* relay.page.type("c");

        const keys = relay.dispatches.filter(
          (command) => command.method === "Input.dispatchKeyEvent",
        );

        assert.isNotEmpty(keys);
        assert.isTrue(keys.every((command) => command.timestamp !== undefined));
      }),
    ),
  );

  it.effect("freezes a typing run's clock mapping while the browser measures it again", () =>
    TestCdp.withCdp(
      Effect.gen(function* () {
        for (const interrupt of [false, true]) {
          const relay = yield* setup(35);

          yield* relay.mapClock;
          const firstDown = relay.watchNextDown();

          const typing = yield* relay.page
            .type("the quick brown fox")
            .pipe(Random.withSeed("clock-refresh"), Effect.forkChild);

          yield* Effect.promise(() => firstDown);
          relay.shiftClock();
          const before = relay.mapping.latest()?.offsetMillis ?? Number.NaN;

          // Ten seconds on, a capture starts with the estimate there is and measures again
          // alongside, which finds the clock moved.
          relay.age(10_000);

          const frames = yield* relay.page
            .screencast()
            .pipe(Stream.take(1), Stream.runCollect, Effect.timeout("5 seconds"));

          const frame = frames[0];

          if (frame === undefined) return yield* Effect.die("capture produced no paint evidence");
          assert.strictEqual(frame.page, relay.page.id);
          assert.isAtMost(frame.hostTime, frame.receivedAt + frame.timing.uncertaintyMillis);
          yield* Effect.sync(() => relay.mapping.latest()?.offsetMillis ?? before).pipe(
            Effect.repeat({
              until: (offset) => offset > before + 400,
              schedule: Schedule.spaced("10 millis"),
            }),
            Effect.timeout("5 seconds"),
          );

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
    ),
  );

  // Printable keys go as trusted key pairs and the rest is inserted; under a guard, the approved
  // field takes the whole text in one insertion. Neither submits.
  it.effect("types plain text through trusted keys and inserts newlines without submitting", () =>
    TestCdp.withCdp(
      Effect.gen(function* () {
        const requests: Array<Page.InputRequest> = [];
        const plain = yield* setup(0, { performed: false });

        const guarded = yield* setup(0, {
          performed: false,
          guard: (request) =>
            Effect.sync(() => {
              requests.push(request);
            }),
        });

        const submissions = (relay: typeof plain) =>
          Effect.promise(() =>
            TestCdp.nativePage(relay.page).evaluate(
              () => (window as unknown as RecordedWindow).submissions,
            ),
          );

        for (const [relay, keyDowns, keyEvents, insertions] of [
          [plain, ["a", "b"], 4, 3],
          [guarded, [], 0, 1],
        ] as const) {
          yield* Effect.promise(() => TestCdp.nativePage(relay.page).locator("textarea").focus());
          yield* relay.page.type("aé\n💡b");
          assert.strictEqual(
            yield* Effect.promise(() =>
              TestCdp.nativePage(relay.page).locator("textarea").inputValue(),
            ),
            "aé\n💡b",
          );
          const events = yield* keys(relay.page);

          assert.deepStrictEqual(
            events.filter((event) => event.type === "keydown").map((event) => event.key),
            [...keyDowns],
          );
          assert.isTrue(events.every((event) => event.trusted));
          assert.deepStrictEqual(
            ["Input.dispatchKeyEvent", "Input.insertText"].map(
              (method) => relay.dispatches.filter((dispatch) => dispatch.method === method).length,
            ),
            [keyEvents, insertions],
          );
          assert.strictEqual(yield* submissions(relay), 0);
        }
        assert.isFalse(requests[0]?.facts.includes("form-submit"));

        yield* Effect.promise(() => TestCdp.nativePage(guarded.page).locator("input").focus());
        yield* guarded.page.type("", { submit: true });
        assert.isTrue(requests[1]?.facts.includes("form-submit"));
        assert.strictEqual(yield* submissions(guarded), 1);
      }),
    ),
  );

  it.effect("bounds unresolved typing and waits for its replies before admitting later input", () =>
    TestCdp.withCdp(
      Effect.gen(function* () {
        // Plain input can fill the reply pool without exceeding the separate presentation cap.
        const relay = yield* setup(0, { performed: false });

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
    ),
  );

  it.effect("releases an interrupted held chord once and leaves later typing unmodified", () =>
    TestCdp.withCdp(
      Effect.gen(function* () {
        const relay = yield* setup(160);

        const holding = yield* relay.page
          .press("Shift+ArrowLeft", { holdMillis: 5000 })
          .pipe(Effect.forkChild);

        yield* Effect.promise(() =>
          TestCdp.nativePage(relay.page).waitForFunction(() =>
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
    ),
  );

  it.effect("releases every scheduled text key once when typing is interrupted", () =>
    TestCdp.withCdp(
      Effect.gen(function* () {
        const relay = yield* setup(160);

        const typing = yield* relay.page
          .type("the quick brown fox")
          .pipe(Random.withSeed("typing-cleanup"), Effect.forkChild);

        yield* Effect.promise(() =>
          TestCdp.nativePage(relay.page).waitForFunction(() =>
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
    ),
  );

  it.effect(
    "reports a lost key reply as dispatched without replaying text or retaining a key",
    () =>
      TestCdp.withCdp(
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
      ),
  );
});
