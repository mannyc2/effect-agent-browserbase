// Independent review found Semaphore permits a fresh caller to overtake a queued reveal.
// Scripted public capture streams hold cleanup precisely; Chromium cannot reliably force this race.
import { assert, it } from "@effect/vitest";
import { Clock, Deferred, Effect, Exit, Fiber, Option, Scope, Stream } from "effect";
import type * as Browser from "effect-browser/Browser";
import { Frame, Screenshot } from "effect-browser/Frame";
import type { Page } from "effect-browser/Page";
import * as Supervisor from "effect-browser/Supervisor";

import * as Watched from "../Watched.ts";

it.live(
  "a queued reveal precedes the current caller's next reveal and retains the right page",
  () =>
    Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      const browser = { disconnected: Effect.never } as unknown as Browser.Service;

      const sessions = yield* Supervisor.make({
        open: Effect.succeed({ browser, value: undefined }),
      });

      const watched = yield* Watched.make(sessions);
      const closing = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const order: Array<string> = [];
      const closed: Array<string> = [];

      const prepare = Effect.fnUntraced(function* (id: string, release = Effect.void) {
        const hold = yield* Scope.fork(yield* Effect.scope);
        const at = Number(clock.monotonicTimeNanosUnsafe()) / 1e6;

        yield* Scope.addFinalizer(
          hold,
          Effect.sync(() => void closed.push(id)),
        );

        const frame = new Frame({
          page: id,
          session: "fixture",
          connection: "fixture-connection",
          document: 0,
          url: "https://fixture.test",
          data: new Uint8Array(),
          width: 1,
          height: 1,
          receivedAt: at,
          timing: new Screenshot({ hostTime: at, uncertaintyMillis: 0 }),
        });

        // Only the public custom-page capture path is used by reveal.
        const page = {
          id,
          playwright: { isClosed: () => false },
          screencast: () =>
            Stream.concat(Stream.succeed(frame), Stream.never).pipe(Stream.ensuring(release)),
        } as unknown as Page;

        return {
          id,
          page,
          browser,
          generation: 1,
          value: undefined,
          hold,
        } satisfies Watched.Prepared<void>;
      });

      yield* watched.output.pipe(
        Stream.filter((event) => event._tag === "Painted" && event.frame.page !== "old"),
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (event._tag === "Painted") order.push(event.frame.page);
          }),
        ),
        Effect.forkScoped,
      );

      const old = yield* prepare(
        "old",
        Deferred.succeed(closing, undefined).pipe(Effect.andThen(Deferred.await(finish))),
      );

      const sent = Effect.sync(() => Option.some(Number(clock.monotonicTimeNanosUnsafe()) / 1e6));

      yield* watched.reveal(old, sent);
      const a = yield* prepare("A");
      const b = yield* prepare("B");
      const c = yield* prepare("C");

      const cSent = yield* Deferred.make<Option.Option<number>>();
      const later = yield* watched.reveal(c, Deferred.await(cSent)).pipe(Effect.forkChild);

      const chained = yield* watched
        .reveal(a, sent)
        .pipe(
          Effect.andThen(sent.pipe(Effect.flatMap((at) => Deferred.succeed(cSent, at)))),
          Effect.forkChild,
        );

      yield* Deferred.await(closing);
      const queued = yield* watched.reveal(b, sent).pipe(Effect.forkChild);

      yield* Effect.sleep("30 millis");
      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.join(chained);
      yield* Fiber.join(queued);
      yield* Fiber.join(later);
      yield* Effect.yieldNow;
      assert.deepStrictEqual(order, ["A", "B", "C"]);
      assert.strictEqual(Option.getOrThrow(yield* watched.current).id, "C");
      assert.deepStrictEqual(closed, ["old", "A", "B"]);
      yield* Scope.close(c.hold, Exit.void);
    }).pipe(Effect.scoped),
);
