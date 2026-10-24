/** Native capture/switch fixtures shared by behavioral and optional latency checks. */
import { Clock, Effect, Schedule, Stream } from "effect";

import { Browser, make as makeBrowser } from "../../src/Browser.ts";
import type { Frame } from "../../src/Frame.ts";
import type * as Stage from "../../src/presentation/Stage.ts";
import * as TestCdp from "./TestCdp.ts";

// A page that paints every frame, so its capture sends frames all the time.
export const animated = `data:text/html,${encodeURIComponent(`<body style="margin:0"><canvas id=c width=300 height=300></canvas><script>
  const g = c.getContext("2d");
  (function draw(t) { g.fillStyle = "hsl(" + (t / 5 % 360) + ",80%,50%)"; g.fillRect(0, 0, 300, 300); requestAnimationFrame(draw); })(0);
</script></body>`)}`;

interface Sent {
  readonly target: unknown;
  readonly method: string;
  /** On the host monotonic clock, as the browser stamps frames. */
  readonly at: number;
}

/**
 * A browser over a context of its own, as one session: what its pages' own protocol sessions
 * sent, and a fault a test can plant for a page, answering a command itself instead.
 */
export const session = Effect.fnUntraced(function* (id: string) {
  const native = TestCdp.nativeContext(yield* Browser).browser();
  const clock = yield* Clock.Clock;

  if (native === null) return yield* Effect.die("the fixture requires local Chromium");

  const context = yield* Effect.acquireRelease(
    Effect.promise(() => native.newContext({ viewport: { width: 640, height: 400 } })),
    (context) => Effect.promise(() => context.close()),
  );

  const faults = yield* TestCdp.make();
  const sent: Array<Sent> = [];

  faults.observe(({ session, method }, phase) => {
    if (phase === "before")
      sent.push({
        target: session.nativePage,
        method,
        at: Number(clock.monotonicTimeNanosUnsafe()) / 1e6,
      });
  });
  const browser = yield* faults.provide(makeBrowser(context, { id, provider: "test" }));

  return { browser, sent, faults };
});

/** The stage's frames as they come, from now, and when each came, on the host clock. */
export const collect = Effect.fnUntraced(function* (stage: Stage.Stage) {
  const clock = yield* Clock.Clock;
  const frames: Array<Frame> = [];
  const came: Array<number> = [];

  yield* stage.frames.pipe(
    Stream.runForEach((frame) =>
      Effect.sync(() => {
        frames.push(frame);
        came.push(Number(clock.monotonicTimeNanosUnsafe()) / 1e6);
      }),
    ),
    Effect.forkScoped,
  );

  return Object.assign(frames, { came });
});

export const eventually = (check: Effect.Effect<boolean>) =>
  check.pipe(
    Effect.repeat({ until: (done) => done, schedule: Schedule.spaced("20 millis") }),
    Effect.timeout("10 seconds"),
  );

// Back-to-back long tasks with only timer gaps keep any in-page clock probe waiting, as a heavy
// game or chart can, while the browser itself still composites and captures the page.
export const busy = `<h1 style="font-size:80px">Busy</h1><script>
  function spin() { const end = performance.now() + 800; while (performance.now() < end) {} setTimeout(spin, 0); }
  setTimeout(spin, 50);
</script>`;

export const busyContext = Effect.fnUntraced(function* () {
  const native = TestCdp.nativeContext(yield* Browser).browser();

  if (native === null) return yield* Effect.die("the fixture requires local Chromium");

  const context = yield* Effect.acquireRelease(
    Effect.promise(() => native.newContext({ viewport: { width: 800, height: 600 } })),
    (context) => Effect.promise(() => context.close()),
  );

  return yield* makeBrowser(context, { id: "busy-capture", provider: "test" });
});
