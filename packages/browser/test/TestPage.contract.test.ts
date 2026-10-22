/** The simulator earns only the reading, action and lifecycle contracts exercised here. */
import { assert, it } from "@effect/vitest";
import { Arbitrary, Cause, Clock, Effect, Exit, Fiber, Option, Stream, Schema } from "effect";
import { TestClock } from "effect/testing";

import { BrowserError, Timeout } from "../src/BrowserError.ts";
import { Subject } from "../src/BrowserEvent.ts";
import { Frame, BrowserPaint } from "../src/Frame.ts";
import { failFast } from "../src/Page.ts";
import * as TestBrowser from "../src/testing/TestBrowser.ts";
import * as TestPage from "../src/testing/TestPage.ts";

const button = {
  key: "save",
  subject: new Subject({ role: "button", name: "Save", tag: "button", context: {} }),
  text: "Save",
  box: { x: 10, y: 10, width: 100, height: 30 },
};

it.effect("seeds a mid-story page and keeps old refs stale across document replacement", () =>
  Effect.gen(function* () {
    const test = yield* TestPage.make({
      url: "https://example.test/step/3",
      title: "Step three",
      elements: [button],
    });

    const [save] = yield* test.page.find({ role: "BUTTON", name: " save " });

    assert.isDefined(save);
    assert.strictEqual(yield* test.page.url, "https://example.test/step/3");
    yield* test.document({
      url: "https://example.test/step/4",
      elements: [
        {
          ...button,
          subject: new Subject({ ...button.subject, name: "Continue" }),
          text: "Continue",
        },
      ],
    });
    assert.strictEqual(
      (yield* Effect.flip(test.page.click(save?.ref ?? ""))).reason._tag,
      "StaleRef",
    );
    const [next] = yield* test.page.find({ text: "continue" });

    assert.notStrictEqual(next?.ref, save?.ref);
  }),
);

it.effect("holds an action in the real lane and preserves dispatched failure evidence", () =>
  Effect.gen(function* () {
    const test = yield* TestPage.make({ elements: [button] });
    const ref = (yield* test.page.find({ name: "Save" }))[0]?.ref ?? "";
    const hold = yield* test.holdNext();
    const click = yield* test.page.click(ref).pipe(Effect.forkScoped);

    yield* hold.entered;
    assert.strictEqual((yield* Effect.flip(failFast(test.page.snapshot()))).reason._tag, "Busy");
    yield* hold.release;
    yield* Fiber.join(click);
    assert.strictEqual((yield* test.actions)[0]?._tag, "Click");
    yield* test.failNext(
      new BrowserError({
        operation: "click",
        reason: new Timeout({ millis: 10_000 }),
        dispatched: true,
      }),
    );
    const failed = yield* Effect.flip(test.page.click(ref));

    assert.deepStrictEqual([failed.reason._tag, failed.dispatched], ["Timeout", true]);
    const last = (yield* test.page.recentEvents).at(-1);

    assert.isTrue(last?._tag === "Action" && !last.ok && last.dispatched);
  }),
);

it.effect("waits for seeded changes on TestClock and leaves a canceled action's lane usable", () =>
  Effect.gen(function* () {
    const test = yield* TestPage.make({ elements: [button] });
    const owner = yield* Clock.Clock;
    const caller = { ...owner, sleep: () => Effect.die("caller clock used") };

    const waiting = yield* test.page
      .until({ text: "Done" }, "some", 1000)
      .pipe(Effect.provideService(Clock.Clock, caller), Effect.forkScoped);

    yield* TestClock.adjust("100 millis");
    const before = (yield* test.page.find())[0]?.ref ?? "";

    yield* failFast(test.page.click(before));
    yield* test.update({
      elements: [
        { ...button, subject: new Subject({ ...button.subject, name: "Done" }), text: "Done" },
      ],
    });
    yield* TestClock.adjust("100 millis");
    assert.isTrue((yield* Fiber.join(waiting)).met);
    const ref = (yield* test.page.find())[0]?.ref ?? "";
    const hold = yield* test.holdNext();
    const action = yield* test.page.click(ref).pipe(Effect.forkScoped);

    yield* hold.entered;
    yield* Fiber.interrupt(action);
    assert.lengthOf((yield* test.page.snapshot()).controls, 1);
  }),
);

it.effect("replays seeded browser page order and drains its actual scoped input gate", () =>
  Effect.gen(function* () {
    const test = yield* TestBrowser.make([{ elements: [button] }, { title: "Second" }]);
    const pages = yield* test.browser.pages;

    assert.lengthOf(pages, 2);
    assert.strictEqual((yield* test.browser.firstPage).id, pages[0]?.id);
    const page = pages[0];

    assert.isDefined(page);
    if (page === undefined) return;
    const ref = (yield* page.find())[0]?.ref ?? "";

    yield* Effect.scoped(
      Effect.gen(function* () {
        const stopped = yield* test.browser.suspend();

        assert.strictEqual(stopped.since, 2);
        assert.strictEqual((yield* Effect.flip(page.click(ref))).reason._tag, "Suspended");
        assert.lengthOf(yield* page.find(), 1);
      }),
    );
    yield* page.click(ref);
    const events = yield* test.browser.events({ after: 0 }).pipe(Stream.take(3), Stream.runCollect);

    assert.deepStrictEqual(
      events.map((record) => [record.sequence, record.event._tag]),
      [
        [1, "PageOpened"],
        [2, "PageOpened"],
        [3, "Action"],
      ],
    );
    yield* page.close;
    assert.lengthOf(yield* test.browser.pages, 1);
    yield* test.disconnect("session");
    assert.strictEqual(yield* test.browser.disconnected, "session");
    assert.strictEqual((yield* Effect.flip(test.browser.newPage())).reason._tag, "Closed");
  }),
);

it.effect("refuses code and records sanitized typed data from explicit outcomes", () =>
  Effect.gen(function* () {
    const test = yield* TestPage.make({
      url: "https://example.test/?token=never-record-me",
      elements: [
        {
          ...button,
          subject: new Subject({ ...button.subject, role: "textbox" }),
          editable: true,
          secret: true,
        },
      ],
    });

    let executed = false;

    const refused = yield* Effect.flip(
      test.page.read(
        () => {
          executed = true;

          return "unexpected";
        },
        { arg: null, result: Schema.String },
      ),
    );

    assert.strictEqual(refused.reason._tag, "InvalidRequest");
    assert.isFalse(executed);
    const ref = (yield* test.page.find())[0]?.ref ?? "";

    yield* test.page.type("private-password", { into: ref, secret: true });
    yield* test.page.goto("https://example.test/?token=another-secret");
    const events = JSON.stringify(yield* test.page.recentEvents);

    assert.notInclude(events, "private-password");
    assert.notInclude(events, "another-secret");
    assert.notInclude(yield* test.page.url, "another-secret");
    assert.strictEqual((yield* test.page.snapshot()).controls[0]?.value, "••••");
  }),
);

it.effect("streams only owned frames and folds explicitly seeded change histories", () =>
  Effect.gen(function* () {
    const test = yield* TestPage.make({
      changes: [
        {
          subject: new Subject({ role: null, name: "", tag: "span", context: {} }),
          kind: "content",
          initial: "$1",
          known: 0,
          samples: [
            { at: 10, shown: "$2", seen: true },
            { at: 20, shown: "$3", seen: true },
          ],
        },
      ],
    });

    const frame = new Frame({
      page: test.page.id,
      session: "test-browser",
      connection: "test-connection",
      data: new Uint8Array([1]),
      timing: new BrowserPaint({ timestamp: 0, hostTime: 0, uncertaintyMillis: 0 }),
      receivedAt: 0,
      width: 20,
      height: 20,
      document: 0,
      url: "about:blank",
    });

    const capture = yield* test.page.capture();

    // Acquisition, rather than starting a stream reader, begins its bounded retention.
    yield* test.emitFrame(frame);

    const waiting = yield* capture.stream.pipe(
      Stream.take(1),
      Stream.runCollect,
      Effect.forkScoped,
    );

    yield* TestClock.adjust("1 millis");
    assert.isDefined(
      waiting.pollUnsafe(),
      "acquired capture retains a frame before stream execution",
    );
    assert.deepStrictEqual(yield* Fiber.join(waiting), [frame]);
    assert.strictEqual(capture.current, frame);
    assert.strictEqual(yield* test.page.frame(), frame);

    const refused = yield* Effect.flip(
      test.emitFrame(new Frame({ ...frame, connection: "foreign" })),
    );

    assert.strictEqual(refused.reason._tag, "InvalidRequest");
    yield* TestClock.adjust("100 millis");
    const changes = yield* test.page.changes({ since: 0, until: 100 });

    assert.deepStrictEqual(
      changes.changes.map(({ before, after, count }) => [before, after, count]),
      [["$1", "$3", 2]],
    );
    yield* test.document({});
    assert.isFalse(capture.isCurrent(frame));
    assert.isUndefined(capture.current);
    assert.strictEqual((yield* Effect.flip(test.page.frame())).reason._tag, "NotFound");
  }),
);

// 1d6d7c7: refused input consumed the next scripted dispatch outcome.
it.effect.prop(
  "refusal histories preserve the next scripted dispatch failure",
  {
    refusals: Arbitrary.array(
      Arbitrary.schema(Schema.Literals(["disabled", "stale", "readonly"])),
      {
        minLength: 1,
        maxLength: 8,
      },
    ),
  },
  ({ refusals }) =>
    Effect.gen(function* () {
      const test = yield* TestPage.make({
        elements: [button, { ...button, key: "locked", state: { disabled: true } }],
      });

      const [ready, locked] = yield* test.page.find();

      const scripted = new BrowserError({
        operation: "click",
        reason: new Timeout({ millis: 10 }),
        dispatched: true,
      });

      yield* test.failNext(scripted);
      for (const refusal of refusals) {
        const error = yield* Effect.flip(
          refusal === "stale"
            ? test.page.click("e9999")
            : refusal === "disabled"
              ? test.page.click(locked!.ref)
              : test.page.type("value", { into: ready!.ref }),
        );

        assert.isFalse(error.dispatched);
      }
      assert.strictEqual(yield* Effect.flip(test.page.click(ready!.ref)), scripted);
    }),
);

it.effect("a stale refusal leaves the next scripted hold on dispatched input", () =>
  Effect.gen(function* () {
    const test = yield* TestPage.make({ elements: [button] });
    const ref = (yield* test.page.find())[0]!.ref;
    const hold = yield* test.holdNext();

    yield* Effect.flip(test.page.click("e9999"));
    const action = yield* test.page.click(ref).pipe(Effect.forkScoped);

    yield* TestClock.adjust("1 milli");
    assert.isUndefined(action.pollUnsafe(), "the next dispatched action must still be held");
    yield* hold.entered;
    yield* hold.release;
    yield* Fiber.join(action);
  }),
);

// Seeded capture must expose the same typed closure as the native capture boundary.
for (const cause of ["page", "session"] as const)
  it.effect(`seeded capture reports ${cause} closure to active and buffered readers`, () =>
    Effect.gen(function* () {
      const test = yield* TestBrowser.make([{}]);
      const page = yield* test.browser.firstPage;
      const active = yield* page.capture();
      const buffered = yield* page.capture();
      const canceled = yield* active.stream.pipe(Stream.runDrain, Effect.forkScoped);

      yield* Fiber.interrupt(canceled);
      assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(canceled)));
      const reader = yield* active.stream.pipe(Stream.runDrain, Effect.forkScoped);

      yield* Effect.yieldNow;
      if (cause === "page") yield* page.close;
      else yield* test.disconnect(cause);
      const late = yield* buffered.stream.pipe(Stream.runDrain, Effect.forkScoped);

      yield* TestClock.adjust("1 milli");
      for (const fiber of [reader, late]) {
        const exit = fiber.pollUnsafe();

        assert.isDefined(exit, "closure must wake a capture without waiting for another frame");

        const failure =
          exit !== undefined && Exit.isFailure(exit)
            ? Cause.findErrorOption(exit.cause)
            : Option.none<BrowserError>();

        assert.isTrue(Option.isSome(failure), "closure is a typed error, not interruption");
        if (Option.isSome(failure)) {
          assert.strictEqual(failure.value.reason._tag, "Closed");
          if (failure.value.reason._tag === "Closed")
            assert.strictEqual(failure.value.reason.cause, cause);
        }
      }
    }),
  );

it.effect(
  "refused seeded input records failure evidence without recording dispatched actions",
  () =>
    Effect.gen(function* () {
      const test = yield* TestPage.make({ elements: [button] });
      const ref = (yield* test.page.find())[0]!.ref;

      yield* Effect.flip(test.page.click("e9999"));
      yield* test.failNext(
        new BrowserError({
          operation: "click",
          reason: new Timeout({ millis: 10 }),
          dispatched: false,
        }),
      );
      yield* Effect.flip(test.page.click(ref));
      assert.deepStrictEqual(yield* test.actions, []);

      const events = (yield* test.page.recentEvents).flatMap((event) =>
        event._tag === "Action" ? [[event.ok, event.dispatched]] : [],
      );

      assert.deepStrictEqual(events, [
        [false, false],
        [false, false],
      ]);
    }),
);

it.effect("bringing a seeded page to front refuses a disconnected browser", () =>
  Effect.gen(function* () {
    const test = yield* TestBrowser.make([{}]);
    const page = yield* test.browser.firstPage;

    yield* test.disconnect("session");
    const error = yield* Effect.flip(page.bringToFront);

    assert.strictEqual(error.reason._tag, "Closed");
  }),
);
