import { assert, layer } from "@effect/vitest";
import { Deferred, Duration, Effect, Fiber, Option, Stream } from "effect";
import type { CDPSession } from "playwright-core";

import { Browser, make as makeBrowser } from "../src/Browser.ts";
import * as Chromium from "../src/Chromium.ts";
import type { Frame } from "../src/Frame.ts";
import * as Moment from "../src/Moment.ts";
import type { Page } from "../src/Page.ts";

interface RawFrame {
  readonly data: string;
  readonly sessionId: number;
  readonly metadata: {
    readonly timestamp?: number | undefined;
    readonly offsetTop: number;
    readonly pageScaleFactor: number;
    readonly deviceWidth: number;
    readonly deviceHeight: number;
    readonly scrollOffsetX: number;
    readonly scrollOffsetY: number;
  };
}

interface EmittingSession extends CDPSession {
  emit(event: string | symbol, ...args: ReadonlyArray<unknown>): boolean;
}

interface Call {
  readonly method: string;
  readonly sessionId: number | undefined;
}

const setup = Effect.fnUntraced(function* (controlled = false) {
  const native = (yield* Browser).context.browser();

  if (native === null) return yield* Effect.die("the fixture requires local Chromium");

  const context = yield* Effect.acquireRelease(
    Effect.promise(() => native.newContext({ viewport: { width: 800, height: 600 } })),
    (context) => Effect.promise(() => context.close()),
  );

  const createSession = context.newCDPSession.bind(context);
  const ready = Promise.withResolvers<RawFrame>();
  const calls: Array<Call> = [];
  let received: RawFrame | undefined;
  let replay: ((frame: RawFrame) => void) | undefined;
  let ackGate: ReturnType<typeof Promise.withResolvers<void>> | undefined;

  let heldReply:
    | { readonly method: string; readonly gate: ReturnType<typeof Promise.withResolvers<void>> }
    | undefined;

  let pageCount = 0;

  context.on("page", () => {
    pageCount += 1;
  });
  context.newCDPSession = async (target) => {
    const cdp = await createSession(target);
    const send = cdp.send.bind(cdp);
    const emitter = cdp as EmittingSession;
    const emit = emitter.emit.bind(emitter);

    // The relay retains Chromium's actual session and JPEG. Only delivery order and reply
    // timing are controlled; the production listener still owns every observed frame and ACK.
    emitter.emit = (event, ...args) => {
      if (event === "Page.screencastFrame") {
        const frame = args[0] as RawFrame;

        received = frame;
        ready.resolve(frame);
        if (controlled) return true;
      }

      return emit(event, ...args);
    };
    replay = (frame) => {
      emit("Page.screencastFrame", frame);
    };

    const observed: CDPSession["send"] = (method, params) => {
      calls.push({
        method,
        sessionId:
          params !== undefined && "sessionId" in params && typeof params.sessionId === "number"
            ? params.sessionId
            : undefined,
      });
      const gate = method === "Page.screencastFrameAck" ? ackGate : undefined;

      if (gate !== undefined) return gate.promise.then(() => send(method, params));
      const response = send(method, params);
      const held = heldReply?.method === method ? heldReply.gate : undefined;

      return held === undefined
        ? response
        : response.then((value) => held.promise.then(() => value));
    };

    cdp.send = observed;

    return cdp;
  };
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      ackGate?.resolve();
      heldReply?.gate.resolve();
    }),
  );
  const rawPage = yield* Effect.promise(() => context.newPage());

  yield* Effect.promise(() =>
    rawPage.setContent('<title>Capture fixture</title><h1 id="kept">Preserved page</h1>'),
  );

  const browser = yield* makeBrowser(
    context,
    { id: "capture-test", provider: "test" },
    { frameHistory: 3 },
  );

  const page = yield* browser.page;

  const inject = (timestamp: number | undefined) => {
    if (received === undefined || replay === undefined)
      throw new Error("capture has not received a native JPEG");

    replay({
      ...received,
      metadata: {
        ...received.metadata,
        timestamp: timestamp === undefined ? undefined : timestamp / 1000,
      },
    });
  };

  return {
    browser,
    page,
    calls,
    template: Effect.promise(() => ready.promise).pipe(Effect.timeout("5 seconds")),
    inject,
    pageCount: () => pageCount,
    holdAcks: () => {
      ackGate = Promise.withResolvers<void>();
    },
    releaseAcks: () => ackGate?.resolve(),
    holdReply: (method: "Page.startScreencast" | "Page.stopScreencast") => {
      heldReply = { method, gate: Promise.withResolvers<void>() };
    },
    releaseReply: () => heldReply?.gate.resolve(),
    waitStarts: (wanted: number) =>
      Effect.gen(function* () {
        while (count(calls, "Page.startScreencast") < wanted) yield* Effect.sleep("1 millis");
      }).pipe(Effect.timeout("5 seconds")),
  };
});

const count = (calls: ReadonlyArray<Call>, method: string) =>
  calls.filter((call) => call.method === method).length;

// Back-to-back long tasks with only timer gaps keep any in-page clock probe waiting, as a heavy
// game or chart can, while the browser itself still composites and captures the page.
const busy = `<h1 style="font-size:80px">Busy</h1><script>
  function spin() { const end = performance.now() + 800; while (performance.now() < end) {} setTimeout(spin, 0); }
  setTimeout(spin, 50);
</script>`;

const busyContext = Effect.fnUntraced(function* (contextOrigin: "fresh" | "borrowed") {
  const native = (yield* Browser).context.browser();

  if (native === null) return yield* Effect.die("the fixture requires local Chromium");

  const context = yield* Effect.acquireRelease(
    Effect.promise(() => native.newContext({ viewport: { width: 800, height: 600 } })),
    (context) => Effect.promise(() => context.close()),
  );

  return yield* makeBrowser(context, { id: "busy-capture", provider: "test", contextOrigin });
});

const firstFrame = (page: Page) =>
  page.screencast().pipe(Stream.take(1), Stream.runCollect, Effect.timeout("15 seconds"));

layer(Chromium.layer(), { excludeTestServices: true, timeout: Duration.seconds(60) })(
  "Capture",
  (it) => {
    it.effect("keeps borrowed pages unchanged and exposes no active startup measurement", () =>
      Effect.gen(function* () {
        const { browser, page, calls, pageCount } = yield* setup();

        assert.isTrue(Option.isNone(browser.captureCalibration));
        assert.strictEqual(pageCount(), 1);
        assert.strictEqual(yield* page.title, "Capture fixture");
        assert.isEmpty(calls.filter((call) => call.method.startsWith("Input.")));
        assert.strictEqual(count(calls, "Page.startScreencast"), 0);
        const owned = yield* Browser;

        assert.isTrue(Option.isSome(owned.captureCalibration));
        if (Option.isNone(owned.captureCalibration)) return;
        assert.isAbove(owned.captureCalibration.value.paintSamples.length, 0);
        assert.isAtMost(owned.captureCalibration.value.paintSamples.length, 3);
        assert.isEmpty(owned.context.pages());
        assert.isEmpty(yield* owned.pages);
        assert.isEmpty(yield* owned.recentEvents);
      }),
    );

    it.effect("captures a busy page with the clock mapping its browser already holds", () =>
      Effect.gen(function* () {
        // A fresh browser holds its startup estimate; a borrowed one takes it from an idle page.
        for (const origin of ["fresh", "borrowed"] as const) {
          const browser = yield* busyContext(origin);

          if (origin === "borrowed") {
            const idle = yield* browser.newPage();

            yield* firstFrame(idle);
          }
          const page = yield* browser.newPage();

          yield* Effect.promise(() => page.playwright.setContent(busy));
          yield* Effect.sleep("300 millis");
          const frames = yield* firstFrame(page);
          const frame = frames[0];

          assert.strictEqual(frame?.timing._tag, "BrowserPaint", origin);
          assert.isAtMost(
            frame?.hostTime ?? Infinity,
            (frame?.receivedAt ?? 0) + (frame?.timing.uncertaintyMillis ?? 0) + 5,
          );
        }
      }),
    );

    it.effect("fails a busy page's first capture, undispatched, only while no mapping exists", () =>
      Effect.gen(function* () {
        const browser = yield* busyContext("borrowed");
        const page = yield* browser.newPage();

        yield* Effect.promise(() => page.playwright.setContent(busy));
        yield* Effect.sleep("300 millis");
        const error = yield* firstFrame(page).pipe(Effect.flip);

        assert.strictEqual(error._tag, "BrowserError");
        if (error._tag !== "BrowserError") return;
        assert.strictEqual(error.operation, "calibrate");
        assert.isFalse(error.dispatched);
      }),
    );

    it.effect("rejects invalid history bounds before taking over a borrowed context", () =>
      Effect.gen(function* () {
        const native = (yield* Browser).context.browser();

        if (native === null) return yield* Effect.die("the fixture requires local Chromium");

        const context = yield* Effect.acquireRelease(
          Effect.promise(() => native.newContext()),
          (context) => Effect.promise(() => context.close()),
        );

        const page = yield* Effect.promise(() => context.newPage());

        yield* Effect.promise(() => page.setContent("<title>Existing document</title>"));
        for (const frameHistory of [0, -1, Number.NaN, Infinity]) {
          const error = yield* makeBrowser(
            context,
            { id: "invalid-history", provider: "test" },
            {
              frameHistory,
            },
          ).pipe(Effect.flip);

          assert.strictEqual(error.reason._tag, "InvalidRequest");
          assert.isFalse(error.dispatched);
          assert.strictEqual(context.pages().length, 1);
        }
        assert.strictEqual(yield* Effect.promise(() => page.title()), "Existing document");
      }),
    );

    it.effect("maps real native paint into the owner clock and keeps viewport-sized JPEGs", () =>
      Effect.gen(function* () {
        const { browser, page, calls } = yield* setup();
        const began = yield* browser.now;
        const frames = yield* page.screencast().pipe(Stream.take(1), Stream.runCollect);
        const finished = yield* browser.now;
        const frame = frames[0];

        if (frame === undefined)
          return yield* Effect.die("the native screencast returned no frame");
        assert.strictEqual(frame.timing._tag, "BrowserPaint");
        assert.isAbove(frame.timestamp ?? 0, 1_000_000_000_000);
        assert.isAtLeast(frame.receivedAt, began);
        assert.isAtMost(frame.receivedAt, finished);
        assert.isAtMost(frame.hostTime, frame.receivedAt + frame.timing.uncertaintyMillis + 5);
        assert.isAbove(frame.hostTime, began - 1000);
        assert.deepStrictEqual([frame.width, frame.height], [800, 600]);
        assert.deepStrictEqual([frame.data[0], frame.data[1]], [0xff, 0xd8]);
        const stats = yield* page.captureStats;

        assert.strictEqual(
          stats.received,
          stats.accepted + stats.outOfOrder + stats.missingTimestamp,
        );
        assert.isAbove(stats.accepted, 0);
        assert.strictEqual(count(calls, "Page.startScreencast"), 1);
        assert.strictEqual(count(calls, "Page.stopScreencast"), 1);
        assert.strictEqual(count(calls, "Page.screencastFrameAck"), stats.received);
      }),
    );

    it.effect("counts invalid and reordered callbacks while gaps follow browser paint time", () =>
      Effect.gen(function* () {
        const fixture = yield* setup(true);
        const before = yield* fixture.page.captureStats;

        const collect = yield* fixture.page
          .screencast()
          .pipe(Stream.take(3), Stream.runCollect, Effect.forkChild);

        const template = yield* fixture.template;
        const base = (template.metadata.timestamp ?? 0) * 1000 - 1000;

        for (const offset of [0, 16, 8, 16])
          yield* Effect.sync(() => fixture.inject(base + offset));
        yield* Effect.sync(() => fixture.inject(undefined));
        yield* Effect.sync(() => fixture.inject(Number.NaN));
        yield* Effect.sync(() => fixture.inject(base + 100));
        const frames = yield* Fiber.join(collect);
        const stats = yield* fixture.page.captureStats;

        assert.deepStrictEqual(
          frames.map((frame) => frame.timestamp),
          [base, base + 16, base + 100],
        );
        assert.deepStrictEqual(
          { ...stats },
          {
            received: 7,
            accepted: 3,
            outOfOrder: 2,
            missingTimestamp: 2,
            subscriberMissed: 0,
            gaps: { count: 2, totalMillis: 100, minMillis: 16, maxMillis: 84, lastMillis: 84 },
          },
        );
        assert.strictEqual(before.received, 0);
        assert.deepStrictEqual(
          (yield* fixture.page.recentFrames).map((frame) => frame.timestamp),
          frames.map((frame) => frame.timestamp),
        );
        assert.closeTo(frames[2]!.hostTime - frames[0]!.hostTime, 100, 0.001);
        assert.strictEqual(count(fixture.calls, "Page.screencastFrameAck"), 7);
        yield* Effect.sync(() => fixture.inject(base + 200));
        assert.deepStrictEqual(yield* fixture.page.captureStats, stats);
      }),
    );

    it.effect(
      "measures reader-observed losses without charging a late subscriber for history",
      () =>
        Effect.gen(function* () {
          const fixture = yield* setup(true);
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const slowFrames: Array<Frame> = [];
          const fastFrames: Array<Frame> = [];
          let fastSignal = Deferred.makeUnsafe<void>();

          const slow = yield* fixture.page.screencast().pipe(
            Stream.take(17),
            Stream.tap((frame) =>
              Effect.gen(function* () {
                slowFrames.push(frame);
                if (slowFrames.length === 1) {
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(release);
                }
              }),
            ),
            Stream.runDrain,
            Effect.forkChild,
          );

          const template = yield* fixture.template;
          const base = (template.metadata.timestamp ?? 0) * 1000 - 1000;

          yield* Effect.sync(() => fixture.inject(base));
          yield* Deferred.await(entered).pipe(
            Effect.timeoutOrElse({
              duration: "3 seconds",
              orElse: () =>
                Effect.die("the first capture reader did not observe its initial frame"),
            }),
          );

          const fast = yield* fixture.page.screencast().pipe(
            Stream.tap((frame) =>
              Effect.sync(() => {
                fastFrames.push(frame);
                Deferred.doneUnsafe(fastSignal, Effect.void);
              }),
            ),
            Stream.runDrain,
            Effect.forkChild,
          );

          yield* Effect.yieldNow;
          for (let index = 1; index <= 20; index++) {
            fastSignal = Deferred.makeUnsafe<void>();
            yield* Effect.sync(() => fixture.inject(base + index * 10));
            yield* Deferred.await(fastSignal).pipe(
              Effect.timeoutOrElse({
                duration: "3 seconds",
                orElse: () =>
                  Effect.gen(function* () {
                    const stats = yield* fixture.page.captureStats;

                    return yield* Effect.die(
                      "fast reader missed frame " +
                        index +
                        ": " +
                        JSON.stringify({
                          stats,
                          slow: slowFrames.length,
                          fast: fastFrames.length,
                          starts: count(fixture.calls, "Page.startScreencast"),
                          stops: count(fixture.calls, "Page.stopScreencast"),
                        }),
                    );
                  }),
              }),
            );
          }
          assert.strictEqual(fastFrames.length, 20);
          assert.strictEqual(fastFrames[0]?.timestamp, base + 10);
          assert.strictEqual((yield* fixture.page.captureStats).subscriberMissed, 0);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(slow).pipe(
            Effect.timeoutOrElse({
              duration: "3 seconds",
              orElse: () =>
                Effect.die("the resumed reader received only " + slowFrames.length + " frames"),
            }),
          );
          assert.strictEqual(slowFrames.length, 17);
          assert.strictEqual(slowFrames[1]?.timestamp, base + 50);
          assert.strictEqual(slowFrames.at(-1)?.timestamp, base + 200);
          assert.strictEqual((yield* fixture.page.captureStats).subscriberMissed, 4);
          assert.strictEqual(count(fixture.calls, "Page.startScreencast"), 1);
          assert.strictEqual(count(fixture.calls, "Page.stopScreencast"), 0);
          yield* Fiber.interrupt(fast);
          assert.strictEqual(count(fixture.calls, "Page.stopScreencast"), 1);
        }),
    );

    it.effect("does not include a deliberate capture pause in browser-time gap statistics", () =>
      Effect.gen(function* () {
        const fixture = yield* setup(true);

        const first = yield* fixture.page
          .screencast()
          .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);

        const template = yield* fixture.template;
        const base = (template.metadata.timestamp ?? 0) * 1000 - 1000;

        yield* Effect.sync(() => fixture.inject(base));
        yield* Effect.sync(() => fixture.inject(base + 20));
        yield* Fiber.join(first);

        const second = yield* fixture.page
          .screencast()
          .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);

        yield* fixture.waitStarts(2);
        yield* Effect.sync(() => fixture.inject(base + 500));
        yield* Effect.sync(() => fixture.inject(base + 530));
        yield* Fiber.join(second);
        assert.deepStrictEqual((yield* fixture.page.captureStats).gaps, {
          count: 2,
          totalMillis: 50,
          minMillis: 20,
          maxMillis: 30,
          lastMillis: 30,
        });
        assert.strictEqual(count(fixture.calls, "Page.startScreencast"), 2);
        assert.strictEqual(count(fixture.calls, "Page.stopScreencast"), 2);
      }),
    );

    it.effect(
      "bounds pending ACK replies and terminates capture without blocking a subscriber",
      () =>
        Effect.gen(function* () {
          const fixture = yield* setup(true);

          const failure = yield* fixture.page
            .screencast()
            .pipe(Stream.runDrain, Effect.flip, Effect.forkChild);

          const template = yield* fixture.template;
          const base = (template.metadata.timestamp ?? 0) * 1000 - 1000;

          fixture.holdAcks();
          for (let index = 0; index < 33; index++)
            yield* Effect.sync(() => fixture.inject(base + index));
          const error = yield* Fiber.join(failure).pipe(Effect.timeout("5 seconds"));

          assert.strictEqual(error._tag, "BrowserError");
          assert.match(error.message, /ack/i);
          assert.strictEqual(count(fixture.calls, "Page.screencastFrameAck"), 32);
          assert.strictEqual(count(fixture.calls, "Page.stopScreencast"), 1);
          const stopped = yield* fixture.page.captureStats;

          yield* Effect.sync(() => fixture.inject(base + 100));
          assert.deepStrictEqual(yield* fixture.page.captureStats, stopped);
          fixture.releaseAcks();
        }),
    );

    it.effect("ends a waiting reader with Closed when its page closes", () =>
      Effect.gen(function* () {
        const fixture = yield* setup();

        const reader = yield* fixture.page
          .screencast()
          .pipe(Stream.runDrain, Effect.flip, Effect.forkChild);

        yield* fixture.template;
        yield* fixture.page.close;
        const error = yield* Fiber.join(reader).pipe(Effect.timeout("5 seconds"));

        assert.strictEqual(error.reason._tag, "Closed");
        assert.isAtMost(count(fixture.calls, "Page.stopScreencast"), 1);
      }),
    );

    it.effect("bounds a stalled start reply and stops the uncertain generation once", () =>
      Effect.gen(function* () {
        const fixture = yield* setup();

        fixture.holdReply("Page.startScreencast");

        const error = yield* fixture.page
          .screencast()
          .pipe(Stream.runDrain, Effect.flip, Effect.timeout("5 seconds"));

        assert.strictEqual(error._tag, "BrowserError");
        assert.match(error.message, /start.*deadline/i);
        assert.strictEqual(count(fixture.calls, "Page.startScreencast"), 1);
        assert.strictEqual(count(fixture.calls, "Page.stopScreencast"), 1);
        fixture.releaseReply();
      }),
    );

    it.effect("bounds a stalled stop reply and reports it before another capture can start", () =>
      Effect.gen(function* () {
        const fixture = yield* setup();

        fixture.holdReply("Page.stopScreencast");
        yield* fixture.page
          .screencast()
          .pipe(Stream.take(1), Stream.runCollect, Effect.exit, Effect.timeout("5 seconds"));

        const error = yield* fixture.page
          .screencast()
          .pipe(Stream.runDrain, Effect.flip, Effect.timeout("5 seconds"));

        assert.strictEqual(error._tag, "BrowserError");
        assert.match(error.message, /stop.*deadline/i);
        assert.strictEqual(count(fixture.calls, "Page.startScreencast"), 1);
        assert.strictEqual(count(fixture.calls, "Page.stopScreencast"), 1);
        fixture.releaseReply();
      }),
    );

    it.effect("releases an interrupted reader and starts the next capture once", () =>
      Effect.gen(function* () {
        const fixture = yield* setup();
        const first = yield* fixture.page.screencast().pipe(Stream.runDrain, Effect.forkChild);

        yield* fixture.template;
        yield* Fiber.interrupt(first).pipe(Effect.timeout("5 seconds"));
        assert.strictEqual(count(fixture.calls, "Page.stopScreencast"), 1);

        const frames = yield* fixture.page
          .screencast()
          .pipe(Stream.take(1), Stream.runCollect, Effect.timeout("5 seconds"));

        assert.strictEqual(frames.length, 1);
        assert.strictEqual(count(fixture.calls, "Page.startScreencast"), 2);
        assert.strictEqual(count(fixture.calls, "Page.stopScreencast"), 2);
      }),
    );

    it.effect("does not turn a late old paint into fresh Moment evidence", () =>
      Effect.gen(function* () {
        const fixture = yield* setup(true);

        const capture = yield* fixture.page
          .screencast()
          .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);

        const template = yield* fixture.template;
        const oldPaint = (template.metadata.timestamp ?? 0) * 1000 - 2000;

        yield* Effect.sync(() => fixture.inject(oldPaint));
        const old = (yield* Fiber.join(capture))[0];

        if (old === undefined) return yield* Effect.die("missing retained old frame");
        yield* Effect.promise(() =>
          fixture.page.playwright.evaluate(() => {
            document.body.style.backgroundColor = "#1267cb";
          }),
        );

        const moment = yield* Moment.capture(fixture.page, { windowMillis: 100 }).pipe(
          Effect.provideService(Browser, fixture.browser),
        );

        const image = moment.frames[0];

        if (image === undefined) return yield* Effect.die("missing screenshot fallback");
        assert.notStrictEqual(image, old);
        assert.notDeepEqual(image.data, old.data);
        assert.strictEqual(image.timing._tag, "Screenshot");
        assert.strictEqual(image.timestamp, undefined);
        assert.isAbove(image.hostTime, old.hostTime + 1000);
        assert.isAtLeast(image.receivedAt, image.hostTime);
      }),
    );
  },
);
