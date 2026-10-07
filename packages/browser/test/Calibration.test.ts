import { assert, describe, it } from "@effect/vitest";
import { Clock as EffectClock, Duration, Effect, Option } from "effect";
import { chromium, type CDPSession } from "playwright-core";

import { make as makeBrowser } from "../src/Browser.ts";
import * as Calibration from "../src/internal/pictures/calibration.ts";
import * as Clock from "../src/internal/pictures/clock.ts";

describe("Clock calibration", () => {
  it("keeps the true offset inside the full interval for asymmetric transports", () => {
    const offset = 5000;

    for (const [outbound, inbound] of [
      [5, 65],
      [140, 20],
    ] as const) {
      const result = Option.getOrThrow(
        Clock.estimate([
          {
            hostStart: 10_000,
            hostEnd: 10_000 + outbound + inbound,
            browserTime: 10_000 + outbound + offset,
          },
        ]),
      );

      assert.isAtMost(result.offsetMillis - result.uncertaintyMillis, offset);
      assert.isAtLeast(result.offsetMillis + result.uncertaintyMillis, offset);
      assert.strictEqual(result.uncertaintyMillis, (outbound + inbound) / 2);
      assert.notStrictEqual(result.offsetMillis, offset);
    }
  });

  it("uses the fastest complete probe without treating later receipts as exact clock evidence", () => {
    const result = Option.getOrThrow(
      Clock.estimate([
        { hostStart: 1000, hostEnd: 1100, browserTime: 10_050 },
        { hostStart: 2000, hostEnd: 2020, browserTime: 11_010 },
        { hostStart: 3000, hostEnd: 3400, browserTime: 12_020 },
      ]),
    );

    assert.deepStrictEqual(result, {
      offsetMillis: 9000,
      uncertaintyMillis: 10,
      roundTripMillis: 20,
      sampledAt: 2010,
    });
  });

  it("maps browser paint and CDP input stamps into one owner clock without mixing units", () => {
    const result = Option.getOrThrow(
      Clock.estimate([{ hostStart: 8000, hostEnd: 8040, browserTime: 1_700_000_000_020 }]),
    );

    const frame = 1_700_000_000_125;

    assert.strictEqual(Clock.toHostTime(result, frame), 8125);
    assert.strictEqual(Clock.toBrowserSeconds(result, 8125), frame / 1000);
    assert.strictEqual(
      Clock.toHostTime(result, 1_700_000_000_450) - Clock.toHostTime(result, frame),
      325,
    );
  });

  it.effect("keeps the browser's narrower estimate unless a measurement contradicts it", () =>
    Effect.gen(function* () {
      const precise = {
        offsetMillis: 1000,
        uncertaintyMillis: 1,
        roundTripMillis: 2,
        sampledAt: 0,
      };

      const mapping = Clock.mapping(Option.some(precise));

      const refresh = (offsetMillis: number, uncertaintyMillis: number) =>
        mapping.refresh(
          Effect.succeed({
            offsetMillis,
            uncertaintyMillis,
            roundTripMillis: uncertaintyMillis * 2,
            sampledAt: 1,
          }),
        );

      // A probe delayed behind a busy page agrees with the current estimate but says less.
      assert.deepStrictEqual(yield* refresh(1060, 75), precise);
      // A failed probe keeps the estimate the browser already holds.
      assert.deepStrictEqual(yield* mapping.refresh(Effect.fail("busy")), precise);
      // A no-worse probe is fresher evidence of the same offset.
      assert.strictEqual((yield* refresh(1000.5, 1)).offsetMillis, 1000.5);
      // A measurement that cannot contain the current offset means the clocks moved.
      assert.strictEqual((yield* refresh(1500, 30)).offsetMillis, 1500);
      assert.strictEqual(
        (yield* mapping.current(Effect.die("an estimate exists"))).offsetMillis,
        1500,
      );
    }),
  );

  it("ignores invalid probes and cannot calibrate from backward or nonfinite host intervals", () => {
    const invalid = [
      { hostStart: 20, hostEnd: 10, browserTime: 1000 },
      { hostStart: Number.NaN, hostEnd: 10, browserTime: 1000 },
      { hostStart: 0, hostEnd: Infinity, browserTime: 1000 },
      { hostStart: 0, hostEnd: 10, browserTime: Number.NaN },
      { hostStart: -Number.MAX_VALUE, hostEnd: Number.MAX_VALUE, browserTime: 1000 },
    ];

    assert.isTrue(Option.isNone(Clock.estimate([])));
    assert.isTrue(Option.isNone(Clock.estimate(invalid)));
    assert.deepStrictEqual(
      Clock.estimate([...invalid, { hostStart: 100, hostEnd: 120, browserTime: 1110 }]),
      Option.some({
        offsetMillis: 1000,
        uncertaintyMillis: 10,
        roundTripMillis: 20,
        sampledAt: 110,
      }),
    );
  });
});

const fresh = Effect.gen(function* () {
  const browser = yield* Effect.acquireRelease(
    Effect.promise(() => chromium.launch()),
    (native) => Effect.promise(() => native.close()),
  );

  const context = yield* Effect.promise(() =>
    browser.newContext({ viewport: { width: 640, height: 400 } }),
  );

  return context;
});

interface EmittingCalibrationSession extends CDPSession {
  emit(event: string | symbol, ...args: ReadonlyArray<unknown>): boolean;
}

describe("Owned paint calibration", () => {
  it.live("uses captured JPEG markers, stops before decoding and closes its private page", () =>
    Effect.gen(function* () {
      const context = yield* fresh;
      const createSession = context.newCDPSession.bind(context);
      const calls: Array<string> = [];

      context.newCDPSession = (target) =>
        createSession(target).then((cdp) => {
          const send = cdp.send.bind(cdp);

          const observed: CDPSession["send"] = (method, params) => {
            calls.push(
              method === "Runtime.evaluate" &&
                params !== undefined &&
                "expression" in params &&
                typeof params.expression === "string" &&
                params.expression.includes("OffscreenCanvas")
                ? "decode"
                : method,
            );

            return send(method, params);
          };

          cdp.send = observed;

          return cdp;
        });
      const result = Option.getOrThrow(yield* Calibration.owned(context, yield* EffectClock.Clock));

      assert.strictEqual(result.paintSamples.length, 3);
      assert.isTrue(result.paintSamples.every((sample) => Number.isFinite(sample.sentAt)));
      assert.isTrue(result.paintSamples.every((sample) => sample.timestamp > 1_000_000_000_000));
      assert.isAbove(calls.indexOf("decode"), calls.indexOf("Page.stopScreencast"));
      assert.strictEqual(calls.filter((method) => method === "Input.dispatchMouseEvent").length, 3);
      assert.strictEqual(calls.filter((method) => method === "Page.stopScreencast").length, 1);
      assert.isEmpty(context.pages());
    }),
  );

  it.live("closes the unpublished page and measures nothing when its CDP session fails", () =>
    Effect.gen(function* () {
      const context = yield* fresh;

      context.newCDPSession = () => Promise.reject(new Error("injected session failure"));
      const result = yield* Calibration.owned(context, yield* EffectClock.Clock);

      assert.isTrue(Option.isNone(result));
      assert.isEmpty(context.pages());
    }),
  );

  for (const rejectedMethod of [
    "Page.startScreencast",
    "Page.screencastFrameAck",
    "Page.stopScreencast",
  ] as const)
    it.live(
      "measures nothing and closes without replay when " + rejectedMethod + " loses its reply",
      () =>
        Effect.gen(function* () {
          const context = yield* fresh;
          const createSession = context.newCDPSession.bind(context);
          const calls: Array<string> = [];
          let rejected = false;

          context.newCDPSession = (target) =>
            createSession(target).then((cdp) => {
              const send = cdp.send.bind(cdp);

              const observed: CDPSession["send"] = (method, params) => {
                calls.push(method);
                const response = send(method, params);

                if (method !== rejectedMethod || rejected) return response;
                rejected = true;

                // Chromium receives the real command. The lost reply must not justify sending
                // another start or stop, nor leave an unobserved ACK rejection behind.
                return response.then(() => {
                  throw new Error("injected lost calibration reply");
                });
              };

              cdp.send = observed;

              return cdp;
            });
          const result = yield* Calibration.owned(context, yield* EffectClock.Clock);

          assert.isTrue(Option.isNone(result));
          assert.isTrue(rejected);
          assert.strictEqual(calls.filter((method) => method === "Page.startScreencast").length, 1);
          assert.strictEqual(calls.filter((method) => method === "Page.stopScreencast").length, 1);
          assert.isEmpty(context.pages());
        }),
    );

  it.live(
    "bounds retained JPEGs and pending ACKs when actual frames are delivered in a burst",
    () =>
      Effect.gen(function* () {
        const context = yield* fresh;
        const createSession = context.newCDPSession.bind(context);
        const release = Promise.withResolvers<void>();
        let maximumPending = 0;
        let pending = 0;
        let stops = 0;
        let decoded = false;
        let replayed = false;

        yield* Effect.addFinalizer(() => Effect.sync(() => release.resolve()));
        context.newCDPSession = (target) =>
          createSession(target).then((cdp) => {
            const send = cdp.send.bind(cdp);
            const emitter = cdp as EmittingCalibrationSession;
            const emit = emitter.emit.bind(emitter);

            emitter.emit = (event, ...args) => {
              if (event === "Page.screencastFrame" && !replayed) {
                replayed = true;
                for (let index = 0; index < 40; index++) emit(event, ...args);

                return true;
              }

              return emit(event, ...args);
            };

            const observed: CDPSession["send"] = (method, params) => {
              if (method === "Page.stopScreencast") stops++;
              if (
                method === "Runtime.evaluate" &&
                params !== undefined &&
                "expression" in params &&
                typeof params.expression === "string" &&
                params.expression.includes("OffscreenCanvas")
              )
                decoded = true;
              const response = send(method, params);

              if (method !== "Page.screencastFrameAck") return response;
              pending++;
              maximumPending = Math.max(maximumPending, pending);

              return response.then((result) =>
                release.promise.then(() => {
                  pending--;

                  return result;
                }),
              );
            };

            cdp.send = observed;

            return cdp;
          });
        const result = yield* Calibration.owned(context, yield* EffectClock.Clock);

        // The frame budget stops capture before anything is decoded or measured.
        assert.isTrue(Option.isNone(result));
        assert.isTrue(replayed);
        assert.isAbove(maximumPending, 0);
        assert.isAtMost(maximumPending, 32);
        assert.strictEqual(stops, 1);
        assert.isFalse(decoded);
        assert.isEmpty(context.pages());
        release.resolve();
      }),
  );
});

describe("Calibration deadlines", () => {
  for (const resource of ["page", "session"] as const)
    it.live("closes a late " + resource + " after its interrupted allocation wait", () =>
      Effect.gen(function* () {
        const context = yield* fresh;
        const live = yield* EffectClock.Clock;
        const entered = Promise.withResolvers<void>();

        const ownerClock: EffectClock.Clock = {
          currentTimeMillisUnsafe: () => live.currentTimeMillisUnsafe(),
          currentTimeMillis: live.currentTimeMillis,
          currentTimeNanosUnsafe: () => live.currentTimeNanosUnsafe(),
          currentTimeNanos: live.currentTimeNanos,
          monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
          monotonicTimeNanos: live.monotonicTimeNanos,
          // Only the measurement deadline is shortened, and only once the allocation under test
          // has begun: a slow page allocation must not end the measurement before the session
          // wait this case is about. Closing keeps its real bound.
          sleep: (duration) => {
            const millis = Duration.toMillis(duration);

            return millis >= 8000
              ? Effect.promise(() => entered.promise).pipe(
                  Effect.andThen(live.sleep(Duration.millis(millis / 100))),
                )
              : live.sleep(duration);
          },
        };

        const gate = Promise.withResolvers<void>();
        const pageClosed = Promise.withResolvers<void>();
        const sessionDetached = Promise.withResolvers<void>();
        const createPage = context.newPage.bind(context);
        const createSession = context.newCDPSession.bind(context);
        let closes = 0;
        let detaches = 0;

        yield* Effect.addFinalizer(() => Effect.sync(() => gate.resolve()));
        context.newPage = () =>
          createPage().then((page) => {
            const close = page.close.bind(page);

            page.close = (options) => {
              closes++;

              return close(options).then(() => {
                pageClosed.resolve();
              });
            };
            if (resource === "page") {
              entered.resolve();

              return gate.promise.then(() => page);
            }

            return page;
          });
        context.newCDPSession = (target) =>
          createSession(target).then((cdp) => {
            const detach = cdp.detach.bind(cdp);

            cdp.detach = () => {
              detaches++;

              return detach().then(
                () => {
                  sessionDetached.resolve();
                },
                (cause: unknown) => {
                  sessionDetached.resolve();
                  throw cause;
                },
              );
            };
            entered.resolve();

            return gate.promise.then(() => cdp);
          });

        // A missed measurement deadline yields no measurement; it does not fail the browser.
        const result = yield* Calibration.owned(context, ownerClock).pipe(
          Effect.timeout("2 seconds"),
        );

        assert.isTrue(Option.isNone(result));
        yield* Effect.promise(() => entered.promise).pipe(Effect.timeout("2 seconds"));
        gate.resolve();
        yield* Effect.promise(() => pageClosed.promise).pipe(Effect.timeout("2 seconds"));
        if (resource === "session")
          yield* Effect.promise(() => sessionDetached.promise).pipe(Effect.timeout("2 seconds"));
        assert.strictEqual(closes, 1);
        assert.strictEqual(detaches, resource === "session" ? 1 : 0);
        assert.isEmpty(context.pages());
      }),
    );

  for (const resource of ["close", "detach"] as const)
    it.live("bounds the finalizer when the private " + resource + " reply never arrives", () =>
      Effect.gen(function* () {
        const context = yield* fresh;
        const live = yield* EffectClock.Clock;
        const entered = Promise.withResolvers<void>();
        const gate = Promise.withResolvers<void>();
        const settled = Promise.withResolvers<void>();

        const ownerClock: EffectClock.Clock = {
          currentTimeMillisUnsafe: () => live.currentTimeMillisUnsafe(),
          currentTimeMillis: live.currentTimeMillis,
          currentTimeNanosUnsafe: () => live.currentTimeNanosUnsafe(),
          currentTimeNanos: live.currentTimeNanos,
          monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
          monotonicTimeNanos: live.monotonicTimeNanos,
          sleep: (duration) => {
            const millis = Duration.toMillis(duration);

            // Let real capture finish before accelerating the work and close deadlines; the
            // one-second cleanup wait is shortened independently so a masked finalizer cannot hide.
            return millis >= 8000 || millis === 5000
              ? Effect.promise(() => entered.promise).pipe(
                  Effect.andThen(live.sleep(Duration.millis(40))),
                )
              : live.sleep(Duration.millis(millis === 1000 ? 10 : millis));
          },
        };

        let closes = 0;
        let detaches = 0;
        const createPage = context.newPage.bind(context);
        const createSession = context.newCDPSession.bind(context);

        yield* Effect.addFinalizer(() => Effect.sync(() => gate.resolve()));
        context.newPage = () =>
          createPage().then((page) => {
            const close = page.close.bind(page);

            page.close = (options) => {
              closes++;
              const response = close(options);

              if (resource !== "close") return response;
              entered.resolve();

              return response
                .then(() => gate.promise)
                .then(() => {
                  settled.resolve();
                });
            };

            return page;
          });
        context.newCDPSession = (target) =>
          createSession(target).then((cdp) => {
            const detach = cdp.detach.bind(cdp);

            cdp.detach = () => {
              detaches++;
              const response = detach();

              if (resource !== "detach") return response;
              entered.resolve();

              return response.then(
                () =>
                  gate.promise.then(() => {
                    settled.resolve();
                  }),
                (cause: unknown) =>
                  gate.promise.then(() => {
                    settled.resolve();
                    throw cause;
                  }),
              );
            };

            return cdp;
          });

        const outcome = yield* Calibration.owned(context, ownerClock).pipe(
          Effect.exit,
          Effect.timeout("3 seconds"),
        );

        assert.strictEqual(
          outcome._tag,
          resource === "close" ? "Failure" : "Success",
          String(outcome),
        );
        assert.strictEqual(closes, 1);
        assert.strictEqual(detaches, 1);
        assert.isEmpty(context.pages());
        gate.resolve();
        yield* Effect.promise(() => settled.promise).pipe(Effect.timeout("2 seconds"));
        assert.strictEqual(closes, 1);
        assert.strictEqual(detaches, 1);
      }),
    );
});

describe("Fresh browser startup", () => {
  it.live("opens without a capture calibration when the measurement fails", () =>
    Effect.gen(function* () {
      const context = yield* fresh;
      const createSession = context.newCDPSession.bind(context);
      let injected = false;

      // The first session belongs to the private startup page; its capture never starts.
      context.newCDPSession = (target) =>
        createSession(target).then((cdp) => {
          const send = cdp.send.bind(cdp);

          const observed: CDPSession["send"] = (method, params) => {
            if (method !== "Page.startScreencast" || injected) return send(method, params);
            injected = true;

            return Promise.reject(new Error("injected capture failure"));
          };

          cdp.send = observed;

          return cdp;
        });

      const browser = yield* makeBrowser(context, {
        id: "fresh",
        provider: "test",
        contextOrigin: "fresh",
      });

      assert.isTrue(injected);
      assert.isTrue(Option.isNone(browser.captureCalibration));
      assert.isEmpty(context.pages());
      assert.isEmpty(yield* browser.pages);

      const page = yield* browser.newPage("data:text/html,<title>Usable</title>");

      yield* page.click({ x: 10, y: 10 });
      assert.strictEqual(yield* page.title, "Usable");
    }),
  );

  it.live("fails when its private page cannot be closed", () =>
    Effect.gen(function* () {
      const context = yield* fresh;
      const createPage = context.newPage.bind(context);

      context.newPage = () =>
        createPage().then((page) => {
          page.close = () => Promise.reject(new Error("injected close failure"));

          return page;
        });

      const error = yield* makeBrowser(context, {
        id: "fresh",
        provider: "test",
        contextOrigin: "fresh",
      }).pipe(Effect.flip);

      assert.strictEqual(error.operation, "calibrate");
      assert.isFalse(error.dispatched);
    }),
  );
});
