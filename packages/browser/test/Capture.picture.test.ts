// Native pixels are checked in Capture.test; this transport exercises settlement and ownership.
import { assert, it } from "@effect/vitest";
import { Clock, Duration, Effect, Exit, Fiber, Option, Schedule, Scope, Stream } from "effect";

import { BrowserError, Failed } from "../src/BrowserError.ts";
import * as Replies from "../src/internal/input/replies.ts";
import * as Capture from "../src/internal/pictures/capture.ts";
import type { Transport } from "../src/internal/pictures/transport.ts";

const eventually = (check: () => boolean) =>
  Effect.sync(check).pipe(
    Effect.repeat({ until: Boolean, schedule: Schedule.spaced("5 millis") }),
    Effect.timeout("5 seconds"),
  );

const fixture = Effect.fnUntraced(function* () {
  const clock = yield* Clock.Clock;
  const starts: Array<Parameters<Transport["start"]>[0]> = [];
  let stops = 0;
  let listening: Parameters<Transport["listen"]>[0] | undefined;
  let start = () => Promise.resolve();
  let stop = () => Promise.resolve();
  let viewport = Effect.succeed({ width: 10, height: 10 });
  let timestamp = 0;

  const emit = () =>
    listening?.frame({
      data: "AA==",
      sessionId: ++timestamp,
      metadata: { timestamp, deviceWidth: 10, deviceHeight: 10 },
    });

  const error = (cause: unknown) =>
    new BrowserError({
      operation: "screencast",
      dispatched: false,
      reason: new Failed({ detail: cause instanceof Error ? cause.message : String(cause) }),
    });

  const controller = yield* Capture.make({
    id: "page",
    clock,
    transport: Effect.succeed({
      start: (settings) => {
        starts.push(settings);
        emit();

        return start();
      },
      stop: () => {
        stops++;

        return stop();
      },
      acknowledge: () => Promise.resolve(),
      sync: () => Promise.resolve(),
      listen: (on) => {
        listening = on;

        return () => {
          listening = undefined;
        };
      },
      frameTag: () => ({
        session: "session",
        connection: "connection",
        document: 1,
        url: "https://fixture.test",
      }),
    }),
    calibrate: Effect.succeed({
      offsetMillis: 0,
      uncertaintyMillis: 0,
      roundTripMillis: 0,
      sampledAt: 0,
    }),
    latest: () => undefined,
    renew: Effect.void,
    watch: Effect.void,
    frameHistory: Duration.seconds(5),
    viewport: Effect.suspend(() => viewport),
    imageSize: () => ({ width: 10, height: 10 }),
    error,
  });

  let shots = 0;

  const picture = (reply: Promise<void>) =>
    Effect.gen(function* () {
      shots++;
      const run = yield* Effect.service(Replies.Current);

      yield* Effect.promise(() => (run === undefined ? reply : run.track(reply)));
    });

  return {
    controller,
    starts,
    stops: () => stops,
    shots: () => shots,
    picture,
    onStart: (next: () => Promise<void>) => {
      start = next;
    },
    onStop: (next: () => Promise<void>) => {
      stop = next;
    },
    onViewport: (next: typeof viewport) => {
      viewport = next;
    },
    reader: controller
      .stream({ quality: 10, size: { width: 10, height: 10 } })
      .pipe(Stream.runDrain, Effect.exit, Effect.forkScoped),
  };
});

it.live("canceling a pending native pause waits for its reply before restoring capture", () =>
  Effect.gen(function* () {
    const f = yield* fixture();

    yield* f.reader;
    yield* eventually(() => f.starts.length === 1);
    const stop = Promise.withResolvers<void>();

    f.onStop(() => stop.promise);
    const shot = yield* f.controller.excluding(f.picture(Promise.resolve())).pipe(Effect.forkChild);

    yield* eventually(() => f.stops() === 1);
    const interrupted = yield* Fiber.interrupt(shot).pipe(Effect.forkChild);

    yield* Effect.sleep("30 millis");
    assert.strictEqual(f.starts.length, 1);
    assert.strictEqual(f.shots(), 0);
    stop.resolve();
    yield* Fiber.join(interrupted);
    assert.strictEqual(f.starts.length, 2);
    assert.isTrue(yield* f.controller.active);
    assert.isTrue(Option.isSome(yield* f.controller.latest));
    assert.deepStrictEqual(f.starts[1], f.starts[0]);
  }),
);

it.live(
  "canceling a pending picture keeps the native capture and next screenshot behind restoration",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();

      yield* f.reader;
      yield* eventually(() => f.starts.length === 1);
      const reply = Promise.withResolvers<void>();
      const shot = yield* f.controller.excluding(f.picture(reply.promise)).pipe(Effect.forkChild);

      yield* eventually(() => f.shots() === 1);
      const interrupted = yield* Fiber.interrupt(shot).pipe(Effect.forkChild);

      const next = yield* f.controller
        .excluding(f.picture(Promise.resolve()))
        .pipe(Effect.forkChild);

      yield* Effect.sleep("30 millis");
      assert.strictEqual(f.starts.length, 1);
      assert.strictEqual(f.shots(), 1);
      reply.resolve();
      yield* Fiber.join(interrupted);
      yield* Fiber.join(next);
      assert.strictEqual(f.shots(), 2);
      assert.strictEqual(f.starts.length, 3);
      assert.isTrue(yield* f.controller.active);
    }),
);

it.live(
  "an unconfirmed picture ends capture boundedly and blocks later shots until actual settlement",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const reader = yield* f.reader;

      yield* eventually(() => f.starts.length === 1);
      const reply = Promise.withResolvers<void>();

      yield* Effect.addFinalizer(() => Effect.sync(() => reply.resolve()));
      const shot = yield* f.controller.excluding(f.picture(reply.promise)).pipe(Effect.forkChild);

      yield* eventually(() => f.shots() === 1);
      yield* Fiber.interrupt(shot).pipe(Effect.timeout("3 seconds"));
      assert.isFalse(yield* f.controller.active);
      const failure = yield* f.controller.excluding(f.picture(Promise.resolve())).pipe(Effect.flip);

      assert.match(failure.message, /restoration.*deadline/);
      assert.strictEqual(f.shots(), 1);
      assert.strictEqual(f.starts.length, 1);
      reply.resolve();
      yield* Fiber.join(reader).pipe(Effect.timeout("3 seconds"));
      yield* f.controller.excluding(f.picture(Promise.resolve()));
      assert.strictEqual(f.shots(), 2);
      assert.strictEqual(f.starts.length, 1);
    }),
);

it.live(
  "a failed pause never takes a picture, and a failed restart never reports picture success",
  () =>
    Effect.gen(function* () {
      for (const phase of ["stop", "start"] as const) {
        const f = yield* fixture();

        yield* f.reader;
        yield* eventually(() => f.starts.length === 1);
        const refuse = () => Promise.reject(new Error(`refused ${phase}`));

        if (phase === "stop") f.onStop(refuse);
        else f.onStart(refuse);
        const error = yield* f.controller.excluding(f.picture(Promise.resolve())).pipe(Effect.flip);

        assert.match(error.message, new RegExp(`refused ${phase}`));
        assert.strictEqual(f.shots(), phase === "stop" ? 0 : 1);
        assert.isFalse(yield* f.controller.active);
      }
    }),
);

it.live(
  "a stalled restart stays owned and prevents another start until its actual reply settles",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const reader = yield* f.reader;

      yield* eventually(() => f.starts.length === 1);
      const reply = Promise.withResolvers<void>();

      yield* Effect.addFinalizer(() => Effect.sync(() => reply.resolve()));
      f.onStart(() => reply.promise);
      const error = yield* f.controller.excluding(f.picture(Promise.resolve())).pipe(Effect.flip);

      assert.match(error.message, /deadline/);
      assert.isFalse(yield* f.controller.active);
      const next = yield* f.controller.excluding(f.picture(Promise.resolve())).pipe(Effect.flip);

      assert.match(next.message, /start.*deadline/);
      assert.strictEqual(f.starts.length, 2);
      assert.strictEqual(f.shots(), 1);
      reply.resolve();
      yield* Fiber.join(reader).pipe(Effect.timeout("3 seconds"));
    }),
);

it.live("the last reader leaving during viewport refresh revokes the queued restart", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const reader = yield* f.reader;

    yield* eventually(() => f.starts.length === 1);
    const reply = Promise.withResolvers<void>();
    let reading = false;

    f.onViewport(
      Effect.promise(() => {
        reading = true;

        return reply.promise.then(() => ({ width: 10, height: 10 }));
      }),
    );
    const shot = yield* f.controller.excluding(f.picture(Promise.resolve())).pipe(Effect.forkChild);

    yield* eventually(() => reading);
    const leaving = yield* Fiber.interrupt(reader).pipe(Effect.forkChild);

    yield* Effect.sleep("30 millis");
    reply.resolve();
    yield* Fiber.join(shot);
    yield* Fiber.join(leaving);
    assert.strictEqual(f.starts.length, 1);
    assert.isFalse(yield* f.controller.active);
  }),
);

it.live(
  "a queued reader receives fresh paint when the last old reader leaves during a picture",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const reader = yield* f.reader;

      yield* eventually(() => f.starts.length === 1);
      const reply = Promise.withResolvers<void>();

      yield* Effect.addFinalizer(() => Effect.sync(() => reply.resolve()));
      let reading = false;

      f.onViewport(
        Effect.promise(() => {
          reading = true;

          return reply.promise.then(() => ({ width: 10, height: 10 }));
        }),
      );

      const shot = yield* f.controller
        .excluding(f.picture(Promise.resolve()))
        .pipe(Effect.forkChild);

      yield* eventually(() => reading);

      // Queue the join before the old reader's cleanup, which removes its subscription immediately.
      const joining = yield* f.controller
        .stream({ quality: 10, size: { width: 10, height: 10 } })
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild({ startImmediately: true }));

      const leaving = yield* Fiber.interrupt(reader).pipe(
        Effect.forkChild({ startImmediately: true }),
      );

      yield* Effect.sleep("30 millis");
      assert.strictEqual(f.starts.length, 1);
      reply.resolve();
      yield* Fiber.join(shot);
      yield* Fiber.join(leaving);
      const frames = yield* Fiber.join(joining).pipe(Effect.timeout("500 millis"));

      assert.strictEqual(frames.length, 1);
      assert.strictEqual(f.starts.length, 2);
      assert.strictEqual(frames[0]?.timestamp, 2000);
      assert.deepStrictEqual(f.starts[1], f.starts[0]);
    }),
);

it.live(
  "closing the capture scope bounds an unfinished native picture and revokes any later restart",
  () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const f = yield* fixture().pipe(Scope.provide(scope));

      yield* f.reader.pipe(Scope.provide(scope));
      yield* eventually(() => f.starts.length === 1);
      const reply = Promise.withResolvers<void>();

      yield* Effect.addFinalizer(() => Effect.sync(() => reply.resolve()));
      yield* f.controller.excluding(f.picture(reply.promise)).pipe(Effect.forkIn(scope));
      yield* eventually(() => f.shots() === 1);
      yield* Scope.close(scope, Exit.void).pipe(Effect.timeout("3 seconds"));
      assert.isFalse(yield* f.controller.active);
      assert.strictEqual(f.starts.length, 1);
      reply.resolve();
      yield* Effect.sleep("30 millis");
      assert.strictEqual(f.starts.length, 1);
    }),
);

it.live(
  "canceling a pending restart retains its actual reply before any next screenshot or capture",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const reader = yield* f.reader;

      yield* eventually(() => f.starts.length === 1);
      const reply = Promise.withResolvers<void>();

      yield* Effect.addFinalizer(() => Effect.sync(() => reply.resolve()));
      f.onStart(() => reply.promise);

      const shot = yield* f.controller
        .excluding(f.picture(Promise.resolve()))
        .pipe(Effect.forkChild);

      yield* eventually(() => f.starts.length === 2);
      // Its quiet frame arrived before the held native start acknowledgement.
      assert.isTrue(Option.isSome(yield* f.controller.latest));
      yield* Fiber.interrupt(shot).pipe(Effect.timeout("3 seconds"));
      assert.isFalse(yield* f.controller.active);
      const error = yield* f.controller.excluding(f.picture(Promise.resolve())).pipe(Effect.flip);

      assert.match(error.message, /start.*deadline/);
      assert.strictEqual(f.shots(), 1);
      assert.strictEqual(f.starts.length, 2);
      reply.resolve();
      yield* Fiber.join(reader).pipe(Effect.timeout("3 seconds"));
      f.onStart(() => Promise.resolve());
      yield* f.controller.stream().pipe(Stream.take(1), Stream.runDrain);
      assert.strictEqual(f.starts.length, 3);
    }),
);
