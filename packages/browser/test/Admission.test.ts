import { assert, describe, it, layer } from "@effect/vitest";
import { Arbitrary, Clock, Deferred, Duration, Effect, Exit, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";

import { Browser, make as makeBrowser, type Options } from "../src/Browser.ts";
import { BrowserError, Closed, consequence } from "../src/BrowserError.ts";
import * as Lane from "../src/internal/page/lane.ts";
import * as Input from "../src/internal/page/replies.ts";
import { failFast, type Page } from "../src/Page.ts";
import { maximumSamples } from "../src/presentation/Motion.ts";
import * as Chromium from "../src/providers/Chromium.ts";
import * as Style from "../src/Style.ts";
import * as TestCdp from "./support/TestCdp.ts";

interface Receipt {
  readonly kind: string;
  readonly resolve: () => void;
  readonly reject: (cause: unknown) => void;
  settled: boolean;
}

/** Replies stay under test control after submission, just as a lost CDP receipt remains owned. */
const heldReplies = Effect.gen(function* () {
  const receipts: Receipt[] = [];
  let outstanding = 0;
  let maximumOutstanding = 0;

  const issue = (kind = "move") => {
    const reply = Promise.withResolvers<void>();

    receipts.push({ kind, resolve: () => reply.resolve(), reject: reply.reject, settled: false });
    outstanding += 1;
    maximumOutstanding = Math.max(maximumOutstanding, outstanding);

    return reply.promise;
  };

  const settle = (index: number, cause?: unknown) => {
    const receipt = receipts[index];

    if (receipt === undefined) throw new Error("the test did not submit this command");
    if (receipt.settled) return;
    receipt.settled = true;
    outstanding -= 1;
    if (cause === undefined) receipt.resolve();
    else receipt.reject(cause);
  };

  const settleAll = () => {
    for (let index = 0; index < receipts.length; index++) settle(index);
  };

  yield* Effect.addFinalizer(() => Effect.sync(settleAll));

  return {
    receipts,
    issue,
    settle,
    settleAll,
    outstanding: () => outstanding,
    maximumOutstanding: () => maximumOutstanding,
  };
});

describe("Input admission", () => {
  it.effect(
    "waits at the ordinary bound and admits exactly one command when its reply arrives",
    () =>
      TestCdp.withCdp(
        Effect.gen(function* () {
          const replies = yield* heldReplies;
          const run = yield* Input.make().begin;

          yield* run.reserve(Input.capacity);
          for (let index = 0; index < Input.capacity; index++)
            yield* run.send(() => replies.issue("key"));

          const next = yield* run
            .reserve(1)
            .pipe(Effect.andThen(run.send(() => replies.issue("key"))), Effect.forkScoped);

          yield* Effect.yieldNow;
          assert.strictEqual(replies.receipts.length, Input.capacity);
          replies.settle(0);
          yield* Fiber.join(next);
          assert.strictEqual(replies.receipts.length, Input.capacity + 1);
          assert.strictEqual(replies.maximumOutstanding(), Input.capacity);
          replies.settleAll();
          yield* run.drain;
          yield* run.close;
        }).pipe(Effect.scoped),
      ),
  );

  it.effect(
    "admits a complete maximum motion while keeping a strict combined bound and ordinary input separate",
    () =>
      TestCdp.withCdp(
        Effect.gen(function* () {
          const replies = yield* heldReplies;
          const run = yield* Input.make().begin;
          const limit = Input.capacity + maximumSamples;

          yield* run.reserve(Input.capacity);
          for (let index = 0; index < Input.capacity; index++)
            yield* run.send(() => replies.issue("key"));
          yield* run.reserveMotion(maximumSamples);
          for (let index = 0; index < maximumSamples; index++)
            yield* run.send(() => replies.issue());
          assert.strictEqual(replies.receipts.length, limit);
          assert.strictEqual(replies.maximumOutstanding(), limit);

          const ordinary = yield* run
            .reserve(1)
            .pipe(Effect.andThen(run.send(() => replies.issue("key"))), Effect.forkScoped);

          const motion = yield* run
            .reserveMotion(1)
            .pipe(Effect.andThen(run.send(() => replies.issue())), Effect.forkScoped);

          yield* Effect.yieldNow;
          assert.strictEqual(replies.receipts.length, limit);

          replies.settle(0);
          yield* Fiber.join(motion);
          assert.strictEqual(replies.receipts.length, limit + 1);
          assert.strictEqual(replies.receipts.at(-1)?.kind, "move");
          assert.strictEqual(replies.outstanding(), limit);
          assert.strictEqual(replies.maximumOutstanding(), limit);

          // Releasing one motion slot must not let ordinary input borrow the larger motion budget.
          for (let index = 1; index < limit - Input.capacity + 1; index++) replies.settle(index);
          yield* Effect.yieldNow;
          assert.strictEqual(replies.receipts.length, limit + 1);
          assert.strictEqual(replies.outstanding(), Input.capacity);
          replies.settle(limit - Input.capacity + 1);
          yield* Fiber.join(ordinary);
          assert.strictEqual(replies.receipts.at(-1)?.kind, "key");
          assert.strictEqual(replies.outstanding(), Input.capacity);
          assert.strictEqual(replies.maximumOutstanding(), limit);
          replies.settleAll();
          yield* run.drain;
          yield* run.close;
        }).pipe(Effect.scoped),
      ),
  );

  it.effect(
    "stops new dispatch after a failed motion receipt without abandoning the other replies",
    () =>
      TestCdp.withCdp(
        Effect.gen(function* () {
          const replies = yield* heldReplies;
          const run = yield* Input.make().begin;
          const lost = new Error("the command ran but its receipt was lost");

          yield* run.reserveMotion(4);
          for (let index = 0; index < 3; index++) yield* run.send(() => replies.issue());
          replies.settle(1, lost);
          yield* Effect.yieldNow;
          const failure = yield* run.send(() => replies.issue()).pipe(Effect.flip);

          assert.strictEqual(failure.cause, lost);
          assert.strictEqual(replies.receipts.length, 3);
          let drained = false;

          const drain = yield* run.drain.pipe(
            Effect.exit,
            Effect.tap(() =>
              Effect.sync(() => {
                drained = true;
              }),
            ),
            Effect.forkScoped,
          );

          yield* Effect.yieldNow;
          assert.isFalse(drained);
          replies.settleAll();
          const exit = yield* Fiber.join(drain);

          assert.isTrue(Exit.isFailure(exit));
          assert.strictEqual(replies.receipts.length, 3);
          yield* run.close;
        }).pipe(Effect.scoped),
      ),
  );

  it.effect(
    "releases a held button once after an interrupted motion and retains every submitted reply across runs",
    () =>
      TestCdp.withCdp(
        Effect.gen(function* () {
          const replies = yield* heldReplies;
          const input = Input.make();
          const run = yield* input.begin;

          yield* run.reserve(2);
          yield* run.down(
            "mouse:left",
            () => replies.issue("down"),
            () => replies.issue("up"),
          );
          const started = yield* Deferred.make<void>();

          const performer = yield* Effect.gen(function* () {
            yield* run.reserveMotion(maximumSamples);
            for (let index = 0; index < Input.capacity + 6; index++)
              yield* run.send(() => replies.issue());
            yield* Deferred.succeed(started, undefined);

            return yield* Effect.never;
          }).pipe(Effect.ensuring(run.close), Effect.forkScoped);

          yield* Deferred.await(started);
          yield* Fiber.interrupt(performer);
          yield* run.close;
          assert.strictEqual(replies.receipts.filter((receipt) => receipt.kind === "up").length, 1);
          const submitted = replies.receipts.length;

          assert.strictEqual(submitted, Input.capacity + 8);
          let began = false;

          const next = yield* input.begin.pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                began = true;
              }),
            ),
            Effect.forkScoped,
          );

          yield* Effect.yieldNow;
          assert.isFalse(began);
          for (let index = 0; index < submitted - 1; index++) replies.settle(index);
          yield* Effect.yieldNow;
          assert.isFalse(began, "the unresolved release still belongs to the old run");
          replies.settle(submitted - 1);
          const fresh = yield* Fiber.join(next);

          assert.isTrue(began);
          assert.strictEqual(replies.receipts.length, submitted);
          yield* fresh.reserve(Input.capacity);
          for (let index = 0; index < Input.capacity; index++)
            yield* fresh.send(() => replies.issue("key"));

          const overflow = yield* fresh
            .reserve(1)
            .pipe(Effect.andThen(fresh.send(() => replies.issue("key"))), Effect.forkScoped);

          yield* Effect.yieldNow;
          assert.strictEqual(replies.receipts.length, submitted + Input.capacity);
          replies.settle(submitted);
          yield* Fiber.join(overflow);
          assert.strictEqual(replies.outstanding(), Input.capacity);
          replies.settleAll();
          yield* fresh.drain;
          yield* fresh.close;
        }).pipe(Effect.scoped),
      ),
  );

  it.effect("cannot dispatch a queued motion after its admission was interrupted", () =>
    TestCdp.withCdp(
      Effect.gen(function* () {
        const replies = yield* heldReplies;
        const input = Input.make();
        const run = yield* input.begin;

        yield* run.reserve(Input.capacity);
        for (let index = 0; index < Input.capacity; index++)
          yield* run.send(() => replies.issue("key"));
        yield* run.reserveMotion(maximumSamples);
        for (let index = 0; index < maximumSamples; index++) yield* run.send(() => replies.issue());
        const before = replies.receipts.length;

        const waiting = yield* run
          .reserveMotion(1)
          .pipe(
            Effect.andThen(run.send(() => replies.issue())),
            Effect.ensuring(run.close),
            Effect.forkScoped,
          );

        yield* Effect.yieldNow;
        yield* Fiber.interrupt(waiting);
        replies.settleAll();
        const fresh = yield* input.begin;

        assert.strictEqual(replies.receipts.length, before);
        yield* fresh.reserve(1);
        yield* fresh.send(() => replies.issue("key"));
        assert.strictEqual(replies.receipts.length, before + 1);
        replies.settleAll();
        yield* fresh.drain;
        yield* fresh.close;
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("rejects invalid reservations before consuming capacity or dispatching input", () =>
    TestCdp.withCdp(
      Effect.gen(function* () {
        const replies = yield* heldReplies;
        const run = yield* Input.make().begin;

        for (const count of [0, -1, 1.5, Number.NaN, Infinity, Input.capacity + 1]) {
          const exit = yield* Effect.exit(run.reserve(count));

          assert.isTrue(Exit.isFailure(exit));
        }
        for (const count of [0, -1, 1.5, Number.NaN, Infinity, maximumSamples + 1]) {
          const exit = yield* Effect.exit(run.reserveMotion(count));

          assert.isTrue(Exit.isFailure(exit));
        }
        assert.strictEqual(replies.receipts.length, 0);
        yield* run.reserve(Input.capacity);
        for (let index = 0; index < Input.capacity; index++)
          yield* run.send(() => replies.issue("key"));
        assert.strictEqual(replies.receipts.length, Input.capacity);
        replies.settleAll();
        yield* run.drain;
        yield* run.close;
      }).pipe(Effect.scoped),
    ),
  );
});

/**
 * A lane's run as a model: random tickets ask and leave, and after each step the lane must keep
 * its rules. `live` holds the tickets that asked and have not left, and whether each holds it.
 */
const runLane = (choices: ReadonlyArray<number>) => {
  let state = Lane.initial;
  let asked = 0;
  let writes = 0;
  let newest = 0;
  const live = new Map<number, { readonly ticket: Lane.Ticket; holding: boolean }>();

  const apply = (input: Lane.Input) => {
    const next = Lane.step(state, input);

    state = next.state;
    if (input._tag === "Leave") live.delete(input.ticket.id);
    else {
      live.set(input.ticket.id, { ticket: input.ticket, holding: false });
      if (input.ticket.kind === "write") writes += 1;
    }
    for (const ticket of next.admitted) {
      const entry = live.get(ticket.id);

      assert.isFalse(entry?.holding ?? true, `ticket ${ticket.id} waited, and goes in once`);
      // In the order asked: no read passes a write asked before it, and writes keep their order.
      assert.isAbove(ticket.id, newest, `ticket ${ticket.id} goes in after ${newest}`);
      newest = ticket.id;
      if (entry !== undefined) entry.holding = true;
    }

    const entries = [...live.values()];
    const holding = entries.filter((entry) => entry.holding);
    const writing = holding.filter((entry) => entry.ticket.kind === "write").length;

    // A write holds the lane alone, and reads hold it together.
    assert.isTrue(writing === 0 || holding.length === 1, "a write holds the lane alone");
    assert.deepStrictEqual(
      state.turn,
      holding.length === 0
        ? { _tag: "Free" }
        : writing === 1
          ? { _tag: "Writing" }
          : { _tag: "Reading", count: holding.length },
    );
    assert.deepStrictEqual(
      state.queue.map((ticket) => ticket.id),
      entries.filter((entry) => !entry.holding).map((entry) => entry.ticket.id),
    );
    // The first in the queue waits only for what excludes it: a write for anyone, a read for a write.
    if (state.queue[0] !== undefined)
      assert.isAbove(
        state.queue[0].kind === "write" ? holding.length : writing,
        0,
        "a wait has a cause",
      );
    assert.strictEqual(state.epoch, writes);
    state.queue.forEach((ticket, index) =>
      assert.strictEqual(Lane.ahead(state, ticket.id), holding.length + index),
    );
    for (const kind of ["read", "write"] as const)
      assert.strictEqual(
        Lane.admitsNow(state, kind),
        Lane.step(state, { _tag: "Ask", ticket: { id: asked + 1, kind } }).admitted.length > 0,
      );
  };

  for (const choice of choices) {
    const entries = [...live.values()];
    const leaving = entries[Math.floor(choice / 3) % Math.max(1, entries.length)];

    if (choice % 3 === 2 && leaving !== undefined) apply({ _tag: "Leave", ticket: leaving.ticket });
    else apply({ _tag: "Ask", ticket: { id: ++asked, kind: choice % 3 === 0 ? "read" : "write" } });
  }
  // However its tickets leave, holding or waiting, the lane comes free with no one waiting.
  for (const [, { ticket }] of live) apply({ _tag: "Leave", ticket });
  assert.deepStrictEqual(state, { turn: { _tag: "Free" }, queue: [], epoch: writes });
};

describe("A page's lane", () => {
  it.prop(
    "keeps its rules through any run of reads and writes asking and leaving",
    {
      choices: Arbitrary.array(
        Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1000 }))),
        { minLength: 20, maxLength: 200 },
      ),
    },
    ({ choices }) => runLane(choices),
    { arbitrary: { runs: 1000, size: 200 } },
  );
});

// A lane on the test's clock, as a page's is on its browser's: a test on the test clock measures
// its waits exactly.
const laneOf = Effect.gen(function* () {
  const scope = yield* Effect.scope;
  const clock = yield* Clock.Clock;

  return Lane.make({
    now: () => Number(clock.monotonicTimeNanosUnsafe()) / 1e6,
    actionTimeout: Duration.seconds(5),
    documentAt: () => 0,
    gone: (operation) =>
      new BrowserError({ operation, reason: new Closed({ cause: "page" }), dispatched: false }),
    scope,
  });
});

/** Reads the test answers, each in the order it began. */
const answered = () => {
  const begun: Array<Deferred.Deferred<string>> = [];

  return {
    begun,
    read: Effect.suspend(() => {
      const answer = Deferred.makeUnsafe<string>();

      begun.push(answer);

      return Deferred.await(answer);
    }),
    answer: (index: number, value: string) => {
      const answer = begun[index];

      if (answer !== undefined) Deferred.doneUnsafe(answer, Exit.succeed(value));
    },
  };
};

const settle = Effect.sleep("20 millis");

describe("Shared reads", () => {
  it.effect("expires an abandoned completed read after 250 milliseconds on its owner's clock", () =>
    Effect.gen(function* () {
      let millis = 0;
      const scope = yield* Effect.scope;

      const lane = Lane.make({
        now: () => millis,
        actionTimeout: Duration.seconds(5),
        documentAt: () => 0,
        gone: (operation) =>
          new BrowserError({ operation, reason: new Closed({ cause: "page" }), dispatched: false }),
        scope,
      });

      const began = Deferred.makeUnsafe<void>();
      const release = Deferred.makeUnsafe<void>();
      const finished = Deferred.makeUnsafe<void>();
      const snapshot = lane.shared<string>("snapshot", true);

      const first = yield* snapshot(
        "outline",
        Deferred.succeed(began, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(Deferred.succeed(finished, undefined)),
          Effect.as("old"),
        ),
      ).pipe(Effect.forkChild);

      yield* Deferred.await(began);
      yield* Fiber.interrupt(first);
      yield* Deferred.succeed(release, undefined);
      yield* Deferred.await(finished);
      yield* Effect.yieldNow;
      millis = 251;
      assert.strictEqual(yield* snapshot("outline", Effect.succeed("fresh")), "fresh");
    }).pipe(Effect.scoped),
  );

  it.live("an identical read asked while one is in flight joins it", () =>
    TestCdp.withCdp(
      Effect.gen(function* () {
        const snapshot = (yield* laneOf).shared<string>("snapshot", true);
        const { begun, read, answer } = answered();
        const first = yield* snapshot("outline", read).pipe(Effect.forkChild);
        const second = yield* snapshot("outline", read).pipe(Effect.forkChild);

        yield* settle;
        assert.strictEqual(begun.length, 1);
        answer(0, "the page");
        assert.deepStrictEqual(
          [yield* Fiber.join(first), yield* Fiber.join(second)],
          ["the page", "the page"],
        );
      }).pipe(Effect.scoped),
    ),
  );

  it.live(
    "a read its callers gave up serves the next caller in its epoch, once, and none after a write",
    () =>
      TestCdp.withCdp(
        Effect.gen(function* () {
          const lane = yield* laneOf;
          const snapshot = lane.shared<string>("snapshot", true);
          const { begun, read, answer } = answered();

          const abandoned = snapshot("outline", read).pipe(
            Effect.timeout("5 millis"),
            Effect.ignore,
          );

          yield* abandoned;
          answer(0, "kept");
          yield* settle;
          assert.strictEqual(yield* snapshot("outline", read), "kept");
          assert.strictEqual(begun.length, 1);

          const again = yield* snapshot("outline", read).pipe(Effect.forkChild);

          yield* settle;
          answer(1, "read again");
          assert.strictEqual(yield* Fiber.join(again), "read again");

          yield* abandoned;
          answer(2, "before the click");
          yield* settle;
          yield* lane.write("click", Duration.seconds(1))(Effect.void);
          const after = yield* snapshot("outline", read).pipe(Effect.forkChild);

          yield* settle;
          answer(3, "after the click");
          assert.strictEqual(yield* Fiber.join(after), "after the click");
        }).pipe(Effect.scoped),
      ),
  );

  it.effect("a write stops a read nobody awaits, rather than wait for it", () =>
    Effect.gen(function* () {
      const lane = yield* laneOf;
      const entered = yield* Deferred.make<void>();

      const abandoned = yield* lane
        .shared<string>("snapshot", true)(
          "outline",
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        )
        .pipe(Effect.forkChild);

      yield* Deferred.await(entered);
      yield* Fiber.interrupt(abandoned);
      assert.strictEqual(
        yield* lane.write("click", Duration.seconds(1))(Effect.succeed("written")),
        "written",
      );
    }).pipe(Effect.scoped),
  );

  // On the test clock, the wait ends at its bound to the millisecond, however loaded the machine.
  it.effect("a turn not given in time fails Busy, and at once when asked to fail fast", () =>
    TestCdp.withCdp(
      Effect.gen(function* () {
        const lane = yield* laneOf;
        const held = yield* Deferred.make<void>();

        const writing = yield* lane
          .write(
            "click",
            Duration.seconds(1),
          )(Deferred.await(held))
          .pipe(Effect.forkChild);

        yield* Effect.yieldNow;

        const pressing = yield* Effect.flip(
          lane.write("press", Duration.millis(50))(Effect.void),
        ).pipe(Effect.forkChild);

        yield* Effect.yieldNow;
        yield* TestClock.adjust("49 millis");
        assert.isUndefined(pressing.pollUnsafe());
        yield* TestClock.adjust("1 millis");
        const waited = yield* Fiber.join(pressing);
        const fast = yield* Effect.flip(failFast(lane.read("snapshot")(Effect.void)));

        for (const [error, millis] of [
          [waited, 50],
          [fast, 0],
        ] as const) {
          assert.strictEqual(error.reason._tag, "Busy");
          if (error.reason._tag === "Busy") {
            assert.strictEqual(error.reason.waitedMillis, millis);
            assert.strictEqual(error.reason.ahead, 1);
          }
          assert.deepStrictEqual(consequence(error), { lost: "nothing", repeat: "safe" });
        }
        yield* Deferred.succeed(held, undefined);
        yield* Fiber.join(writing);
      }).pipe(Effect.scoped),
    ),
  );
});

const browserWith = Effect.fnUntraced(function* (options: Options) {
  const native = TestCdp.nativeContext(yield* Browser).browser();

  if (native === null) return yield* Effect.die("the fixture requires local Chromium");

  const context = yield* Effect.acquireRelease(
    Effect.promise(() => native.newContext({ viewport: { width: 800, height: 600 } })),
    (context) => Effect.promise(() => context.close()),
  );

  const faults = yield* TestCdp.make();
  const gate = yield* Deferred.make<void>();

  yield* Effect.addFinalizer(() => Deferred.succeed(gate, undefined));

  const browser = yield* faults.provide(
    makeBrowser(context, { id: "admission", provider: "test" }, options),
  );

  return {
    browser,
    faults,
    stall: (page: Page) =>
      faults.rule(
        { page: page.id, method: { prefix: "Input." } },
        { _tag: "Hold", gate },
        { phase: "after" },
      ),
  };
});

const blank = "data:text/html,<title>Blank</title><input aria-label=Text>";

layer(TestCdp.provideLayer(Chromium.layer()), { excludeTestServices: true })(
  "Admission across pages",
  (it) => {
    it.effect("waits for a page's own unresolved replies without holding other pages", () =>
      TestCdp.withCdp(
        Effect.gen(function* () {
          const { browser, faults, stall } = yield* browserWith({ actionTimeout: "2 seconds" });
          const stalled = yield* browser.newPage(blank);
          const other = yield* browser.newPage(blank);

          stall(stalled);

          const initial = yield* stalled
            .click({ x: 10, y: 10 })
            .pipe(Effect.exit, Effect.forkChild);

          yield* faults.waitUntil((calls) =>
            calls.some(
              (call) =>
                call.session.page === stalled.id && call.method === "Input.dispatchMouseEvent",
            ),
          );
          yield* TestClock.adjust("2 seconds");
          assert.isTrue(Exit.isFailure(yield* Fiber.join(initial)));
          const retry = yield* stalled.click({ x: 10, y: 10 }).pipe(Effect.flip, Effect.forkChild);

          yield* other.click({ x: 10, y: 10 });
          assert.isUndefined(
            retry.pollUnsafe(),
            "the other page finishes while this page's replies remain held",
          );
          yield* TestClock.adjust("2 seconds");
          const error = yield* Fiber.join(retry);

          assert.deepStrictEqual([error.reason._tag, error.dispatched], ["Timeout", false]);
        }).pipe(Effect.provide(TestClock.layer())),
      ),
    );

    it.effect(
      "queues input behind its own page's navigation, failing Busy, without holding other pages",
      () =>
        TestCdp.withCdp(
          Effect.gen(function* () {
            const { browser, faults } = yield* browserWith({ actionTimeout: "2 seconds" });
            const navigating = yield* browser.newPage(blank);
            const other = yield* browser.newPage(blank);
            const released = yield* Deferred.make<void>();

            yield* Effect.addFinalizer(() => Deferred.succeed(released, undefined));
            faults.rule(
              { page: navigating.id, method: "goto" },
              { _tag: "Hold", gate: released },
              { times: 1 },
            );
            const before = faults.calls.length;

            const navigation = yield* navigating
              .goto("data:text/html,<title>Navigated</title>")
              .pipe(Effect.forkChild);

            yield* faults.waitUntil((calls) =>
              calls
                .slice(before)
                .some((call) => call.session.page === navigating.id && call.method === "goto"),
            );

            const queued = yield* navigating
              .click({ x: 5, y: 5 })
              .pipe(Effect.flip, Effect.forkChild);

            const fast = yield* Effect.flip(failFast(navigating.snapshot()));

            assert.deepStrictEqual([fast.reason._tag, fast.dispatched], ["Busy", false]);
            yield* other.click({ x: 5, y: 5 });
            assert.isUndefined(navigation.pollUnsafe());
            assert.isUndefined(queued.pollUnsafe());
            yield* TestClock.adjust("1999 millis");
            assert.isUndefined(queued.pollUnsafe());
            yield* TestClock.adjust("1 millis");
            const error = yield* Fiber.join(queued);

            assert.deepStrictEqual([error.reason._tag, error.dispatched], ["Busy", false]);
            if (error.reason._tag === "Busy") {
              assert.strictEqual(error.reason.waitedMillis, 2000);
              assert.strictEqual(error.reason.ahead, 1);
            }
            yield* Deferred.succeed(released, undefined);
            yield* Fiber.join(navigation);
          }).pipe(Effect.provide(TestClock.layer())),
        ),
    );

    it.effect("navigates while another page holds input", () =>
      TestCdp.withCdp(
        Effect.gen(function* () {
          const { browser, faults } = yield* browserWith({ actionTimeout: "5 seconds" });
          const holding = yield* browser.newPage(blank);
          const other = yield* browser.newPage(blank);
          const released = yield* Deferred.make<void>();

          yield* Effect.addFinalizer(() => Deferred.succeed(released, undefined));
          faults.rule(
            { page: holding.id, method: "keyboard.down" },
            { _tag: "Hold", gate: released },
            { phase: "after", times: 1 },
          );
          const held = yield* holding.press("Shift").pipe(Effect.forkChild);

          yield* faults.waitUntil((calls) =>
            calls.some(
              (call) => call.session.page === holding.id && call.method === "keyboard.down",
            ),
          );
          yield* other.goto("data:text/html,<title>Navigated</title>");
          assert.strictEqual(yield* other.title, "Navigated");
          assert.isUndefined(
            held.pollUnsafe(),
            "navigation finishes before the held key acknowledgement",
          );
          yield* Deferred.succeed(released, undefined);
          yield* Fiber.join(held);
        }).pipe(Effect.provide(TestClock.layer())),
      ),
    );

    // Release review M2: performed input once held every page's lane for about nine seconds.
    it.effect("never holds a click on one page behind performed typing on another", () =>
      TestCdp.withCdp(
        Effect.gen(function* () {
          const { browser, faults } = yield* browserWith({});
          const typing = yield* browser.newPage(blank);
          const other = yield* browser.newPage(blank);
          const released = yield* Deferred.make<void>();

          const style: Style.Style = {
            ...Style.plain,
            shown: true,
            typing: (text) =>
              Effect.succeed(
                [...text].flatMap((key, index): ReadonlyArray<Style.TypingEvent> => [
                  { key, phase: "down", afterMillis: index === 0 ? 0 : 200 + index * 160 },
                  { key, phase: "up", afterMillis: index === 0 ? 100 : 300 + index * 160 },
                ]),
              ),
          };

          yield* Effect.addFinalizer(() => Deferred.succeed(released, undefined));
          faults.rule(
            { page: typing.id, method: "Input.dispatchKeyEvent" },
            { _tag: "Hold", gate: released },
            { phase: "after", times: 1 },
          );
          yield* Effect.promise(() => TestCdp.nativePage(typing).locator("input").focus());

          const typed = yield* typing
            .type("x".repeat(58))
            .pipe(Style.provide(style), Effect.forkChild);

          yield* faults
            .waitUntil((calls) =>
              calls.some(
                (call) =>
                  call.session.page === typing.id && call.method === "Input.dispatchKeyEvent",
              ),
            )
            .pipe(Effect.raceFirst(Fiber.join(typed)));
          yield* other.click({ x: 10, y: 10 });
          assert.isUndefined(
            typed.pollUnsafe(),
            "the click finishes while the typing schedule and key receipt remain pending",
          );
          yield* Deferred.succeed(released, undefined);
          yield* Fiber.interrupt(typed);
        }).pipe(Effect.provide(TestClock.layer())),
      ),
    );

    it.effect("keeps a browser within maxPages, waiting for a page to close or failing Limit", () =>
      TestCdp.withCdp(
        Effect.gen(function* () {
          const { browser } = yield* browserWith({ maxPages: 2, actionTimeout: "500 millis" });
          const first = yield* browser.newPage(blank);

          yield* browser.newPage(blank);
          const refused = yield* Effect.flip(browser.newPage(blank)).pipe(Effect.forkChild);

          yield* TestClock.adjust("499 millis");
          assert.isUndefined(refused.pollUnsafe());
          yield* TestClock.adjust("1 millis");
          assert.strictEqual((yield* Fiber.join(refused)).reason._tag, "Limit");
          assert.strictEqual(
            (yield* Effect.flip(failFast(browser.newPage(blank)))).reason._tag,
            "Limit",
          );
          const waiting = yield* browser.newPage(blank).pipe(Effect.forkChild);

          yield* Effect.yieldNow;
          assert.isUndefined(waiting.pollUnsafe());
          yield* first.close;
          yield* Fiber.join(waiting);
          assert.strictEqual((yield* browser.pages).length, 2);
        }).pipe(Effect.provide(TestClock.layer())),
      ),
    );

    it.effect("reads the native title while a page-script reply is held", () =>
      TestCdp.withCdp(
        Effect.gen(function* () {
          const { browser, faults } = yield* browserWith({ actionTimeout: "5 seconds" });
          const page = yield* browser.newPage(blank);
          const released = yield* Deferred.make<void>();

          yield* Effect.addFinalizer(() => Deferred.succeed(released, undefined));
          faults.rule(
            { page: page.id, method: "Runtime.evaluate" },
            { _tag: "Hold", gate: released },
            { times: 1 },
          );
          const before = faults.calls.length;
          const reading = yield* page.snapshot().pipe(Effect.forkChild);

          yield* faults.waitUntil((calls) =>
            calls
              .slice(before)
              .some((call) => call.session.page === page.id && call.method === "Runtime.evaluate"),
          );
          assert.strictEqual(yield* page.title, "Blank");
          assert.isUndefined(reading.pollUnsafe());
          yield* Deferred.succeed(released, undefined);
          yield* Fiber.join(reading);
        }).pipe(Effect.provide(TestClock.layer())),
      ),
    );
  },
);
