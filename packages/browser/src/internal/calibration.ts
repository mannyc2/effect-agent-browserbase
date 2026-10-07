import { Clock, Duration, Effect, Option, Schema } from "effect";
import type { BrowserContext, Page } from "playwright-core";

import * as BrowserClock from "./clock.ts";

export interface PaintSample {
  readonly sentAt: number;
  readonly timestamp: number;
}

export interface StartupCalibration {
  readonly clock: BrowserClock.Estimate;
  /** Preserve both clocks so a later capture's offset can map these samples without stale bias. */
  readonly paintSamples: ReadonlyArray<PaintSample>;
}

interface EncodedFrame {
  readonly data: string;
  readonly timestamp: number;
}

interface NativeFrame {
  readonly data: string;
  readonly metadata: { readonly timestamp?: number };
  readonly sessionId: number;
}

const viewportSchema = Schema.Struct({
  width: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(3)),
  height: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1)),
});

const framesCodec = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ data: Schema.String, timestamp: Schema.Finite })),
);

const decodedSchema = Schema.Array(
  Schema.Struct({
    index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    marker: Schema.Literals([-1, 0, 1, 2]),
  }),
);

const installSource = String.raw`
(() => {
  document.documentElement.style.cssText =
    "margin:0;padding:0;width:100%;height:100%;background:rgb(0,0,0)";
  document.body.style.cssText = "margin:0;padding:0;width:100%;height:100%";
  const colors = ["rgb(255,0,255)", "rgb(0,255,255)", "rgb(255,255,0)"];
  document.addEventListener("mousemove", (event) => {
    if (!event.isTrusted) return;
    const marker = Math.max(0, Math.min(2, Math.floor(event.clientX / innerWidth * 3)));
    document.documentElement.style.backgroundColor = colors[marker];
  });
  return { width: innerWidth, height: innerHeight };
})()
`;

// Decoding is deliberately deferred until capture has stopped: returning JPEGs over CDP or
// drawing them in the renderer must not delay ACKs or contaminate the measured paint samples.
const decodeSource = String.raw`
(async (frames) => {
  const canvas = new OffscreenCanvas(1, 1);
  const drawing = canvas.getContext("2d", { willReadFrequently: true });
  if (drawing === null) throw new Error("the calibration canvas is unavailable");
  const decoded = [];
  for (let index = 0; index < frames.length; index++) {
    const binary = atob(frames[index].data);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
    try {
      drawing.drawImage(bitmap, Math.floor(bitmap.width / 2), Math.floor(bitmap.height / 2),
        1, 1, 0, 0, 1, 1);
      const [red, green, blue] = drawing.getImageData(0, 0, 1, 1).data;
      const marker = red > 180 && green < 90 && blue > 180 ? 0
        : red < 90 && green > 180 && blue > 180 ? 1
        : red > 180 && green > 180 && blue < 90 ? 2 : -1;
      decoded.push({ index, marker });
    } finally {
      bitmap.close();
    }
  }
  return decoded;
})
`;

const failed = (cause: unknown) => new BrowserClock.ClockCalibrationFailure({ cause });

// Separate from the measurement's own deadline: an unconfirmed close may leave a public tab.
const closeDeadline = Duration.seconds(5);

const command = <A>(
  run: () => Promise<A>,
): Effect.Effect<A, BrowserClock.ClockCalibrationFailure> =>
  Effect.tryPromise({ try: run, catch: failed });

const release = (run: () => Promise<unknown>) =>
  command(run).pipe(
    Effect.interruptible,
    Effect.timeoutOrElse({ duration: Duration.seconds(1), orElse: () => Effect.void }),
    Effect.ignore,
  );

// Native allocation cannot be cancelled. Interrupt the wait, but keep ownership of a handle
// returned after the deadline and close it once; its rejected cleanup reply is still observed.
const acquire = <A>(open: () => Promise<A>, dispose: (value: A) => Promise<unknown>) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: (signal) =>
        open().then((value) => {
          let closing: Promise<void> | undefined;

          const abandoned = () => {
            void close().catch(() => undefined);
          };

          const close = (): Promise<void> => {
            signal.removeEventListener("abort", abandoned);
            if (closing === undefined) {
              try {
                closing = dispose(value).then(() => undefined);
              } catch (cause) {
                closing = Promise.reject(cause);
              }
              void closing.catch(() => undefined);
            }

            return closing;
          };

          signal.addEventListener("abort", abandoned, { once: true });
          if (signal.aborted) abandoned();

          return { value, close };
        }),
      catch: failed,
    }).pipe(Effect.interruptible),
    (resource) => release(resource.close),
    { interruptible: true },
  );

const measure = (context: BrowserContext, privatePage: Page, ownerClock: Clock.Clock) =>
  Effect.gen(function* () {
    const session = yield* acquire(
      () => context.newCDPSession(privatePage),
      (cdp) => cdp.detach(),
    );

    const cdp = session.value;

    // The page is private and opened before any caller script, so its main world is ours; an
    // isolated world would cost two more round trips.
    const evaluate = (expression: string) =>
      command(() =>
        cdp.send("Runtime.evaluate", {
          expression,
          awaitPromise: true,
          returnByValue: true,
        }),
      ).pipe(
        Effect.flatMap((response) =>
          response.exceptionDetails === undefined
            ? Effect.succeed<unknown>(response.result.value)
            : Effect.fail(failed(new Error("the private paint calibration script failed"))),
        ),
      );

    const clock = yield* BrowserClock.calibrate(cdp, ownerClock);

    const frames: Array<EncodedFrame> = [];
    const acknowledgements = new Set<Promise<void>>();
    let failure: Option.Option<unknown> = Option.none();
    let received = 0;
    let encodedBytes = 0;
    let started = false;
    let accepting = false;
    let stopping: Promise<void> | undefined;

    const rememberFailure = (cause: unknown) => {
      if (Option.isNone(failure)) failure = Option.some(cause);
    };

    const stop = (): Promise<void> => {
      if (!started) return Promise.resolve();
      if (stopping === undefined) {
        accepting = false;
        cdp.off("Page.screencastFrame", onFrame);
        try {
          stopping = cdp.send("Page.stopScreencast").then(
            () => undefined,
            (cause: unknown) => rememberFailure(cause),
          );
        } catch (cause) {
          rememberFailure(cause);
          stopping = Promise.resolve();
        }
      }

      return stopping;
    };

    const reject = (detail: string) => {
      rememberFailure(new Error(detail));
      void stop();
    };

    const check = Effect.suspend(() =>
      Option.isSome(failure) ? Effect.fail(failed(failure.value)) : Effect.void,
    );

    const onFrame = (frame: NativeFrame) => {
      if (!accepting) return;
      // A lost reply keeps its slot until it settles; reaching the bound stops capture rather
      // than accumulating detached ACK promises or holding the browser's frame callback open.
      if (acknowledgements.size >= 32) {
        reject("private paint calibration exceeded its acknowledgement budget");

        return;
      }
      try {
        const acknowledgement = cdp
          .send("Page.screencastFrameAck", { sessionId: frame.sessionId })
          .then(
            () => {
              acknowledgements.delete(acknowledgement);
            },
            (cause: unknown) => {
              acknowledgements.delete(acknowledgement);
              rememberFailure(cause);
              void stop();
            },
          );

        acknowledgements.add(acknowledgement);
      } catch (cause) {
        rememberFailure(cause);
        void stop();

        return;
      }

      received++;
      encodedBytes += frame.data.length;
      if (received > 24 || frame.data.length > 16_384 || encodedBytes > 131_072) {
        reject("private paint calibration exceeded its frame budget");

        return;
      }

      const timestamp = frame.metadata.timestamp;

      if (timestamp === undefined || !Number.isFinite(timestamp)) return;
      frames.push({ data: frame.data, timestamp: timestamp * 1000 });
    };

    cdp.on("Page.screencastFrame", onFrame);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => cdp.off("Page.screencastFrame", onFrame)).pipe(Effect.asVoid),
    );
    yield* Effect.addFinalizer(() => release(stop));
    started = true;
    accepting = true;

    // Neither waits on the other, so they share a round trip. Frames painted before the marker
    // script ran show none of its colours and match no marker.
    const [viewport] = yield* Effect.all(
      [
        evaluate(installSource).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(viewportSchema)),
          Effect.mapError(failed),
        ),
        command(() =>
          cdp.send("Page.startScreencast", {
            format: "jpeg",
            quality: 60,
            maxWidth: 320,
            maxHeight: 200,
          }),
        ),
      ],
      { concurrency: "unbounded" },
    );

    const sent: Array<number> = [];

    // Markers are sent 180 ms apart, so each paints on its own. Their answers' round trips count
    // toward the spacing rather than adding to it.
    for (let marker = 0; marker < 3; marker++) {
      yield* check;
      const sentAt = Number(ownerClock.monotonicTimeNanosUnsafe()) / 1e6;

      sent.push(sentAt);
      yield* command(() =>
        cdp.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: (viewport.width * (marker + 0.5)) / 3,
          y: viewport.height / 2,
          button: "none",
        }),
      );
      const answered = Number(ownerClock.monotonicTimeNanosUnsafe()) / 1e6;

      yield* Effect.sleep(Duration.millis(Math.max(0, 180 - (answered - sentAt))));
    }

    yield* command(stop);
    while (acknowledgements.size > 0) yield* Effect.promise(() => Promise.all(acknowledgements));
    yield* check;

    const encoded = yield* Schema.encodeEffect(framesCodec)(frames).pipe(Effect.mapError(failed));

    const decoded = yield* evaluate(`${decodeSource}(${encoded})`).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(decodedSchema)),
      Effect.mapError(failed),
    );

    const paintSamples: Array<PaintSample> = [];

    for (let marker = 0; marker < 3; marker++) {
      const sentAt = sent[marker];
      let timestamp: number | undefined;

      for (const candidate of decoded) {
        const frame = frames[candidate.index];

        if (candidate.marker === marker && frame !== undefined)
          timestamp =
            timestamp === undefined ? frame.timestamp : Math.min(timestamp, frame.timestamp);
      }
      if (sentAt === undefined || timestamp === undefined)
        return yield* failed(new Error("private paint calibration did not capture every marker"));
      paintSamples.push({ sentAt, timestamp });
    }

    return { clock, paintSamples } satisfies StartupCalibration;
  });

/**
 * Only a constructor that owns a fresh context may call this, before caller init scripts or page
 * registration. An arbitrary supplied context, even one containing only about:blank, is not proof.
 *
 * The measurement is evidence, not a prerequisite: any failure to measure yields none. Only a
 * private page that cannot be closed fails, since it would otherwise surface as a public tab.
 */
export const owned = (
  context: BrowserContext,
  ownerClock: Clock.Clock,
): Effect.Effect<Option.Option<StartupCalibration>, BrowserClock.ClockCalibrationFailure> =>
  Effect.scoped(
    Effect.gen(function* () {
      let opened: (() => Promise<void>) | undefined;

      const measured = yield* Effect.gen(function* () {
        const privatePage = yield* acquire(
          () => context.newPage(),
          (page) => page.close(),
        );

        opened = privatePage.close;

        return yield* measure(context, privatePage.value, ownerClock);
      }).pipe(
        Effect.timeoutOrElse({
          duration: Duration.seconds(8),
          orElse: () =>
            Effect.fail(failed(new Error("private paint calibration exceeded its deadline"))),
        }),
        Effect.asSome,
        Effect.catch((failure) =>
          Effect.logDebug("startup capture calibration failed", failure.cause).pipe(
            Effect.as(Option.none<StartupCalibration>()),
          ),
        ),
      );

      // Confirm the close before exposing either outcome. The memoized close is never retried.
      if (opened !== undefined)
        yield* command(opened).pipe(
          Effect.timeoutOrElse({
            duration: closeDeadline,
            orElse: () =>
              Effect.fail(failed(new Error("the private calibration page did not close"))),
          }),
        );

      return measured;
    }),
  ).pipe(Effect.provideService(Clock.Clock, ownerClock));
