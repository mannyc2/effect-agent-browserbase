// Scripted capture lifetimes prove stage ownership; the native case holds an actual input reply.
import { assert, it, layer } from "@effect/vitest";
import {
  type Cause,
  Clock,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  Queue,
  Schema,
  Scope,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";

import { Browser, make as makeBrowser } from "../src/Browser.ts";
import { BrowserError, Closed, consequence } from "../src/BrowserError.ts";
import { Frame, Screenshot } from "../src/Frame.ts";
import type { Page } from "../src/Page.ts";
import * as Stage from "../src/presentation/Stage.ts";
import * as Chromium from "../src/providers/Chromium.ts";
import * as TestPage from "../src/testing/TestPage.ts";
import * as TestCdp from "./support/TestCdp.ts";

const scripted = Effect.fnUntraced(function* (
  id: string,
  releasing: Effect.Effect<void> = Effect.void,
) {
  const clock = yield* Clock.Clock;
  const queue = yield* Queue.unbounded<Frame | BrowserError, Cause.Done>();
  const stopped = yield* Deferred.make<void>();
  let released = false;
  let onConfirm = () => {};

  const source: Stream.Stream<Frame, BrowserError> = Stream.unwrap(
    Effect.acquireRelease(Effect.void, () =>
      releasing.pipe(
        Effect.andThen(
          Effect.sync(() => {
            released = true;
          }),
        ),
        Effect.andThen(Deferred.succeed(stopped, undefined)),
      ),
    ).pipe(
      Effect.as(
        Stream.fromQueue(queue).pipe(
          Stream.mapEffect((value) =>
            Schema.is(BrowserError)(value) ? Effect.fail(value) : Effect.succeed(value),
          ),
        ),
      ),
    ),
  );

  // Public capture-port substitute: no platform object or private page identity is needed.
  const test = yield* TestPage.make(
    { url: "https://fixture.test" },
    { id, session: "scripted", connection: "fixture-connection" },
  );

  const page: Page = {
    ...test.page,
    capture: () =>
      Effect.succeed({
        stream: source,
        current: undefined,
        isCurrent: () => true,
        confirm: () =>
          Effect.sync(() => {
            onConfirm();

            return false;
          }),
        sync: Effect.void,
        stats: test.page.captureStats,
      }),
  };

  const paintAt = (at: number) =>
    Queue.offer(
      queue,
      new Frame({
        page: id,
        session: "scripted",
        connection: "fixture-connection",
        document: 0,
        url: "https://fixture.test",
        data: new Uint8Array(),
        width: 1,
        height: 1,
        receivedAt: at,
        timing: new Screenshot({ hostTime: at, uncertaintyMillis: 0 }),
      }),
    );

  return {
    page,
    onConfirm: (probe: () => void) => {
      onConfirm = probe;
    },
    paint: Effect.suspend(() => paintAt(Number(clock.monotonicTimeNanosUnsafe()) / 1e6)),
    paintAt,
    stopped: Deferred.await(stopped),
    finish: Queue.end(queue),
    released: () => released,
    fail: Queue.offer(
      queue,
      new BrowserError({
        operation: "screencast",
        reason: new Closed({ cause: "connection" }),
        dispatched: false,
      }),
    ),
  };
});

// PLAN 11: callers can recover from invalid stream options without catching defects.
it.effect("invalid shown holds fail through the typed error channel", () =>
  TestCdp.withCdp(
    Effect.gen(function* () {
      const stage = yield* Stage.make();
      const exit = yield* stage.shown({ hold: 0 }).pipe(Stream.runDrain, Effect.exit);

      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        const error = Exit.findErrorOption(exit);

        assert.isTrue(Option.isSome(error), "invalid hold must be a typed error, not a defect");
        if (Option.isSome(error)) assert.strictEqual(error.value.reason._tag, "InvalidRequest");
      }
    }),
  ),
);

// #282: control delivery separately from capture time to model a late frame after silence.
it.effect("keeps the shown timeline monotonic through prepared switches and late paint", () =>
  TestCdp.withCdp(
    Effect.gen(function* () {
      const stage = yield* Stage.make();
      const seen = yield* Queue.unbounded<Stage.Shown>();

      const model: Array<{
        readonly tag: Stage.Shown["_tag"];
        readonly at: number;
        readonly captured: number;
      }> = [];

      const observed: Array<Stage.Shown> = [];

      yield* stage.shown({ hold: "100 millis" }).pipe(
        Stream.runForEach((value) => Queue.offer(seen, value)),
        Effect.forkScoped,
      );
      for (let turn = 0; turn < 3; turn++) {
        const fixture = yield* scripted(`page-${turn}`);
        const cue = yield* stage.cue(fixture.page);
        const start = turn * 200;

        yield* fixture.paintAt(start);
        yield* cue.ready;
        yield* TestClock.adjust("20 millis");
        const presented = yield* cue.commit();

        model.push({ tag: "Painted", at: start + 20, captured: start });
        assert.strictEqual(presented.at, start + 20);
        observed.push(yield* Queue.take(seen));
        yield* TestClock.adjust("10 millis");
        yield* fixture.paint;
        observed.push(yield* Queue.take(seen));
        yield* TestClock.adjust("170 millis");
        model.push({ tag: "Painted", at: start + 30, captured: start + 30 });
        model.push({ tag: "Stalled", at: start + 130, captured: start + 30 });
        observed.push(yield* Queue.take(seen));
        yield* fixture.paintAt(start + 40);
        observed.push(yield* Queue.take(seen));
        model.push({ tag: "Painted", at: start + 130, captured: start + 40 });
      }
      assert.deepStrictEqual(
        observed.map((value) => ({
          tag: value._tag,
          at: value.at,
          captured: value._tag === "Gone" ? undefined : value.frame.hostTime,
        })),
        model,
      );
    }),
  ),
);

// #282: a slow output reader must see the switch before later silence evidence for that page.
it.effect("preserves the switch time when a paused reader resumes after silence", () =>
  TestCdp.withCdp(
    Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      // The host clock advances before the timer wakes, as when its event loop was delayed.
      let hostTime = 0;

      const stage = yield* Stage.make().pipe(
        Effect.provideService(Clock.Clock, {
          ...clock,
          monotonicTimeNanosUnsafe: () => BigInt(hostTime) * 1_000_000n,
        }),
      );

      const resume = yield* Deferred.make<void>();
      const entered = yield* Deferred.make<void>();
      const switched = yield* Deferred.make<void>();
      const observed: Array<Stage.Shown> = [];
      const first = yield* scripted("first");
      const one = yield* stage.cue(first.page);

      yield* first.paint;
      yield* one.ready;
      yield* one.commit();

      yield* stage.shown({ hold: "100 millis" }).pipe(
        Stream.runForEach((value) =>
          Effect.gen(function* () {
            observed.push(value);
            if (observed.length === 1) {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(resume);
            }
            if (value._tag === "Painted" && value.frame.page === "next")
              yield* Deferred.succeed(switched, undefined);
          }),
        ),
        Effect.forkScoped,
      );
      hostTime = 1;
      yield* TestClock.adjust("1 millis");
      yield* first.paint;
      yield* Deferred.await(entered);
      for (let paint = 0; paint < 4; paint++) {
        hostTime += 10;
        yield* TestClock.adjust("10 millis");
        yield* first.paint;
      }
      hostTime += 10;
      yield* TestClock.adjust("10 millis");
      const next = yield* scripted("next");
      const two = yield* stage.cue(next.page);

      yield* next.paint;
      const presented = yield* two.commit();

      const probed = yield* Deferred.make<void>();

      next.onConfirm(() => {
        Deferred.doneUnsafe(probed, Exit.void);
      });
      hostTime += 100;
      yield* TestClock.adjust("100 millis");
      yield* Deferred.await(probed);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(resume, undefined);
      yield* Deferred.await(switched);

      const nextValues = observed.filter(
        (value) => value._tag !== "Gone" && value.frame.page === "next",
      );

      assert.strictEqual(nextValues[0]?._tag, "Painted");
      assert.strictEqual(nextValues[0]?.at, presented.at);
      assert.deepStrictEqual(
        observed.map(({ at }) => at),
        observed.map(({ at }) => at).toSorted((a, b) => a - b),
      );
    }),
  ),
);

it.live("a prepared frame cannot hide its capture's terminal failure or completion", () =>
  TestCdp.withCdp(
    Effect.forEach(["failure", "completion"], (ending) =>
      Effect.gen(function* () {
        const fixture = yield* scripted(ending);
        const stage = yield* Stage.make();
        const cue = yield* stage.cue(fixture.page);

        yield* fixture.paint;
        yield* cue.ready;
        yield* ending === "failure" ? fixture.fail : fixture.finish;
        yield* fixture.stopped;
        yield* Effect.yieldNow;
        const ready = yield* cue.ready.pipe(Effect.flip);

        const commit = yield* cue.commit().pipe(Effect.flip);

        // #284: stream completion ends the cue; only a reported connection loss ends the session.
        for (const error of [ready, commit]) {
          assert.deepStrictEqual(
            consequence(error),
            ending === "failure"
              ? { lost: "session", repeat: "safe" }
              : { lost: "nothing", repeat: "pointless" },
          );
          if (ending === "failure")
            assert.deepStrictEqual(error.reason, new Closed({ cause: "connection" }));
        }
        assert.isTrue(Option.isNone(yield* stage.current));
      }).pipe(Effect.scoped),
    ),
  ),
);

it.live("caller interruption after a switch waits for the outgoing capture to close", () =>
  TestCdp.withCdp(
    Effect.gen(function* () {
      const closing = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();

      const first = yield* scripted(
        "first",
        Deferred.succeed(closing, undefined).pipe(Effect.andThen(Deferred.await(finish))),
      );

      const second = yield* scripted("second");
      const stage = yield* Stage.make();
      const one = yield* stage.cue(first.page);

      yield* first.paint;
      yield* one.commit();
      const two = yield* stage.cue(second.page);

      yield* second.paint;
      const committing = yield* two.commit().pipe(Effect.forkChild);

      yield* Deferred.await(closing);
      const interrupting = yield* Fiber.interrupt(committing).pipe(Effect.forkChild);

      yield* Effect.sleep("20 millis");
      assert.isUndefined(interrupting.pollUnsafe());
      assert.isFalse(first.released());
      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.join(interrupting);
      assert.isTrue(first.released());
      assert.deepStrictEqual(yield* stage.current, Option.some(second.page));
    }),
  ),
);

it.live(
  "queued commits keep their turn ahead of a new caller, and cancellation removes a turn",
  () =>
    TestCdp.withCdp(
      Effect.forEach([false, true], (cancel) =>
        Effect.gen(function* () {
          const closing = yield* Deferred.make<void>();
          const finish = yield* Deferred.make<void>();

          const old = yield* scripted(
            "old",
            Deferred.succeed(closing, undefined).pipe(Effect.andThen(Deferred.await(finish))),
          );

          const stage = yield* Stage.make();
          const order: Array<string> = [];

          yield* stage.frames.pipe(
            Stream.filter((frame) => frame.page !== "old"),
            Stream.runForEach((frame) => Effect.sync(() => void order.push(frame.page))),
            Effect.forkScoped,
          );
          const initial = yield* stage.cue(old.page);

          yield* old.paint;
          yield* initial.commit();

          const prepare = (name: string) =>
            Effect.gen(function* () {
              const fixture = yield* scripted(name);
              const cue = yield* stage.cue(fixture.page);

              yield* fixture.paint;

              return cue;
            });

          const a = yield* prepare("A");
          const b = yield* prepare("B");
          const c = yield* prepare("C");
          const chained = yield* a.commit().pipe(Effect.andThen(c.commit()), Effect.forkChild);

          yield* Deferred.await(closing);
          const queued = yield* b.commit().pipe(Effect.forkChild);

          yield* Effect.yieldNow;
          if (cancel) yield* Fiber.interrupt(queued);
          yield* Effect.sleep("30 millis");
          yield* Deferred.succeed(finish, undefined);
          yield* Fiber.join(chained);
          if (!cancel) {
            const presented = yield* Fiber.join(queued);

            assert.isAtLeast(
              presented.latency,
              20,
              "default latency includes the wait for its turn",
            );
          }
          yield* Effect.yieldNow;
          assert.deepStrictEqual(order, cancel ? ["A", "C"] : ["A", "B", "C"]);
          assert.strictEqual(Option.getOrThrow(yield* stage.current).id, "C");
        }).pipe(Effect.scoped),
      ),
    ),
);

// On the test clock a paint lands every 10 ms however slowly the host runs; a live clock under load
// leaves real gaps longer than the hold, which the stage rightly reports.
it.effect("continuous paint resets the silence deadline", () =>
  TestCdp.withCdp(
    Effect.gen(function* () {
      const fixture = yield* scripted("painting");
      const stage = yield* Stage.make();
      const seen = yield* Queue.unbounded<Stage.Shown>();

      yield* stage.shown({ hold: "80 millis" }).pipe(
        Stream.runForEach((value) => Queue.offer(seen, value)),
        Effect.forkScoped,
      );
      const cue = yield* stage.cue(fixture.page);

      yield* fixture.paint;
      yield* cue.commit();
      for (let at = 10; at <= 250; at += 10) {
        yield* TestClock.adjust("10 millis");
        yield* fixture.paint;
        // Each paint reaches the reader before time moves on, with nothing else first. The reader
        // may have subscribed before or after the commit's own paint.
        let shown = yield* Queue.take(seen);

        while (shown._tag === "Painted" && shown.frame.receivedAt < at)
          shown = yield* Queue.take(seen);
        assert.deepStrictEqual([shown._tag, shown.at], ["Painted", at]);
      }
      // The deadline was live all along: silence is told by the probe after the first full hold.
      yield* TestClock.adjust("79 millis");
      assert.strictEqual(yield* Queue.size(seen), 0);
      yield* TestClock.adjust("1 millis");
      const stalled = yield* Queue.take(seen);

      assert.deepStrictEqual([stalled._tag, stalled.at], ["Stalled", 330]);
    }),
  ),
);

it.live("closing a cue wakes a commit waiting for a future event", () =>
  TestCdp.withCdp(
    Effect.gen(function* () {
      const fixture = yield* scripted("future");
      const stage = yield* Stage.make();
      const scope = yield* Scope.fork(yield* Effect.scope);
      const cue = yield* stage.cue(fixture.page).pipe(Scope.provide(scope));

      yield* fixture.paint;
      yield* cue.ready;
      const clock = yield* Clock.Clock;
      const at = Number(clock.monotonicTimeNanosUnsafe()) / 1e6 + 60_000;
      const committing = yield* cue.commit({ at }).pipe(Effect.flip, Effect.forkChild);

      yield* Effect.yieldNow;
      yield* Scope.close(scope, Exit.void);
      const error = yield* Fiber.join(committing).pipe(Effect.timeout("200 millis"));

      assert.deepStrictEqual(consequence(error), { lost: "nothing", repeat: "pointless" });
      assert.isTrue(Option.isNone(yield* stage.current));
    }),
  ),
);

it.live("a capture that reports connection loss emits Gone without a page-close event", () =>
  TestCdp.withCdp(
    Effect.gen(function* () {
      const fixture = yield* scripted("lost");
      const stage = yield* Stage.make();
      const seen: Array<Stage.Shown> = [];

      yield* stage.shown({ hold: "20 millis" }).pipe(
        Stream.runForEach((value) => Effect.sync(() => void seen.push(value))),
        Effect.forkScoped,
      );
      const cue = yield* stage.cue(fixture.page);

      yield* fixture.paint;
      yield* cue.commit();
      yield* fixture.fail;
      yield* fixture.stopped;
      yield* Effect.sleep("100 millis");
      assert.strictEqual(seen.filter((value) => value._tag === "Gone").length, 1);
      assert.strictEqual(seen.at(-1)?._tag, "Gone");
    }),
  ),
);

layer(TestCdp.provideLayer(Chromium.layer()), { excludeTestServices: true })(
  "stage input drain failure",
  (it) => {
    it.effect(
      "keeps later old-page input behind the cut while awaiting a new document's paint",
      () =>
        TestCdp.withCdp(
          // Native replies and frames control progress; drive the owning deadline independently
          // of how long other Chromium test processes take to schedule their work.
          Effect.gen(function* () {
            const native = TestCdp.nativeContext(yield* Browser).browser();

            if (native === null) return yield* Effect.die("local Chromium is required");

            const context = yield* Effect.acquireRelease(
              Effect.promise(() => native.newContext()),
              (context) => Effect.promise(() => context.close()),
            );

            const faults = yield* TestCdp.make();
            let resumeFrames = () => {};

            const browser = yield* faults.provide(
              makeBrowser(
                context,
                { id: "cut", provider: "local" },
                { actionTimeout: "2 seconds" },
              ),
            );

            const first = yield* browser.newPage("data:text/html,<h1>First</h1>");
            const second = yield* browser.newPage("data:text/html,<h1>Second</h1>");
            const stage = yield* Stage.make({ firstFrame: "2 seconds" });

            yield* stage.present(first);
            const cue = yield* stage.cue(second);

            yield* cue.ready;
            const sent = yield* Deferred.make<void>();
            const gate = yield* Deferred.make<void>();
            const answer = { resolve: () => Deferred.doneUnsafe(gate, Effect.void) };
            let calls = 0;

            faults.rule(
              { page: first.id, method: "keyboard.down" },
              { _tag: "Hold", gate },
              { phase: "after", times: 1 },
            );
            faults.observe((call, phase) => {
              if (call.session.page !== first.id || call.method !== "keyboard.down") return;
              if (phase === "before") calls++;
              if (phase === "received" && calls === 1) Deferred.doneUnsafe(sent, Effect.void);
            });
            yield* Effect.addFinalizer(() => Deferred.succeed(gate, undefined));
            const input = yield* first.press("a").pipe(Effect.forkChild);

            yield* Deferred.await(sent);
            const committing = yield* cue.commit().pipe(Effect.forkChild);

            yield* TestClock.adjust("30 millis");
            resumeFrames = faults.rule(
              { page: second.id, method: "Page.screencastFrame" },
              { _tag: "Drop", acknowledge: true },
              { phase: "event" },
            );
            yield* second.goto("data:text/html,<h1>New document</h1>");
            answer.resolve();
            yield* Fiber.join(input);
            yield* TestClock.adjust("30 millis");
            const queued = yield* first.press("b").pipe(Effect.forkChild);

            yield* TestClock.adjust("50 millis");
            assert.strictEqual(calls, 1, "the next old-page operation must wait behind the cut");
            assert.isUndefined(committing.pollUnsafe());
            resumeFrames();
            yield* Effect.promise(() =>
              TestCdp.nativePage(second).evaluate(() => {
                document.body.style.background = "blue";
              }),
            );
            yield* Fiber.join(committing);
            yield* Fiber.join(queued);
            assert.strictEqual(calls, 2);
            assert.deepStrictEqual(yield* stage.current, Option.some(second));
          }).pipe(Effect.provide(TestClock.layer())),
        ),
    );
    it.effect("a missing old-page input acknowledgement refuses the reveal", () =>
      TestCdp.withCdp(
        Effect.gen(function* () {
          const native = TestCdp.nativeContext(yield* Browser).browser();

          if (native === null) return yield* Effect.die("local Chromium is required");

          const context = yield* Effect.acquireRelease(
            Effect.promise(() => native.newContext()),
            (context) => Effect.promise(() => context.close()),
          );

          const sent = yield* Deferred.make<void>();
          const answer = { resolve: () => Deferred.doneUnsafe(gate, Effect.void) };

          const browser = yield* makeBrowser(
            context,
            { id: "drain", provider: "local" },
            { actionTimeout: "100 millis", navigationTimeout: "200 millis" },
          );

          const first = yield* browser.newPage("data:text/html,<h1>First</h1>");
          const second = yield* browser.newPage("data:text/html,<h1>Second</h1>");
          const stage = yield* Stage.make();

          yield* stage.present(first);
          const cue = yield* stage.cue(second);

          yield* cue.ready;
          const faults = yield* TestCdp.TestCdp;
          const gate = yield* Deferred.make<void>();

          faults.rule(
            { page: first.id, method: "keyboard.down" },
            { _tag: "Hold", gate },
            { phase: "after", times: 1 },
          );
          faults.observe((call, phase) => {
            if (
              call.session.page === first.id &&
              call.method === "keyboard.down" &&
              phase === "received"
            )
              Deferred.doneUnsafe(sent, Effect.void);
          });
          yield* Effect.addFinalizer(() => Deferred.succeed(gate, undefined));
          const action = yield* first.press("A").pipe(Effect.exit, Effect.forkChild);

          yield* Deferred.await(sent);
          yield* Fiber.join(action);
          const failure = yield* cue.commit().pipe(Effect.flip);

          assert.strictEqual(failure.reason._tag, "Timeout");
          assert.deepStrictEqual(yield* stage.current, Option.some(first));
          answer.resolve();
          yield* cue.commit();
          assert.deepStrictEqual(yield* stage.current, Option.some(second));
        }),
      ),
    );
  },
);

// A completed cut is not an input-drain failure when the outgoing capture takes longer to stop.
it.live("outgoing capture cleanup cannot time out a cut that already reached the output", () =>
  TestCdp.withCdp(
    Effect.gen(function* () {
      const faults = yield* TestCdp.make();
      const browser = yield* faults.provide(Chromium.open({ navigationTimeout: "200 millis" }));
      const stopping = Promise.withResolvers<void>();
      const gate = yield* Deferred.make<void>();
      const release = { resolve: () => Deferred.doneUnsafe(gate, Effect.void) };
      let ended = false;

      faults.rule({ method: "Page.stopScreencast" }, { _tag: "Hold", gate }, { phase: "after" });
      faults.observe((call, phase) => {
        if (call.method !== "Page.stopScreencast") return;
        if (phase === "received") stopping.resolve();
        if (phase === "after") ended = true;
      });
      yield* Effect.addFinalizer(() => Deferred.succeed(gate, undefined));
      const first = yield* browser.newPage("data:text/html,<h1>First</h1>");
      const second = yield* browser.newPage("data:text/html,<h1>Second</h1>");
      const stage = yield* Stage.make();

      yield* stage.present(first);
      const cue = yield* stage.cue(second);

      yield* cue.ready;
      const committing = yield* cue.commit().pipe(Effect.exit, Effect.forkChild);

      yield* Effect.promise(() => stopping.promise);
      const current = yield* stage.current;

      yield* Effect.sleep("400 millis");
      const early = committing.pollUnsafe();

      // Release before checking, so the regression also cleans up the broken implementation.
      release.resolve();
      const result = yield* Fiber.join(committing);

      assert.deepStrictEqual(current, Option.some(second));
      assert.isUndefined(early, "commit still owns outgoing capture cleanup");
      assert.isTrue(ended);
      assert.strictEqual(
        Exit.isSuccess(result)
          ? "Presented"
          : Option.getOrUndefined(Exit.findErrorOption(result))?.reason._tag,
        "Presented",
        "the visible cut must return its Presented receipt",
      );
      if (Exit.isSuccess(result)) assert.strictEqual(result.value.page, second.id);
    }).pipe(Effect.scoped),
  ),
);
