import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Schema, Stream } from "effect";

import { PageOpened, RecordedEvent, TrackPerformed, TrackPlanned } from "../src/BrowserEvent.ts";
import * as Timeline from "../src/internal/timeline/events.ts";

const opened = (at: number) => new PageOpened({ at, page: "p1", url: "about:blank" });

describe("Timeline", () => {
  it.effect("replays retained events in sequence and resumes after an exact cursor", () =>
    Effect.gen(function* () {
      const timeline = Timeline.make(3);

      for (let at = 1; at <= 4; at++) assert.strictEqual(timeline.publish(opened(at)), at);
      const recent = yield* timeline.recent;
      const replay = yield* timeline.stream(1).pipe(Stream.take(3), Stream.runCollect);
      const resumed = yield* timeline.stream(3).pipe(Stream.take(1), Stream.runCollect);

      assert.deepStrictEqual(
        recent.map((record) => record.sequence),
        [2, 3, 4],
      );
      assert.deepStrictEqual(replay, recent);
      assert.deepStrictEqual(resumed, recent.slice(-1));
      const expired = yield* timeline.stream(0).pipe(Stream.runCollect, Effect.flip);

      assert.strictEqual(expired.reason._tag, "EventHistoryExpired");
      assert.isFalse(expired.dispatched);
      if (expired.reason._tag !== "EventHistoryExpired") return yield* Effect.die("wrong reason");
      assert.deepStrictEqual(
        {
          after: expired.reason.after,
          oldest: expired.reason.oldest,
          latest: expired.reason.latest,
        },
        { after: 0, oldest: 2, latest: 4 },
      );
      yield* timeline.close;
    }),
  );

  it.effect(
    "fails a lagging reader explicitly while publication stays bounded and nonblocking",
    () =>
      Effect.gen(function* () {
        const timeline = Timeline.make(3);
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();

        timeline.publish(opened(1));

        const reader = yield* timeline.stream(0).pipe(
          Stream.tap(() =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
          ),
          Stream.runCollect,
          Effect.flip,
          Effect.forkChild,
        );

        yield* Deferred.await(entered);
        for (let at = 2; at <= 5; at++) timeline.publish(opened(at));
        assert.deepStrictEqual(
          (yield* timeline.recent).map((record) => record.sequence),
          [3, 4, 5],
        );
        yield* Deferred.succeed(release, undefined);
        const error = yield* Fiber.join(reader);

        assert.strictEqual(error.reason._tag, "EventHistoryExpired");
        if (error.reason._tag !== "EventHistoryExpired") return yield* Effect.die("wrong reason");
        assert.strictEqual(error.reason.after, 1);
        assert.strictEqual(error.reason.oldest, 3);
        yield* timeline.close;
      }),
  );

  it.effect("closes waiting readers and keeps the retained tail available for finite replay", () =>
    Effect.gen(function* () {
      const timeline = Timeline.make(3);
      const entered = yield* Deferred.make<void>();
      const future = timeline.stream();

      timeline.publish(opened(1));

      const reader = yield* timeline.stream(0).pipe(
        Stream.tap(() => Deferred.succeed(entered, undefined)),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* Deferred.await(entered);
      yield* Effect.yieldNow;
      yield* timeline.close;
      assert.deepStrictEqual(
        (yield* Fiber.join(reader)).map((record) => record.sequence),
        [1],
      );
      assert.isEmpty(yield* future.pipe(Stream.runCollect));
      assert.strictEqual(timeline.publish(opened(2)), 1);
      assert.deepStrictEqual(
        (yield* timeline.stream(0).pipe(Stream.runCollect)).map((record) => record.sequence),
        [1],
      );
    }),
  );

  it.effect("rejects malformed and future replay cursors before waiting", () =>
    Effect.gen(function* () {
      const timeline = Timeline.make(3);

      for (const after of [-1, 0.5, Number.NaN, Infinity, 1]) {
        const error = yield* timeline.stream(after).pipe(Stream.runCollect, Effect.flip);

        assert.strictEqual(error.reason._tag, "InvalidRequest");
        assert.isFalse(error.dispatched);
      }
      yield* timeline.close;
    }),
  );

  it.effect(
    "serializes a planned track and its canceled submitted prefix through the public schema",
    () =>
      Effect.gen(function* () {
        const timeline = Timeline.make(3);

        const plan = timeline.publish(
          new TrackPlanned({
            at: 1000,
            page: "p1",
            from: { x: 640, y: 360 },
            samples: [
              { afterMillis: 20, x: 650, y: 360 },
              { afterMillis: 40, x: 660, y: 360 },
            ],
          }),
        );

        timeline.publish(
          new TrackPerformed({
            at: 1025,
            page: "p1",
            plan,
            dispatched: 1,
            x: 650,
            y: 360,
            complete: false,
          }),
        );
        const records = yield* timeline.recent;
        const codec = Schema.fromJsonString(Schema.Array(RecordedEvent));
        const encoded = yield* Schema.encodeEffect(codec)(records);
        const decoded = yield* Schema.decodeEffect(codec)(encoded);

        assert.deepStrictEqual(decoded, records);
        assert.strictEqual(decoded[1]?.event._tag, "TrackPerformed");
        yield* timeline.close;
      }),
  );
});
