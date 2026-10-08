// The capture connection against a local Chromium, reached as a hosted session is: through the
// fake API, at a DevTools address that is A1's counting proxy. The proxy numbers the connections
// in the order they open: Playwright's control connection is 0, and the capture connection opens
// as the first capture starts.
import { assert, it } from "@effect/vitest";
import { Effect, Fiber, Option, Schedule, Stream } from "effect";
import type { BrowserError } from "effect-browser/BrowserError";
import type { Frame } from "effect-browser/Frame";
import type { Page } from "effect-browser/Page";

import { behindProxy, type Command, type Proxy } from "../../browser/test/protocol.ts";
import * as Browserbase from "../src/Browserbase.ts";
import * as TestBrowserbase from "../src/testing/TestBrowserbase.ts";

const control = 0;
const capturing = 1;

const html = (body: string) => `data:text/html,${encodeURIComponent(body)}`;

const animated = html(`<body style="margin:0"><canvas id=c width=300 height=300></canvas><script>
  const g = c.getContext("2d");
  (function draw(t) { g.fillStyle = "hsl(" + (t / 5 % 360) + ",80%,50%)"; g.fillRect(0, 0, 300, 300); requestAnimationFrame(draw); })(0);
</script></body>`);

/** A hosted session on the fake API, whose browser is the proxy's, for the rest of `use`. */
const hosted = <A, E, R>(
  proxy: Proxy,
  use: (hosted: Browserbase.Hosted) => Effect.Effect<A, E, R>,
  options: Browserbase.Options = {},
) =>
  Browserbase.open(options).pipe(
    Effect.flatMap(use),
    Effect.scoped,
    Effect.provide(TestBrowserbase.layer({ connectUrl: proxy.endpoint })),
  );

/** The commands sent on `connection` since `from`, a screencast's acknowledgements and stop aside. */
const sentOn = (proxy: Proxy, connection: number, from: number) =>
  proxy.commands
    .slice(from)
    .filter(
      (command) =>
        command.connection === connection &&
        command.method !== "Page.screencastFrameAck" &&
        command.method !== "Page.stopScreencast",
    );

const methods = (commands: ReadonlyArray<Command>) => commands.map((command) => command.method);

/** Frames a reader gets, in order, while the capture runs in the scope. */
const recorded = (page: Page) =>
  Effect.gen(function* () {
    const frames: Array<Frame> = [];

    yield* page.screencast().pipe(
      Stream.runForEach((frame) => Effect.sync(() => frames.push(frame))),
      Effect.forkScoped,
    );
    yield* Effect.sync(() => frames.length).pipe(
      Effect.repeat({ schedule: Schedule.spaced("10 millis"), until: (count) => count > 0 }),
      Effect.timeout("10 seconds"),
    );

    return frames;
  });

const firstFrame = (page: Page) =>
  page.screencast().pipe(Stream.take(1), Stream.runDrain, Effect.timeout("15 seconds"));

// What a capture connection may carry: attach and detach for the page's target, its documents, and
// the screencast. Nothing that acts on the page.
const readOnly = new Set([
  "Target.attachToTarget",
  "Target.detachFromTarget",
  "Page.enable",
  "Page.getFrameTree",
  "Page.startScreencast",
  "Page.screencastFrameAck",
  "Page.stopScreencast",
]);

it.live(
  "carries the screencast alone on its own connection, and the reads stay where they were",
  () =>
    Effect.gen(function* () {
      const proxy = yield* behindProxy();

      yield* hosted(proxy, ({ browser }) =>
        Effect.gen(function* () {
          const page = yield* browser.newPage(animated);

          // The browser's first capture maps its clock and reads the viewport on the page's own
          // session, as without a capture connection; the capture connection attaches meanwhile,
          // turns the Page domain on and reads the frame tree, and starts the screencast.
          let from = proxy.commands.length;

          yield* firstFrame(page);
          assert.strictEqual(sentOn(proxy, control, from).length, 7);
          assert.deepStrictEqual(methods(sentOn(proxy, capturing, from)), [
            "Target.attachToTarget",
            "Page.enable",
            "Page.getFrameTree",
            "Page.startScreencast",
          ]);

          // A later capture reads the viewport on the page's own session and starts on its own.
          from = proxy.commands.length;
          yield* firstFrame(page);
          assert.deepStrictEqual(methods(sentOn(proxy, control, from)), ["Runtime.evaluate"]);
          assert.deepStrictEqual(methods(sentOn(proxy, capturing, from)), ["Page.startScreencast"]);

          // Reads and pictures cost what they did.
          const frames = yield* recorded(page);

          from = proxy.commands.length;
          yield* page.snapshot();
          assert.strictEqual(sentOn(proxy, control, from).length, 1);
          assert.isEmpty(sentOn(proxy, capturing, from));
          yield* Effect.sleep("300 millis");

          const stats = yield* page.captureStats();

          assert.isAbove(frames.length, 5);
          assert.isTrue(frames.every((frame) => frame.timing._tag === "BrowserPaint"));
          assert.isAtMost(stats.ackBacklog, 32);
          assert.isAtLeast(stats.received, stats.accepted);
          assert.isAtLeast(stats.accepted, frames.length);

          // A wait for a still screen with a capture on air asks the page twice on the control
          // connection, as on the page's own session, and ends with one round trip on the capture
          // connection.
          const still = yield* browser.newPage(html("<p>Still</p>"));

          yield* still.snapshot();
          yield* recorded(still);
          from = proxy.commands.length;
          yield* still.ready({ quietMillis: 200 });
          assert.strictEqual(sentOn(proxy, control, from).length, 2);
          assert.deepStrictEqual(methods(sentOn(proxy, capturing, from)), ["Page.getFrameTree"]);
        }),
      );

      const onControl = proxy.commands.filter((command) => command.connection === control);
      const onCapture = proxy.commands.filter((command) => command.connection === capturing);

      assert.isEmpty(methods(onControl).filter((method) => method.includes("Screencast")));
      assert.deepStrictEqual(
        methods(onCapture).filter((method) => !readOnly.has(method)),
        [],
      );
      assert.strictEqual(proxy.connected, 2);
    }).pipe(Effect.scoped),
);

it.live(
  "ends a capture, typed, when its connection fails, and the next capture opens another",
  () =>
    Effect.gen(function* () {
      const proxy = yield* behindProxy();

      yield* hosted(proxy, ({ browser }) =>
        Effect.gen(function* () {
          const page = yield* browser.newPage(animated);

          const reader = yield* page
            .screencast()
            .pipe(Stream.runDrain, Effect.flip, Effect.forkScoped);

          yield* page.latestFrame.pipe(
            Effect.repeat({ schedule: Schedule.spaced("10 millis"), until: Option.isSome }),
            Effect.timeout("10 seconds"),
          );
          proxy.drop(capturing);

          const error = yield* Fiber.join(reader).pipe(Effect.timeout("5 seconds"));

          assert.deepStrictEqual(
            [error.operation, error.reason._tag, error.dispatched],
            ["screencast", "Failed", false],
          );
          // The page and its own session stand.
          yield* page.snapshot();
          yield* firstFrame(page);
          assert.strictEqual(proxy.connected, 3);
        }),
      );
    }).pipe(Effect.scoped),
);

/** A failure's reason, and its cause when the page or browser is gone. */
const lossOf = (error: BrowserError) => ({
  reason: error.reason._tag,
  cause: error.reason._tag === "Closed" ? error.reason.cause : undefined,
});

// A capture's reader hears that the browser was lost, as every other call on the page does,
// whichever connection hears the end first: the connections dropping, the capture connection's
// first or the control connection's, or the owner releasing the session, on the capture
// connection and on the page's own session.
it.live("tells a capture's reader the browser was lost, whichever connection hears it first", () =>
  Effect.gen(function* () {
    const ends = [
      [true, "drop, capture connection first"],
      [true, "drop, control connection first"],
      [true, "release"],
      [false, "drop"],
      [false, "release"],
    ] as const;

    const told = yield* Effect.forEach(ends, ([captureConnection, end]) =>
      Effect.gen(function* () {
        const proxy = yield* behindProxy();

        return yield* hosted(
          proxy,
          ({ browser, release }) =>
            Effect.gen(function* () {
              const page = yield* browser.newPage(animated);

              const reader = yield* page
                .screencast()
                .pipe(Stream.runDrain, Effect.flip, Effect.forkScoped);

              yield* page.latestFrame.pipe(
                Effect.repeat({ schedule: Schedule.spaced("10 millis"), until: Option.isSome }),
                Effect.timeout("10 seconds"),
              );
              // Browserbase cuts the connections as it ends a session it was asked to release.
              if (end === "release") yield* release;
              for (const connection of end === "drop, control connection first"
                ? [control, capturing]
                : [capturing, control])
                proxy.drop(connection);

              const error = yield* Fiber.join(reader).pipe(Effect.timeout("10 seconds"));

              return {
                end,
                captureConnection,
                ...lossOf(error),
                lost: yield* browser.disconnected,
              };
            }),
          { captureConnection },
        );
      }).pipe(Effect.scoped),
    );

    assert.deepStrictEqual(
      Array.from(told),
      ends.map(([captureConnection, end]) => {
        const cause = end === "release" ? "released" : "connection";

        return { end, captureConnection, reason: "Closed", cause, lost: cause } as const;
      }),
    );
  }),
);

// A canvas that repaints four times a second is never still. The capture connection stalls for a
// frame's length while a wait for a still screen runs, holding a frame back for 700 ms, which is
// longer than the spell, while every acknowledgement is answered and the page's own evidence comes
// back at once on the control connection. The wait must never end.
it.live("never reads a stall on the capture connection as a still screen", () =>
  Effect.gen(function* () {
    const proxy = yield* behindProxy();
    let stalledUntil = 0;

    proxy.lag = (connection) =>
      connection === capturing && performance.now() < stalledUntil ? 700 : 0;

    const ticking = html(`<body style="margin:0"><canvas id=c width=300 height=300></canvas><script>
      const g = c.getContext("2d"); let n = 0;
      setInterval(() => { g.fillStyle = "hsl(" + (n++ * 37 % 360) + ",80%,50%)"; g.fillRect(0, 0, 300, 300); }, 250);
    </script></body>`);

    const waits = yield* hosted(proxy, ({ browser }) =>
      Effect.gen(function* () {
        const page = yield* browser.newPage(ticking);

        yield* recorded(page);
        yield* Effect.sleep("1 second");

        return yield* Effect.forEach([0, 1], () =>
          Effect.gen(function* () {
            yield* Effect.sleep("200 millis").pipe(
              Effect.andThen(Effect.sync(() => (stalledUntil = performance.now() + 270))),
              Effect.forkChild,
            );

            return yield* page.ready({ quietMillis: 400, timeout: "3 seconds" }).pipe(
              Effect.as("still"),
              Effect.catch((error) => Effect.succeed(error.reason._tag)),
            );
          }),
        );
      }),
    );

    assert.deepStrictEqual(waits, ["Timeout", "Timeout"]);
  }).pipe(Effect.scoped),
);

/** The longest wait between frames a reader got within the interval, its ends included. */
const longestWait = (frames: ReadonlyArray<Frame>, from: number, to: number) => {
  const arrivals = [
    from,
    ...frames.map((frame) => frame.receivedAt).filter((at) => at > from && at < to),
    to,
  ];

  return Math.max(...arrivals.slice(1).map((at, index) => at - (arrivals[index] ?? at)));
};

// A large message on the control connection holds everything after it there for 1.5 s, as an
// upload over a slow link does: Browserbase refuses compression, and a 335 KB upload took up to
// 2.7 s to cross. A capture on that connection stops for as long, its acknowledgements waiting
// behind the upload; on the capture connection its frames keep coming. The control arm shows the
// measurement can see the stall.
it.live("keeps frames coming while a large message holds the connection that drives the page", () =>
  Effect.gen(function* () {
    const longest = (captureConnection: boolean) =>
      Effect.gen(function* () {
        const proxy = yield* behindProxy();

        proxy.hold = (command) =>
          command.connection === control && command.bytes >= 100_000 ? 1500 : 0;

        return yield* hosted(
          proxy,
          ({ browser }) =>
            Effect.gen(function* () {
              const page = yield* browser.newPage(animated);
              const frames = yield* recorded(page);

              yield* Effect.sleep("300 millis");
              const from = yield* browser.now;

              yield* Effect.promise(() =>
                page.playwright.evaluate((text) => text.length, "x".repeat(400_000)),
              );

              return longestWait(frames, from, yield* browser.now);
            }),
          { captureConnection },
        );
      }).pipe(Effect.scoped);

    const apart = yield* longest(true);
    const shared = yield* longest(false);

    assert.isBelow(apart, 600, `the longest wait on the capture connection, ${apart} ms`);
    assert.isAbove(shared, 1200, `the longest wait on the control connection, ${shared} ms`);
  }),
);

const colored = (color: string) =>
  html(`<body style="margin:0;height:100vh;background:${color}"><p id=t></p><script>
    setInterval(() => { t.textContent = String(performance.now()); }, 20);
  </script></body>`);

const colors = ["rgb(255, 0, 0)", "rgb(0, 255, 0)", "rgb(0, 0, 255)"];

/** Which of `colors` each frame shows at its centre, decoded by the page itself, or -1. */
const shownColors = (page: Page, frames: ReadonlyArray<Frame>) =>
  Effect.promise(() =>
    page.playwright.evaluate(
      async (pictures) =>
        Promise.all(
          pictures.map(async (bytes) => {
            const bitmap = await createImageBitmap(
              new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }),
            );

            const canvas = new OffscreenCanvas(1, 1).getContext("2d");

            if (canvas === null) throw new Error("no 2d canvas");
            canvas.drawImage(bitmap, bitmap.width / 2, bitmap.height / 2, 1, 1, 0, 0, 1, 1);
            const [red = 0, green = 0, blue = 0] = canvas.getImageData(0, 0, 1, 1).data;
            const channels = [red, green, blue];
            const strongest = channels.indexOf(Math.max(...channels));

            return channels.filter((channel) => channel > 160).length === 1 ? strongest : -1;
          }),
        ),
      frames.map((frame) => Array.from(frame.data)),
    ),
  );

// What the control connection hears comes 300 ms late, so the capture connection sees each new
// document commit first. Its frames carry the document they followed on their own connection at
// once, numbered as `Navigated` later numbers it, and never one before the document they show.
it.live("tags frames with the documents their own connection saw commit", () =>
  Effect.gen(function* () {
    const proxy = yield* behindProxy();

    proxy.lag = (connection) => (connection === control ? 300 : 0);

    yield* hosted(proxy, ({ browser }) =>
      Effect.gen(function* () {
        const page = yield* browser.newPage(colored(colors[0] ?? ""));
        const frames = yield* recorded(page);

        for (const color of colors.slice(1)) {
          yield* Effect.sleep("400 millis");
          yield* page.goto(colored(color));
        }
        yield* Effect.sleep("400 millis");

        // Each color's document, and when the control connection heard it commit.
        const commits = (yield* page.recentEvents).flatMap((event) =>
          event._tag === "Navigated" && !event.sameDocument ? [event] : [],
        );

        const documentOf = colors.map((color) =>
          commits.find((commit) => decodeURIComponent(commit.url).includes(color)),
        );

        const shown = yield* shownColors(page, frames);
        const latest = Math.max(...commits.map((commit) => commit.document));
        const early = [0, 0, 0];

        frames.forEach((frame, index) => {
          const color = shown[index] ?? -1;
          const commit = documentOf[color];

          assert.isAtMost(frame.document, latest);
          if (commit === undefined) return;
          assert.isAtLeast(
            frame.document,
            commit.document,
            `a frame of document ${commit.document}`,
          );
          if (frame.document === commit.document && frame.receivedAt < commit.at)
            early[color] = (early[color] ?? 0) + 1;
        });
        // The later documents' first frames came before the control connection heard them commit.
        assert.isAbove(early[1] ?? 0, 0);
        assert.isAbove(early[2] ?? 0, 0);
      }),
    );
  }).pipe(Effect.scoped),
);

// The capture connection can attach after a new document has committed and before the page's own
// session hears it, when it cannot number that document yet. Its frames take the number the page's
// own session gives the document once it hears it, as `Navigated` does.
it.live("numbers frames as the page's own session does, once it hears a commit late", () =>
  Effect.gen(function* () {
    const proxy = yield* behindProxy();

    proxy.lag = (connection) => (connection === control ? 300 : 0);

    yield* hosted(proxy, ({ browser }) =>
      Effect.gen(function* () {
        const page = yield* browser.newPage();
        const from = proxy.commands.length;
        const going = yield* Effect.forkChild(page.goto(animated));

        // The browser commits soon after it is asked to navigate; the control connection hears it
        // 300 ms later.
        yield* Effect.sync(() =>
          proxy.commands.slice(from).some((command) => command.method === "Page.navigate"),
        ).pipe(
          Effect.repeat({ schedule: Schedule.spaced("5 millis"), until: (sent) => sent }),
          Effect.timeout("10 seconds"),
        );
        yield* Effect.sleep("100 millis");
        const frames = yield* recorded(page);

        yield* Fiber.join(going);
        yield* Effect.sleep("300 millis");

        const [latest] = (yield* page.recentEvents)
          .flatMap((event) =>
            event._tag === "Navigated" && !event.sameDocument ? [event.document] : [],
          )
          .slice(-1);

        assert.isNotEmpty(frames);
        assert.deepStrictEqual([...new Set(frames.map((frame) => frame.document))], [latest]);
      }),
    );
  }).pipe(Effect.scoped),
);

// A tab behind another paints only while some session holds focus emulation on it. The page's own
// session does, so its capture keeps coming over the capture connection, which sends none.
// Planting its absence too, the page behind stops: the measurement can see a page not painting.
it.live("keeps a capture of a page behind coming", () =>
  Effect.gen(function* () {
    const behind = (plantedOff: boolean) =>
      Effect.gen(function* () {
        const proxy = yield* behindProxy();

        proxy.swallow = (command) =>
          command.method === "Emulation.setFocusEmulationEnabled" &&
          (plantedOff || !proxy.attached.has(command.sessionId ?? ""));

        return yield* hosted(proxy, ({ browser }) =>
          Effect.gen(function* () {
            const page = yield* browser.newPage(animated);
            const frames = yield* recorded(page);

            // The newest tab is in front.
            yield* browser.newPage("about:blank");
            yield* Effect.sleep("500 millis");
            const before = frames.length;

            yield* Effect.sleep("1 second");

            return frames.length - before;
          }),
        );
      }).pipe(Effect.scoped);

    assert.isAbove(yield* behind(false), 20);
    assert.isAtMost(yield* behind(true), 1);
  }),
);

// The library takes a crop on the connection that drives the page, and Chromium draws it into the
// screencast on the capture connection at the crop's own size. None reaches a reader, nor even the
// size filter, so the window around each crop holds across the two connections, and the page's own
// frames keep coming right after each crop.
it.live("keeps the library's crops out of a capture on the other connection", () =>
  Effect.gen(function* () {
    const proxy = yield* behindProxy();

    const { crops, afterCrops, stats } = yield* hosted(proxy, ({ browser }) =>
      Effect.gen(function* () {
        const page = yield* browser.newPage(animated);
        const { width, height } = yield* page.viewport;
        const frames = yield* recorded(page);
        const replies: Array<number> = [];

        for (let index = 0; index < 10; index++) {
          yield* page.zoom({ x: 5, y: 5, width: 160, height: 90 });
          replies.push(yield* browser.now);
          yield* Effect.sleep("250 millis");
        }
        yield* Effect.sleep("1200 millis");

        return {
          crops: frames.filter((frame) => frame.width !== width || frame.height !== height),
          afterCrops: frames.filter((frame) =>
            replies.some((at) => frame.receivedAt >= at && frame.receivedAt <= at + 40),
          ),
          stats: yield* page.captureStats(),
        };
      }),
    );

    assert.deepStrictEqual([crops.length, stats.foreignSize], [0, 0]);
    assert.isNotEmpty(afterCrops);
  }).pipe(Effect.scoped),
);
