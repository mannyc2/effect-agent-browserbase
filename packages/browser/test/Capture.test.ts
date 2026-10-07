import { assert, layer } from "@effect/vitest";
import { Deferred, Duration, Effect, Fiber, Option, Schedule, Stream } from "effect";
import type { CDPSession } from "playwright-core";

import { Browser, make as makeBrowser } from "../src/Browser.ts";
import * as Chromium from "../src/Chromium.ts";
import type { Frame, Image } from "../src/Frame.ts";
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
    { frameHistory: Duration.millis(300) },
  );

  const page = yield* browser.page;

  const inject = (
    timestamp: number | undefined,
    device?: { readonly width: number; readonly height: number },
  ) => {
    if (received === undefined || replay === undefined)
      throw new Error("capture has not received a native JPEG");

    replay({
      ...received,
      metadata: {
        ...received.metadata,
        ...(device === undefined ? {} : { deviceWidth: device.width, deviceHeight: device.height }),
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

const eventually = (check: Effect.Effect<boolean>) =>
  check.pipe(
    Effect.repeat({ schedule: Schedule.spaced("5 millis"), until: (holds) => holds }),
    Effect.timeout("5 seconds"),
  );

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

// Paint keeps changing, but each native frame reaches the host 150 ms after Chromium sent it, as
// over a remote transport. A press turns the page red.
const delayedCapture = Effect.fnUntraced(function* () {
  const native = (yield* Browser).context.browser();

  if (native === null) return yield* Effect.die("the fixture requires local Chromium");

  const context = yield* Effect.acquireRelease(
    Effect.promise(() => native.newContext({ viewport: { width: 800, height: 600 } })),
    (context) => Effect.promise(() => context.close()),
  );

  const createSession = context.newCDPSession.bind(context);

  context.newCDPSession = async (target) => {
    const cdp = await createSession(target);
    const emitter = cdp as EmittingSession;
    const emit = emitter.emit.bind(emitter);

    emitter.emit = (event, ...args) => {
      if (event !== "Page.screencastFrame") return emit(event, ...args);
      setTimeout(() => emit(event, ...args), 150);

      return true;
    };

    return cdp;
  };

  const browser = yield* makeBrowser(context, { id: "delayed-capture", provider: "test" });
  const page = yield* browser.newPage();

  yield* page.goto(
    "data:text/html," +
      encodeURIComponent(`<body style="margin:0;height:100vh;background:rgb(0,0,255)">
<canvas id="spinner" width="80" height="80"></canvas>
<script>
  let turn = 0;
  (function draw() {
    const g = spinner.getContext("2d");
    g.fillStyle = "hsl(" + (turn++ * 15) + ",80%,50%)";
    g.fillRect(0, 0, 80, 80);
    requestAnimationFrame(draw);
  })();
  addEventListener("mousedown", () => { document.body.style.background = "rgb(255,0,0)"; });
</script></body>`),
  );
  yield* page.screencast().pipe(Stream.runDrain, Effect.ignore, Effect.forkScoped);
  // Let frames painted well after navigation arrive, so only the input rule can refuse them.
  yield* Effect.sleep("600 millis");

  const pressed = browser.recentEvents.pipe(
    Effect.map((events) => events.find((event) => event._tag === "PointerPressed")?.at),
    Effect.repeat({
      schedule: Schedule.spaced("5 millis"),
      until: (at) => at !== undefined,
    }),
    Effect.timeout("5 seconds"),
    Effect.map((at) => at ?? Infinity),
  );

  // A reused frame is one of the retained screencast frames, returned by reference; it is stale if
  // its paint could precede the given time.
  const reusedBefore = (image: Image, time: number) =>
    page.recentFrames.pipe(
      Effect.map((frames) =>
        frames.some(
          (frame) =>
            frame.data === image.data && frame.hostTime - frame.timing.uncertaintyMillis <= time,
        ),
      ),
    );

  return { browser, page, pressed, reusedBefore };
});

// The centre pixel of an image, decoded by the page itself.
const centreOf = (page: Page, image: Image) =>
  Effect.promise(() =>
    page.playwright.evaluate(async (bytes) => {
      const bitmap = await createImageBitmap(
        new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }),
      );

      const canvas = new OffscreenCanvas(1, 1).getContext("2d");

      if (canvas === null) throw new Error("no 2d canvas");
      canvas.drawImage(bitmap, bitmap.width / 2, bitmap.height / 2, 1, 1, 0, 0, 1, 1);
      const [red = 0, green = 0, blue = 0] = canvas.getImageData(0, 0, 1, 1).data;

      return { red, green, blue };
    }, Array.from(image.data)),
  );

// Chromium's screencast can miss a page's final paint. The relay withholds native frames on
// request, so the newest delivered frame shows an animation the page has already finished.
// The first frames of each capture reach the host 600 ms after it starts, as a hosted browser's
// do: they are acknowledged, so the capture runs on, but never delivered. The page animates for
// 1.5 seconds after loading and then sets `window.done`.
const slowFirstFrame = Effect.fnUntraced(function* () {
  const native = (yield* Browser).context.browser();

  if (native === null) return yield* Effect.die("the fixture requires local Chromium");

  const context = yield* Effect.acquireRelease(
    Effect.promise(() => native.newContext({ viewport: { width: 800, height: 600 } })),
    (context) => Effect.promise(() => context.close()),
  );

  const createSession = context.newCDPSession.bind(context);

  context.newCDPSession = async (target) => {
    const cdp = await createSession(target);
    const emitter = cdp as EmittingSession;
    const emit = emitter.emit.bind(emitter);
    const send = cdp.send.bind(cdp);
    let startedAt = Number.NEGATIVE_INFINITY;

    cdp.send = ((method: string, params?: object) => {
      if (method === "Page.startScreencast") startedAt = performance.now();

      return send(method as never, params as never);
    }) as typeof cdp.send;
    emitter.emit = (event, ...args) => {
      if (event !== "Page.screencastFrame" || performance.now() - startedAt >= 600)
        return emit(event, ...args);
      void send("Page.screencastFrameAck", { sessionId: (args[0] as RawFrame).sessionId }).catch(
        () => {},
      );

      return true;
    };

    return cdp;
  };

  const browser = yield* makeBrowser(context, { id: "slow-first-frame", provider: "test" });
  const page = yield* browser.newPage();

  yield* page.goto(
    "data:text/html," +
      encodeURIComponent(`<body style="margin:0;height:100vh">
<script>
  const started = performance.now();
  let turn = 0;
  (function draw() {
    if (performance.now() - started > 1500) { window.done = true; return; }
    document.body.style.background = "hsl(" + (turn++ % 360) + ",80%,40%)";
    requestAnimationFrame(draw);
  })();
</script></body>`),
  );

  return page;
});

const withheldFinalPaint = Effect.fnUntraced(function* () {
  const native = (yield* Browser).context.browser();

  if (native === null) return yield* Effect.die("the fixture requires local Chromium");

  const context = yield* Effect.acquireRelease(
    Effect.promise(() => native.newContext({ viewport: { width: 800, height: 600 } })),
    (context) => Effect.promise(() => context.close()),
  );

  const createSession = context.newCDPSession.bind(context);
  let withholding = false;

  context.newCDPSession = async (target) => {
    const cdp = await createSession(target);
    const emitter = cdp as EmittingSession;
    const emit = emitter.emit.bind(emitter);

    emitter.emit = (event, ...args) =>
      event === "Page.screencastFrame" && withholding ? true : emit(event, ...args);

    return cdp;
  };

  const browser = yield* makeBrowser(context, { id: "final-paint", provider: "test" });
  const page = yield* browser.newPage();

  yield* page.goto(
    "data:text/html," +
      encodeURIComponent(`<body style="margin:0;height:100vh">
<script>
  let turn = 0, running = true;
  (function draw() {
    if (!running) return;
    document.body.style.background = "hsl(" + (120 + (turn++ % 60)) + ",80%,40%)";
    requestAnimationFrame(draw);
  })();
  window.finish = () => { running = false; document.body.style.background = "rgb(255,0,0)"; };
</script></body>`),
  );
  yield* page.screencast().pipe(Stream.runDrain, Effect.ignore, Effect.forkScoped);
  yield* Effect.sleep("400 millis");

  const centre = (image: Image) => centreOf(page, image);

  const retained = (image: Image) =>
    page.recentFrames.pipe(
      Effect.map((frames) => frames.some((frame) => frame.data === image.data)),
    );

  return {
    browser,
    page,
    centre,
    retained,
    withhold: () => {
      withholding = true;
    },
  };
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

    it.effect("keeps every tab's input stamps when a busy tab's capture measures the clock", () =>
      Effect.gen(function* () {
        const browser = yield* busyContext("fresh");

        const quiet = yield* browser.newPage(
          "data:text/html," +
            encodeURIComponent(`<body style="margin:0;height:100vh"><script>
  window.deltas = [];
  addEventListener("mousedown", (event) => deltas.push(performance.now() - event.timeStamp));
</script></body>`),
        );

        const deltas = Effect.promise(() =>
          quiet.playwright.evaluate(() => (window as unknown as { deltas: number[] }).deltas),
        );

        for (let index = 0; index < 3; index++) yield* quiet.click({ x: 50, y: 50 });
        const before = (yield* deltas).length;

        // Back-to-back 150 ms tasks with no timer gaps delay every clock probe in that tab.
        const busy = yield* browser.newPage(
          "data:text/html," +
            encodeURIComponent(`<body>busy<script>
  const channel = new MessageChannel();
  let turns = 0;
  channel.port1.onmessage = () => {
    const end = performance.now() + 150;
    while (performance.now() < end) {}
    if (++turns < 200) channel.port2.postMessage(0);
  };
  channel.port2.postMessage(0);
</script></body>`),
        );

        yield* busy
          .screencast()
          .pipe(Stream.take(1), Stream.runDrain, Effect.timeout("15 seconds"));
        for (let index = 0; index < 3; index++) yield* quiet.click({ x: 50, y: 50 });
        const after = (yield* deltas).slice(before);

        // Handler time minus the stamped event time: a future stamp would make it negative.
        assert.strictEqual(after.length, 3);
        assert.isBelow(Math.max(...after.map(Math.abs)), 50, JSON.stringify(after));
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

    it.effect("never reuses paint from before input submitted by a running action", () =>
      Effect.gen(function* () {
        const { page, pressed, reusedBefore } = yield* delayedCapture();

        const clicking = yield* page
          .click({ x: 400, y: 300 }, { holdMillis: 1500 })
          .pipe(Effect.forkChild);

        yield* pressed;
        // While the action may still change the page, no cached paint is current.
        const image = yield* page.screenshot();

        assert.isFalse(yield* reusedBefore(image, Infinity));
        yield* Fiber.join(clicking);
      }),
    );

    it.effect("never reuses paint from before input of an action the caller interrupted", () =>
      Effect.gen(function* () {
        const { browser, page, pressed, reusedBefore } = yield* delayedCapture();

        const clicking = yield* page
          .click({ x: 400, y: 300 }, { holdMillis: 1500 })
          .pipe(Effect.forkChild);

        const input = yield* pressed;

        yield* Fiber.interrupt(clicking);
        const image = yield* page.screenshot();

        assert.isFalse(yield* reusedBefore(image, input));

        const action = (yield* browser.recentEvents).find(
          (event) => event._tag === "Action" && event.name === "click",
        );

        assert.deepStrictEqual(
          action?._tag === "Action" ? [action.ok, action.dispatched, action.error] : undefined,
          [false, true, "interrupted"],
        );
      }),
    );

    it.effect(
      "reuses an animating page's newest frame but never a stale one after paint stops",
      () =>
        Effect.gen(function* () {
          const { browser, page, centre, retained, withhold } = yield* withheldFinalPaint();

          // While the page animates, a frame painted moments ago is current.
          yield* Effect.gen(function* () {
            const latest = yield* page.latestFrame;
            const at = yield* browser.now;

            return Option.isSome(latest) && at - latest.value.hostTime < 50;
          }).pipe(
            Effect.repeat({ schedule: Schedule.spaced("5 millis"), until: (fresh) => fresh }),
            Effect.timeout("5 seconds"),
          );
          assert.isTrue(yield* retained(yield* page.screenshot()));

          // The final paint never reaches the host; the newest frame still shows the animation.
          withhold();
          yield* Effect.promise(() =>
            page.playwright.evaluate(() => (window as unknown as { finish: () => void }).finish()),
          );
          yield* Effect.sleep("400 millis");
          const image = yield* page.screenshot();
          const pixel = yield* centre(image);

          assert.isFalse(yield* retained(image));
          assert.isAbove(pixel.red, 200);
          assert.isBelow(pixel.green, 60);
        }),
    );

    it.effect("waits for the first frame before counting the page still", () =>
      Effect.gen(function* () {
        const page = yield* slowFirstFrame();

        yield* page.waitForStill({ quietMillis: 400, timeout: Duration.seconds(10) });

        assert.isTrue(
          yield* Effect.promise(() =>
            page.playwright.evaluate(() => (window as unknown as { done?: boolean }).done === true),
          ),
        );
      }),
    );

    it.effect("makes a moment's last frame the page now, after a stopped capture and input", () =>
      Effect.gen(function* () {
        const browser = yield* busyContext("fresh");
        const page = yield* browser.newPage();

        // The page repaints a few times before it settles, so several frames are retained.
        yield* page.goto(
          "data:text/html," +
            encodeURIComponent(`<body style="margin:0;background:rgb(255,0,0)">
<button style="position:absolute;left:10px;top:10px;width:100px;height:40px"
  onclick="document.body.style.background = 'rgb(0,0,255)'">go</button>
<script>
  let shade = 0;
  const repaint = setInterval(() => {
    document.body.style.background = shade++ % 2 === 0 ? "rgb(200,0,0)" : "rgb(255,0,0)";
    if (shade === 8) clearInterval(repaint);
  }, 40);
</script></body>`),
        );
        // Waiting for the screen to settle runs and stops a capture; its frames stay retained.
        yield* page.waitForStill({ quietMillis: 300 });
        const retained = yield* page.recentFrames;

        assert.isAbove(retained.length, 1);
        yield* page.click({ x: 50, y: 30 });

        const moment = yield* Moment.capture(page, { frames: 2 });

        const last = moment.frames.at(-1);

        const click = moment.events.find(
          (event) => event._tag === "Action" && event.name === "click",
        );

        assert.isDefined(last);
        assert.isDefined(click);
        if (last === undefined || click === undefined) return;
        assert.strictEqual(last.timing._tag, "Screenshot");
        assert.isAbove(last.hostTime, click.at);
        assert.isAbove((yield* centreOf(page, last.image)).blue, 200);
        // The moment still begins where its window does, not just before its last frame.
        assert.strictEqual(moment.frames.length, 2);
        assert.strictEqual(moment.frames[0]?.hostTime, retained[0]?.hostTime);
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

    it.effect("rejects invalid action and navigation timeouts before taking over a context", () =>
      Effect.gen(function* () {
        const native = (yield* Browser).context.browser();

        if (native === null) return yield* Effect.die("the fixture requires local Chromium");

        const context = yield* Effect.acquireRelease(
          Effect.promise(() => native.newContext()),
          (context) => Effect.promise(() => context.close()),
        );

        for (const name of ["actionTimeout", "navigationTimeout"] as const)
          for (const timeout of [
            Duration.zero,
            Duration.millis(-1),
            Duration.millis(Number.NaN),
            Duration.infinity,
          ]) {
            const error = yield* makeBrowser(
              context,
              { id: "invalid-timeout", provider: "test" },
              { [name]: timeout },
            ).pipe(Effect.flip);

            assert.strictEqual(error.reason._tag, "InvalidRequest", `${name} ${String(timeout)}`);
            assert.match(error.message, new RegExp(name));
            assert.isFalse(error.dispatched);
          }
        assert.isEmpty(context.pages());
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
          stats.accepted + stats.outOfOrder + stats.missingTimestamp + stats.foreignSize,
        );
        assert.isAbove(stats.accepted, 0);
        assert.strictEqual(count(calls, "Page.startScreencast"), 1);
        assert.strictEqual(count(calls, "Page.stopScreencast"), 1);
        assert.strictEqual(count(calls, "Page.screencastFrameAck"), stats.received);
      }),
    );

    it.effect("keeps a zoom's crops out of the screencast and follows a real viewport change", () =>
      Effect.gen(function* () {
        const browser = yield* busyContext("fresh");

        // The page keeps painting, so frames arrive throughout.
        const page = yield* browser.newPage(
          "data:text/html," +
            encodeURIComponent(`<body><script>
  let turn = 0;
  setInterval(() => { document.body.style.background = "hsl(" + (turn += 30) + ",70%,50%)"; }, 40);
</script></body>`),
        );

        const frames: Array<Frame> = [];

        const reader = yield* page.screencast().pipe(
          Stream.runForEach((frame) => Effect.sync(() => frames.push(frame))),
          Effect.forkChild,
        );

        const seen = (width: number, height: number) =>
          eventually(
            Effect.sync(() =>
              frames.some((frame) => frame.width === width && frame.height === height),
            ),
          );

        yield* seen(800, 600);

        // A crop is a clipped screenshot, which Chromium also draws into the running screencast.
        const crop = page
          .zoom({ x: 10, y: 20, width: 100, height: 100 })
          .pipe(Effect.andThen(Effect.sleep("100 millis")));

        for (let index = 0; index < 3; index++) yield* crop;
        yield* Effect.promise(() => page.playwright.setViewportSize({ width: 640, height: 480 }));
        yield* seen(640, 480);
        yield* crop;
        yield* Fiber.interrupt(reader);

        // Every delivered frame shows the whole viewport, before and after it changes size.
        const sizes = frames.map((frame) => `${frame.width}x${frame.height}`);
        const resized = sizes.indexOf("640x480");

        assert.deepStrictEqual([...new Set(sizes.slice(0, resized))], ["800x600"]);
        assert.deepStrictEqual([...new Set(sizes.slice(resized))], ["640x480"]);
        const stats = yield* page.captureStats;

        assert.isAbove(stats.foreignSize, 0);
        assert.strictEqual(
          stats.received,
          stats.accepted + stats.outOfOrder + stats.missingTimestamp + stats.foreignSize,
        );
      }),
    );

    it.effect("holds frames of another device size until a resize is confirmed, in order", () =>
      Effect.gen(function* () {
        const fixture = yield* setup(true);
        const frames: Array<Frame> = [];

        const reader = yield* fixture.page.screencast().pipe(
          Stream.runForEach((frame) => Effect.sync(() => frames.push(frame))),
          Effect.forkChild,
        );

        const template = yield* fixture.template;
        const base = (template.metadata.timestamp ?? 0) * 1000 - 1000;
        const half = { width: 400, height: 300 };
        const quarter = { width: 200, height: 150 };

        const delivered = (timestamp: number) =>
          eventually(Effect.sync(() => frames.some((frame) => frame.timestamp === timestamp)));

        // A scaled capture's frames keep their picture's shape but not the device's size, and the
        // page's own size returns after them.
        yield* Effect.sync(() => fixture.inject(base, half));
        yield* Effect.sync(() => fixture.inject(base + 10, half));
        yield* Effect.sync(() => fixture.inject(base + 20));
        yield* delivered(base + 20);
        // After a real resize, the page reports the frames' size.
        yield* Effect.promise(() => fixture.page.playwright.setViewportSize(half));
        yield* Effect.sync(() => fixture.inject(base + 30, half));
        yield* Effect.sync(() => fixture.inject(base + 40, half));
        yield* delivered(base + 40);
        // A size the page never reports, as under browser zoom or when it cannot answer in time,
        // is the page's once it outlasts any capture. Its frames still never go back in time.
        yield* Effect.sync(() => fixture.inject(base + 60, quarter));
        yield* Effect.sync(() => fixture.inject(base + 50, quarter));
        yield* delivered(base + 60);
        yield* Fiber.interrupt(reader);
        const stats = yield* fixture.page.captureStats;

        assert.deepStrictEqual(
          frames.map((frame) => frame.timestamp),
          [base + 20, base + 30, base + 40, base + 60],
        );
        assert.deepStrictEqual([stats.foreignSize, stats.outOfOrder], [2, 1]);
        assert.strictEqual(
          stats.received,
          stats.accepted + stats.outOfOrder + stats.missingTimestamp + stats.foreignSize,
        );
      }),
    );

    it.effect("keeps the frames painted within frameHistory of the newest", () =>
      Effect.gen(function* () {
        const fixture = yield* setup(true);

        const collect = yield* fixture.page
          .screencast()
          .pipe(Stream.take(4), Stream.runCollect, Effect.forkChild);

        const template = yield* fixture.template;
        const base = (template.metadata.timestamp ?? 0) * 1000 - 2000;

        for (const offset of [0, 150, 250, 400])
          yield* Effect.sync(() => fixture.inject(base + offset));
        yield* Fiber.join(collect);

        // The fixture keeps 300 ms, so only the first paint is too old once the last arrives.
        assert.deepStrictEqual(
          (yield* fixture.page.recentFrames).map((frame) => frame.timestamp),
          [base + 150, base + 250, base + 400],
        );
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
            foreignSize: 0,
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

    it.effect("bounds a stalled stop reply and starts the next capture once it settles", () =>
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

        // The late stop succeeds; it delayed capture but must not disable it for the page.
        fixture.releaseReply();

        const frames = yield* fixture.page
          .screencast()
          .pipe(Stream.take(1), Stream.runCollect, Effect.timeout("5 seconds"));

        assert.strictEqual(frames.length, 1);
        assert.strictEqual(count(fixture.calls, "Page.startScreencast"), 2);
        assert.strictEqual(count(fixture.calls, "Page.stopScreencast"), 2);
      }),
    );

    it.effect("rejects a reader whose explicit options differ from the running capture", () =>
      Effect.gen(function* () {
        const fixture = yield* setup();
        const small = { size: { width: 160, height: 120 }, quality: 10 };

        // Keep painting, so a reader that joins later still receives frames.
        yield* Effect.promise(() =>
          fixture.page.playwright.evaluate(() => {
            let turn = 0;

            setInterval(() => {
              document.body.style.background = `hsl(${(turn += 30)}, 70%, 50%)`;
            }, 40);
          }),
        );

        yield* fixture.page.screencast(small).pipe(Stream.runDrain, Effect.forkChild);
        yield* fixture.template;

        for (const conflicting of [{ quality: 95 }, { size: { width: 800, height: 600 } }]) {
          const error = yield* fixture.page
            .screencast(conflicting)
            .pipe(Stream.runDrain, Effect.flip, Effect.timeout("5 seconds"));

          assert.strictEqual(error.reason._tag, "InvalidRequest");
          assert.isFalse(error.dispatched);
        }
        // Readers without options, or with the same ones, share the running capture.
        for (const sharing of [{}, small]) {
          const frames = yield* fixture.page
            .screencast(sharing)
            .pipe(Stream.take(1), Stream.runCollect, Effect.timeout("5 seconds"));

          assert.deepStrictEqual(
            frames.map((frame) => [frame.width, frame.height]),
            [[160, 120]],
          );
        }
        assert.strictEqual(count(fixture.calls, "Page.startScreencast"), 1);
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

        const moment = yield* Moment.capture(fixture.page, { since: Duration.millis(100) });

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
