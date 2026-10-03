import { expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Fiber, Redacted, Result, Stream } from "effect";

import { BrowserPolicy } from "../src/BrowserData.ts";
import * as BrowserRuntime from "../src/BrowserRuntime.ts";
import * as Capture from "../src/Capture.ts";
import { BrowserError, Reasons } from "../src/Errors.ts";
import * as Testing from "../src/Testing.ts";

const first = "https://capture.test/first";
const second = "https://capture.test/second";

const fixture = Effect.fnUntraced(function* (
  options: {
    readonly startFailure?: BrowserError;
    readonly start?: Effect.Effect<void>;
    readonly stopFailure?: BrowserError;
    readonly stop?: Effect.Effect<void>;
  } = {},
) {
  const scripted = yield* Testing.binding({
    documents: [
      { url: first, text: "First" },
      { url: second, text: "Second" },
    ],
  });

  const runtime = yield* BrowserRuntime.make({
    implementation: "provider-capture-test",
    binding: scripted.binding,
  }).pipe(Effect.provide(Testing.sequentialCrypto));

  const starts: Array<BrowserRuntime.CaptureStart> = [];
  const targets: Array<BrowserRuntime.CaptureTarget> = [];
  let stops = 0;
  let releases = 0;

  const acquired = yield* runtime.acquire(BrowserPolicy.unrestricted(), (cleanup) =>
    Effect.gen(function* () {
      const release = yield* Effect.cached(
        cleanup.fence.pipe(
          Effect.andThen(cleanup.capture),
          Effect.andThen(cleanup.initialization),
          Effect.andThen(cleanup.disconnect),
          Effect.orDie,
          Effect.asVoid,
        ),
      );

      yield* Effect.addFinalizer(() => release);

      return {
        reference: "provider-capture-test",
        connection: () => Effect.succeed(Redacted.make("wss://capture.test/")),
        release,
        cleanupResult: Effect.succeedNone,
        closeChecked: release,
        captureSource: (target: BrowserRuntime.CaptureTarget): BrowserRuntime.CaptureSource => {
          targets.push(target);

          return {
            start: (request) =>
              Effect.gen(function* () {
                starts.push(request);
                if (options.startFailure !== undefined) return yield* options.startFailure;
                yield* options.start ?? Effect.void;
                request.opened?.(first);
              }),
            stop: Effect.gen(function* () {
              stops++;
              if (options.stopFailure !== undefined) return yield* options.stopFailure;
              yield* options.stop ?? Effect.void;
            }),
            release: () => {
              releases++;
            },
          };
        },
      } satisfies BrowserRuntime.Lifetime;
    }),
  );

  const { session } = yield* acquired.connect;

  const emit = (request: BrowserRuntime.CaptureStart, timestamp: number) =>
    request.receive({
      data: Testing.jpeg(),
      timestamp,
      viewportWidth: 64,
      viewportHeight: 48,
    });

  return { session, starts, targets, emit, counts: () => ({ stops, releases }) };
});

it.effect("provider capture orders frames and documents on its own source", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture();
      const page = f.session.initialPage;

      expect(f.starts).toHaveLength(0);
      expect(f.targets).toHaveLength(0);
      const interval = yield* Capture.start(page, { lifetime: "page" });
      const source = f.starts[0]!;

      expect(f.targets).toEqual([
        { pageId: page.identity.pageId, targetId: (yield* page.describe()).targetId },
      ]);
      f.emit(source, 1000);
      yield* page.navigate({ url: second });
      f.emit(source, 1001);
      expect((yield* interval.snapshot).currentDocument).toBe(0);
      source.document?.(second, false);
      f.emit(source, 1002);
      source.document?.(`${second}#same`, true);
      const summary = yield* interval.stop;
      const frames = yield* Stream.runCollect(interval.frames);

      expect(frames.map((frame) => frame.document)).toEqual([0, 0, 1]);
      expect(summary.initialUrl).toBe(first);
      expect(summary.documentBoundaries).toMatchObject([
        { document: 1, sameDocument: false, afterSequence: 1, url: second },
        { document: 1, sameDocument: true, afterSequence: 2, url: `${second}#same` },
      ]);
      expect(summary.nativeStop).toBe("confirmed");
      expect(f.counts()).toEqual({ stops: 1, releases: 1 });
      const events = (yield* page.timeline.snapshot()).events;

      expect(
        events.filter(({ event }) => event._tag === "FirstFrame").map(({ event }) => event),
      ).toMatchObject([{ captureDocument: 0 }, { captureDocument: 1 }]);
      expect((yield* page.observe()).text).toBe("Second");
    }),
  ),
);

it.effect(
  "an observation transport failure ends only its interval with the original typed reason",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const interval = yield* Capture.start(f.session.initialPage);

        const failure = BrowserError.make({
          operation: "capture",
          reason: Reasons.Transport.make({}),
          outcome: "unknown",
        });

        f.starts[0]!.fail(failure);
        expect(yield* Stream.runDrain(interval.frames).pipe(Effect.flip)).toBe(failure);
        const summary = yield* interval.completed;

        expect(summary).toMatchObject({
          reason: "parent-unavailable",
          nativeStop: "confirmed",
          qualification: {
            authority: "open",
            ownerPhase: "open",
            containment: { _tag: "NotRequired" },
          },
          error: { reason: { _tag: "Transport" } },
        });
        expect((yield* f.session.status).phase).toBe("open");
        yield* f.session.initialPage.navigate({ url: second });
        expect((yield* f.session.initialPage.observe()).text).toBe("Second");
        const next = yield* Capture.start(f.session.initialPage);

        yield* next.stop;
        expect(f.starts).toHaveLength(2);
      }),
    ),
);

it.effect("provider start failures retain their reason and leave control usable", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const failure = BrowserError.make({
        operation: "capture-start",
        reason: Reasons.Timeout.make({}),
        outcome: "undispatched",
      });

      const f = yield* fixture({ startFailure: failure });

      expect(yield* Capture.start(f.session.initialPage).pipe(Effect.flip)).toMatchObject({
        operation: failure.operation,
        reason: failure.reason,
        outcome: failure.outcome,
        containment: { _tag: "NotRequired" },
      });
      expect(f.counts()).toEqual({ stops: 1, releases: 1 });
      yield* f.session.initialPage.navigate({ url: second });
      expect((yield* f.session.initialPage.observe()).text).toBe("Second");
    }),
  ),
);

it.effect("an unconfirmed provider stop quarantines capture without fencing control", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture({
        stopFailure: BrowserError.make({
          operation: "capture-stop",
          reason: Reasons.Transport.make({}),
          outcome: "unknown",
        }),
      });

      const interval = yield* Capture.start(f.session.initialPage);

      expect((yield* interval.stop).nativeStop).toBe("unconfirmed");
      expect(f.counts()).toEqual({ stops: 1, releases: 0 });
      expect(yield* Capture.start(f.session.initialPage).pipe(Effect.flip)).toMatchObject({
        reason: { _tag: "Busy" },
      });
      yield* f.session.initialPage.navigate({ url: second });
      expect((yield* f.session.initialPage.observe()).text).toBe("Second");
      expect((yield* f.session.status).phase).toBe("open");
    }),
  ),
);

it.effect("provider start defects retain their original cause through native accounting", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const defect = new Error("provider source defect");
      const f = yield* fixture({ start: Effect.die(defect) });
      const exit = yield* Capture.start(f.session.initialPage).pipe(Effect.exit);

      expect(exit._tag).toBe("Failure");
      if (exit._tag !== "Failure") return;
      expect(Result.getOrThrow(Cause.findDefect(exit.cause))).toBe(defect);
      expect(f.counts()).toEqual({ stops: 1, releases: 1 });
    }),
  ),
);

it.effect("confirmed control Page closure releases a provider's failed-stop quarantine", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture({
        stopFailure: BrowserError.make({
          operation: "capture-stop",
          reason: Reasons.Transport.make({}),
          outcome: "unknown",
        }),
      });

      const interval = yield* Capture.start(f.session.initialPage);

      expect((yield* interval.stop).nativeStop).toBe("unconfirmed");
      expect(f.counts().releases).toBe(0);
      yield* f.session.initialPage.close();
      expect(f.counts().releases).toBe(1);
      const closed = yield* interval.completed;

      expect(closed.reason).toBe("stopped");
      expect(closed.qualification.authority).toBe("closed");
      // The closed Page no longer consumes one of the four capture reservations.
      for (let index = 0; index < 4; index++) {
        const page = yield* f.session.createPage();
        const replacement = yield* Capture.start(page);

        expect((yield* replacement.snapshot).phase).toBe("capturing");
      }
    }),
  ),
);

it.effect("confirmed Page closure releases a provider once while its stop is pending", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const continueStop = yield* Deferred.make<void>();

      const f = yield* fixture({
        stop: Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(continueStop)),
        ),
      });

      const interval = yield* Capture.start(f.session.initialPage);
      const stopping = yield* interval.stop.pipe(Effect.forkChild);

      yield* Deferred.await(entered);
      expect(f.counts()).toEqual({ stops: 1, releases: 0 });
      yield* f.session.initialPage.close();
      expect(f.counts()).toEqual({ stops: 1, releases: 1 });
      expect((yield* interval.snapshot).phase).toBe("stopping");
      yield* Deferred.succeed(continueStop, undefined);
      expect((yield* Fiber.join(stopping)).nativeStop).toBe("confirmed");
      expect(f.counts()).toEqual({ stops: 1, releases: 1 });
    }),
  ),
);
