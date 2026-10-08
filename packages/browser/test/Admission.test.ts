import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { assert, describe, it, layer } from "@effect/vitest";
import {
  Arbitrary,
  Clock,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Schedule,
  Schema,
} from "effect";
import { TestClock } from "effect/testing";
import type { CDPSession } from "playwright-core";

import { Browser, make as makeBrowser, type Options } from "../src/Browser.ts";
import { BrowserError, Closed, consequence } from "../src/BrowserError.ts";
import * as Chromium from "../src/Chromium.ts";
import * as Input from "../src/internal/input/replies.ts";
import * as Lane from "../src/internal/page/lane.ts";
import { maximumSamples } from "../src/Motion.ts";
import { failFast, type Page } from "../src/Page.ts";
import * as Presentation from "../src/Presentation.ts";

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
  );

  it.effect(
    "admits a complete maximum motion while keeping a strict combined bound and ordinary input separate",
    () =>
      Effect.gen(function* () {
        const replies = yield* heldReplies;
        const run = yield* Input.make().begin;
        const limit = Input.capacity + maximumSamples;

        yield* run.reserve(Input.capacity);
        for (let index = 0; index < Input.capacity; index++)
          yield* run.send(() => replies.issue("key"));
        yield* run.reserveMotion(maximumSamples);
        for (let index = 0; index < maximumSamples; index++) yield* run.send(() => replies.issue());
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
  );

  it.effect(
    "stops new dispatch after a failed motion receipt without abandoning the other replies",
    () =>
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
  );

  it.effect(
    "releases a held button once after an interrupted motion and retains every submitted reply across runs",
    () =>
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
  );

  it.effect("cannot dispatch a queued motion after its admission was interrupted", () =>
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
  );

  it.effect("rejects invalid reservations before consuming capacity or dispatching input", () =>
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

const elapsed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const started = performance.now();
    const exit = yield* Effect.exit(effect);

    return { exit, millis: performance.now() - started };
  });

describe("Shared reads", () => {
  it.live("an identical read asked while one is in flight joins it", () =>
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
  );

  it.live(
    "a read its callers gave up serves the next caller in its epoch, once, and none after a write",
    () =>
      Effect.gen(function* () {
        const lane = yield* laneOf;
        const snapshot = lane.shared<string>("snapshot", true);
        const { begun, read, answer } = answered();
        const abandoned = snapshot("outline", read).pipe(Effect.timeout("5 millis"), Effect.ignore);

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
  );

  it.live("a write stops a read nobody awaits, rather than wait for it", () =>
    Effect.gen(function* () {
      const lane = yield* laneOf;

      yield* lane
        .shared<string>("snapshot", true)("outline", Effect.never)
        .pipe(Effect.timeout("5 millis"), Effect.ignore);

      const { exit, millis } = yield* elapsed(
        lane.write("click", Duration.seconds(1))(Effect.void),
      );

      assert.isTrue(Exit.isSuccess(exit));
      assert.isBelow(millis, 500);
    }).pipe(Effect.scoped),
  );

  // On the test clock, the wait ends at its bound to the millisecond, however loaded the machine.
  it.effect("a turn not given in time fails Busy, and at once when asked to fail fast", () =>
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
  );
});

const browserWith = Effect.fnUntraced(function* (options: Options) {
  const native = (yield* Browser).context.browser();

  if (native === null) return yield* Effect.die("the fixture requires local Chromium");

  const context = yield* Effect.acquireRelease(
    Effect.promise(() => native.newContext({ viewport: { width: 800, height: 600 } })),
    (context) => Effect.promise(() => context.close()),
  );

  const createSession = context.newCDPSession.bind(context);
  const gate = Promise.withResolvers<void>();
  let stalled: unknown;
  let blind: unknown;

  // Input replies for one page can be withheld after Chromium runs the input, as a stalled
  // renderer or transport would, and another page can fail its pictures.
  context.newCDPSession = async (target) => {
    const cdp = await createSession(target);
    const send = cdp.send.bind(cdp);

    const observed: CDPSession["send"] = (method, params) =>
      target === stalled && method.startsWith("Input.")
        ? send(method, params).then((value) => gate.promise.then(() => value))
        : target === blind && method === "Page.captureScreenshot"
          ? Promise.reject(new Error("this page takes no pictures"))
          : send(method, params);

    cdp.send = observed;

    return cdp;
  };
  yield* Effect.addFinalizer(() => Effect.sync(() => gate.resolve()));

  const browser = yield* makeBrowser(context, { id: "admission", provider: "test" }, options);

  return {
    browser,
    stall: (page: Page) => {
      stalled = page.playwright;
    },
    blind: (page: Page) => {
      blind = page.playwright;
    },
  };
});

const blank = "data:text/html,<title>Blank</title><input aria-label=Text>";

// A site whose `/slow` document answers after three seconds, as a slow server does.
const slowSite = Effect.acquireRelease(
  Effect.callback<ReturnType<typeof createServer>>((resume) => {
    const server = createServer((request, response) => {
      const reply = () => {
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<title>Done</title><body style='margin:0'>done</body>");
      };

      if (request.url === "/slow") setTimeout(reply, 3000);
      else reply();
    });

    server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
  }),
  (server) =>
    Effect.callback<void>((resume) => {
      server.closeAllConnections();
      server.close(() => resume(Effect.void));
    }),
).pipe(
  Effect.map((server) => (path: string) => {
    const { port } = server.address() as AddressInfo;

    return `http://127.0.0.1:${port}${path}`;
  }),
);

/** Wait until the browser has published a key, as typing under way does. */
const keysUnderWay = (browser: Browser["Service"]) =>
  browser.recentEvents.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("10 millis"),
      until: (events) => events.some((event) => event._tag === "KeyChanged"),
    }),
  );

layer(Chromium.layer(), { excludeTestServices: true, timeout: Duration.seconds(60) })(
  "Admission across pages",
  (it) => {
    // A page that does not answer its input fails as slow, `Timeout`: it is not a wait in a queue.
    it.effect("waits for a page's own unresolved replies without holding other pages", () =>
      Effect.gen(function* () {
        const { browser, stall } = yield* browserWith({ actionTimeout: Duration.seconds(2) });
        const stalled = yield* browser.newPage(blank);
        const other = yield* browser.newPage(blank);

        stall(stalled);
        yield* stalled.click({ x: 10, y: 10 }).pipe(Effect.exit);
        const retry = yield* stalled.click({ x: 10, y: 10 }).pipe(Effect.flip, Effect.forkChild);

        yield* Effect.sleep("50 millis");
        const { exit, millis } = yield* elapsed(other.click({ x: 10, y: 10 }));
        const error = yield* Fiber.join(retry);

        assert.isTrue(Exit.isSuccess(exit));
        assert.isBelow(millis, 1000);
        assert.strictEqual(error.reason._tag, "Timeout");
        assert.isFalse(error.dispatched);
      }),
    );

    it.effect(
      "queues input behind its own page's navigation, failing Busy, without holding other pages",
      () =>
        Effect.gen(function* () {
          const url = yield* slowSite;
          const { browser } = yield* browserWith({ actionTimeout: Duration.seconds(2) });
          const navigating = yield* browser.newPage(url("/fast"));
          const other = yield* browser.newPage(url("/fast"));

          yield* navigating.click({ x: 5, y: 5 });
          yield* other.click({ x: 5, y: 5 });
          const navigation = yield* navigating.goto(url("/slow")).pipe(Effect.forkChild);

          yield* Effect.sleep("200 millis");

          // This click waits for its own page's navigation, and only for its own deadline, and a
          // read asked to fail fast does not wait at all.
          const queued = yield* navigating
            .click({ x: 5, y: 5 })
            .pipe(Effect.flip, Effect.forkChild);

          const fast = yield* elapsed(Effect.flip(failFast(navigating.snapshot())));

          yield* Effect.sleep("200 millis");
          const { exit, millis } = yield* elapsed(other.click({ x: 5, y: 5 }));
          const error = yield* Fiber.join(queued);

          assert.isTrue(Exit.isSuccess(exit));
          assert.isBelow(millis, 1000);
          assert.deepStrictEqual([error.reason._tag, error.dispatched], ["Busy", false]);
          if (error.reason._tag === "Busy") {
            assert.isAtLeast(error.reason.waitedMillis, 1900);
            assert.strictEqual(error.reason.ahead, 1);
          }
          assert.isBelow(fast.millis, 200);
          assert.isTrue(Exit.isSuccess(fast.exit) && fast.exit.value.reason._tag === "Busy");
          yield* Fiber.join(navigation);
        }),
    );

    it.effect("navigates while another page holds input", () =>
      Effect.gen(function* () {
        const { browser } = yield* browserWith({ actionTimeout: Duration.seconds(5) });
        const holding = yield* browser.newPage(blank);
        const other = yield* browser.newPage(blank);
        const held = yield* holding.press("Shift", { holdMillis: 3000 }).pipe(Effect.forkChild);

        yield* browser.recentEvents.pipe(
          Effect.repeat({
            schedule: Schedule.spaced("10 millis"),
            until: (events) => events.some((event) => event._tag === "KeyChanged"),
          }),
        );

        const { exit, millis } = yield* elapsed(
          other.goto("data:text/html,<title>Navigated</title>"),
        );

        assert.isTrue(Exit.isSuccess(exit));
        assert.isBelow(millis, 1500);
        assert.strictEqual(yield* other.title, "Navigated");
        yield* Fiber.join(held);
      }),
    );

    // Release review M2: a 58-character query typed at a person's pace on a background page held an
    // on-air click on another page for about 9.5 s; 100 characters made it fail undispatched at 10 s.
    it.effect("never holds a click on one page behind performed typing on another", () =>
      Effect.gen(function* () {
        const { browser } = yield* browserWith({});
        const typing = yield* browser.newPage(blank);
        const other = yield* browser.newPage(blank);
        const presenter = yield* Presentation.make();

        yield* Effect.promise(() => typing.playwright.locator("input").focus());
        const typed = yield* presenter.view(typing).type("x".repeat(58)).pipe(Effect.forkChild);

        yield* keysUnderWay(browser);
        const { exit, millis } = yield* elapsed(other.click({ x: 10, y: 10 }));

        // The click waits for no part of the typing's 9 s, which the lock made it wait out.
        assert.isTrue(Exit.isSuccess(exit));
        assert.isUndefined(typed.pollUnsafe(), "the typing goes on");
        assert.isBelow(millis, 6000);
        yield* Fiber.interrupt(typed);
      }),
    );

    it.effect("keeps a browser within maxPages, waiting for a page to close or failing Limit", () =>
      Effect.gen(function* () {
        const { browser } = yield* browserWith({ maxPages: 2, actionTimeout: "500 millis" });
        const first = yield* browser.newPage(blank);

        yield* browser.newPage(blank);
        const refused = yield* elapsed(Effect.flip(browser.newPage(blank)));
        const fast = yield* elapsed(Effect.flip(failFast(browser.newPage(blank))));

        for (const [{ exit, millis }, least, most] of [
          [refused, 450, 2000],
          [fast, 0, 200],
        ] as const) {
          assert.isTrue(Exit.isSuccess(exit) && exit.value.reason._tag === "Limit");
          assert.isAtLeast(millis, least);
          assert.isBelow(millis, most);
        }

        const waiting = yield* browser.newPage(blank).pipe(Effect.forkChild);

        yield* Effect.sleep("100 millis");
        yield* first.close;
        yield* Fiber.join(waiting);
        assert.strictEqual((yield* browser.pages).length, 2);
      }),
    );

    it.effect("observes what it can, and says why the rest is missing", () =>
      Effect.gen(function* () {
        const { browser, blind } = yield* browserWith({});
        const page = yield* browser.newPage(blank);

        blind(page);
        const observed = yield* page.observe();

        assert.include(observed.snapshot?.text ?? "", "Text");
        assert.isUndefined(observed.image);
        assert.deepStrictEqual(
          observed.missing.map((error) => error.operation),
          ["screenshot"],
        );
        // Nothing asked for could be read, so the observation fails.
        const error = yield* Effect.flip(page.observe({ mode: "screenshot" }));

        assert.strictEqual(error.operation, "screenshot");
      }),
    );

    // A renderer busy with its own script answers nothing; `title` waited for it, without bound.
    it.effect("bounds a title read by the action timeout", () =>
      Effect.gen(function* () {
        const { browser } = yield* browserWith({ actionTimeout: "500 millis" });
        const page = yield* browser.newPage(blank);

        yield* Effect.promise(() =>
          page.playwright.evaluate(() => {
            setTimeout(() => {
              const until = Date.now() + 3000;

              while (Date.now() < until);
            }, 0);
          }),
        );
        const { exit, millis } = yield* elapsed(Effect.flip(page.title));

        assert.isTrue(Exit.isSuccess(exit) && exit.value.reason._tag === "Timeout");
        assert.isBelow(millis, 2000);
      }),
    );
  },
);
