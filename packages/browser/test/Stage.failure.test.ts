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
  Schedule,
  Schema,
  Scope,
  Stream,
} from "effect";
import type { CDPSession } from "playwright-core";

import { Browser, make as makeBrowser } from "../src/Browser.ts";
import { BrowserError, Closed } from "../src/BrowserError.ts";
import * as Chromium from "../src/Chromium.ts";
import { Frame, Screenshot } from "../src/Frame.ts";
import type { Page } from "../src/Page.ts";
import * as Stage from "../src/Stage.ts";

const scripted = Effect.fnUntraced(function* (
  id: string,
  releasing: Effect.Effect<void> = Effect.void,
) {
  const clock = yield* Clock.Clock;
  const queue = yield* Queue.unbounded<Frame | BrowserError, Cause.Done>();
  const stopped = yield* Deferred.make<void>();
  let released = false;

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

  // Stage's custom-page path uses only these members; it must never infer Still for this page.
  const page = { id, playwright: { isClosed: () => false }, screencast: () => source } as Page;

  const paint = Effect.suspend(() => {
    const at = Number(clock.monotonicTimeNanosUnsafe()) / 1e6;

    return Queue.offer(
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
  });

  return {
    page,
    paint,
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

it.live("a prepared frame cannot hide its capture's terminal failure or completion", () =>
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

      assert.strictEqual(ready.reason._tag, "Closed");
      const commit = yield* cue.commit().pipe(Effect.flip);

      assert.strictEqual(commit.reason._tag, "Closed");
      assert.isTrue(Option.isNone(yield* stage.current));
    }).pipe(Effect.scoped),
  ),
);

it.live("caller interruption after a switch waits for the outgoing capture to close", () =>
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
);

it.live(
  "queued commits keep their turn ahead of a new caller, and cancellation removes a turn",
  () =>
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

          assert.isAtLeast(presented.latency, 20, "default latency includes the wait for its turn");
        }
        yield* Effect.yieldNow;
        assert.deepStrictEqual(order, cancel ? ["A", "C"] : ["A", "B", "C"]);
        assert.strictEqual(Option.getOrThrow(yield* stage.current).id, "C");
      }).pipe(Effect.scoped),
    ),
);

it.live("continuous paint resets the silence deadline", () =>
  Effect.gen(function* () {
    const fixture = yield* scripted("painting");
    const stage = yield* Stage.make();
    const seen: Array<Stage.Shown> = [];

    yield* stage.shown({ hold: "80 millis" }).pipe(
      Stream.runForEach((value) =>
        Effect.sync(() => {
          seen.push(value);
        }),
      ),
      Effect.forkScoped,
    );
    const cue = yield* stage.cue(fixture.page);

    yield* fixture.paint;
    yield* cue.commit();
    yield* fixture.paint.pipe(
      Effect.repeat({ schedule: Schedule.spaced("10 millis") }),
      Effect.forkScoped,
    );
    yield* Effect.sleep("250 millis");
    assert.isAtLeast(seen.filter((value) => value._tag === "Painted").length, 10);
    assert.isTrue(seen.every((value) => value._tag === "Painted"));
  }),
);

it.live("closing a cue wakes a commit waiting for a future event", () =>
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

    assert.strictEqual(error.reason._tag, "Closed");
    assert.isTrue(Option.isNone(yield* stage.current));
  }),
);

it.live("a capture that reports connection loss emits Gone without a page-close event", () =>
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
);

layer(Chromium.layer(), { excludeTestServices: true })("stage input drain failure", (it) => {
  it.effect("keeps later old-page input behind the cut while awaiting a new document's paint", () =>
    Effect.gen(function* () {
      const native = (yield* Browser).context.browser();

      if (native === null) return yield* Effect.die("local Chromium is required");

      const context = yield* Effect.acquireRelease(
        Effect.promise(() => native.newContext()),
        (context) => Effect.promise(() => context.close()),
      );

      const create = context.newCDPSession.bind(context);
      let hidden: unknown;
      let withholding = false;

      context.newCDPSession = async (target) => {
        const cdp = await create(target);

        const emitter = cdp as CDPSession & {
          emit(event: string, ...args: ReadonlyArray<unknown>): boolean;
        };

        const emit = emitter.emit.bind(emitter);

        emitter.emit = (event, ...args) => {
          if (withholding && target === hidden && event === "Page.screencastFrame") {
            void cdp
              .send("Page.screencastFrameAck", {
                sessionId: (args[0] as { sessionId: number }).sessionId,
              })
              .catch(() => undefined);

            return true;
          }

          return emit(event, ...args);
        };

        return cdp;
      };

      const browser = yield* makeBrowser(
        context,
        { id: "cut", provider: "local" },
        { actionTimeout: "2 seconds" },
      );

      const first = yield* browser.newPage("data:text/html,<h1>First</h1>");
      const second = yield* browser.newPage("data:text/html,<h1>Second</h1>");
      const stage = yield* Stage.make({ firstFrame: "2 seconds" });

      yield* stage.present(first);
      const cue = yield* stage.cue(second);

      yield* cue.ready;
      const sent = yield* Deferred.make<void>();
      const answer = Promise.withResolvers<void>();
      const keyboard = first.playwright.keyboard;
      const down = keyboard.down.bind(keyboard);
      let calls = 0;

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          answer.resolve();
          keyboard.down = down;
        }),
      );
      keyboard.down = (key) => {
        calls += 1;
        if (calls > 1) return down(key);

        return down(key).then(() => {
          Deferred.doneUnsafe(sent, Effect.void);

          return answer.promise;
        });
      };
      const input = yield* first.press("a").pipe(Effect.forkChild);

      yield* Deferred.await(sent);
      const committing = yield* cue.commit().pipe(Effect.forkChild);

      yield* Effect.sleep("30 millis");
      hidden = second.playwright;
      withholding = true;
      yield* second.goto("data:text/html,<h1>New document</h1>");
      answer.resolve();
      yield* Fiber.join(input);
      yield* Effect.sleep("30 millis");
      const queued = yield* first.press("b").pipe(Effect.forkChild);

      yield* Effect.sleep("50 millis");
      assert.strictEqual(calls, 1, "the next old-page operation must wait behind the cut");
      assert.isUndefined(committing.pollUnsafe());
      withholding = false;
      yield* Effect.promise(() =>
        second.playwright.evaluate(() => {
          document.body.style.background = "blue";
        }),
      );
      yield* Fiber.join(committing);
      yield* Fiber.join(queued);
      assert.strictEqual(calls, 2);
      assert.deepStrictEqual(yield* stage.current, Option.some(second));
    }),
  );
  it.effect("a missing old-page input acknowledgement refuses the reveal", () =>
    Effect.gen(function* () {
      const native = (yield* Browser).context.browser();

      if (native === null) return yield* Effect.die("local Chromium is required");

      const context = yield* Effect.acquireRelease(
        Effect.promise(() => native.newContext()),
        (context) => Effect.promise(() => context.close()),
      );

      const sent = yield* Deferred.make<void>();
      const answer = Promise.withResolvers<void>();

      const browser = yield* makeBrowser(
        context,
        { id: "drain", provider: "local" },
        { actionTimeout: "100 millis", navigationTimeout: "200 millis" },
      );

      const first = yield* browser.newPage("data:text/html,<h1>First</h1>");
      const second = yield* browser.newPage("data:text/html,<h1>Second</h1>");
      const keyboard = first.playwright.keyboard;
      const down = keyboard.down.bind(keyboard);
      const stage = yield* Stage.make();

      yield* stage.present(first);
      const cue = yield* stage.cue(second);

      yield* cue.ready;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          answer.resolve();
          keyboard.down = down;
        }),
      );
      keyboard.down = (key) =>
        down(key).then(() => {
          Deferred.doneUnsafe(sent, Effect.void);

          return answer.promise;
        });
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
  );
});

// A completed cut is not an input-drain failure when the outgoing capture takes longer to stop.
it.live("outgoing capture cleanup cannot time out a cut that already reached the output", () =>
  Effect.gen(function* () {
    const browser = yield* Chromium.open({ navigationTimeout: "200 millis" });
    const create = browser.context.newCDPSession.bind(browser.context);
    const stopping = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let ended = false;

    browser.context.newCDPSession = async (target) => {
      const session = await create(target);
      const send = session.send.bind(session);

      session.send = (method, params) => {
        const reply = send(method, params);

        return method === "Page.stopScreencast"
          ? reply.then(async (value) => {
              stopping.resolve();
              await release.promise;
              ended = true;

              return value;
            })
          : reply;
      };

      return session;
    };
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
);
