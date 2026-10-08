import { setTimeout as sleep } from "node:timers/promises";

import { assert, layer } from "@effect/vitest";
import { Clock, Duration, Effect, Fiber, Random, Stream } from "effect";
import type { CDPSession } from "playwright-core";

import { Browser, make as makeBrowser } from "../src/Browser.ts";
import * as Chromium from "../src/Chromium.ts";
import * as Motion from "../src/Motion.ts";

interface NativeInput {
  readonly type?: string;
  readonly x?: number;
  readonly y?: number;
  readonly timestamp?: number;
}

interface Dispatch {
  readonly method: string;
  readonly input: NativeInput;
  readonly at: number;
  settledAt?: number;
}

const setup = Effect.fnUntraced(function* (
  motion: Motion.Service,
  replyDelayMillis = 0,
  humanize = true,
) {
  const native = (yield* Browser).context.browser();
  const clock = yield* Clock.Clock;
  const now = () => Number(clock.monotonicTimeNanosUnsafe()) / 1e6;

  if (native === null) return yield* Effect.die("the fixture requires a launched Chromium");

  const context = yield* Effect.acquireRelease(
    Effect.promise(() => native.newContext({ viewport: { width: 800, height: 600 } })),
    (context) => Effect.promise(() => context.close()),
  );

  const createSession = context.newCDPSession.bind(context);
  const dispatches: Array<Dispatch> = [];
  const moved = Promise.withResolvers<void>();
  let outstanding = 0;
  let maximumOutstanding = 0;

  // Chromium receives each original command immediately. Only its returned receipt is delayed,
  // reproducing a remote connection without replacing input dispatch or native browser behavior.
  context.newCDPSession = async (target) => {
    const session = await createSession(target);
    const send = session.send.bind(session);

    const observed: CDPSession["send"] = (method, params) => {
      if (!method.startsWith("Input.")) return send(method, params);

      const input = (params as NativeInput | undefined) ?? {};
      const dispatch: Dispatch = { method, input, at: now() };

      dispatches.push(dispatch);
      outstanding++;
      maximumOutstanding = Math.max(maximumOutstanding, outstanding);

      return send(method, params)
        .then(async (result) => {
          if (input.type === "mouseMoved") moved.resolve();
          if (replyDelayMillis > 0) await sleep(replyDelayMillis);

          return result;
        })
        .finally(() => {
          dispatch.settledAt = now();
          outstanding--;
        });
    };

    session.send = observed;

    return session;
  };

  const browser = yield* makeBrowser(
    context,
    { id: "motion-test", provider: "test" },
    { humanize },
  ).pipe(Effect.provideService(Motion.Motion, motion));

  const open = Effect.gen(function* () {
    const page = yield* browser.newPage();

    yield* Effect.promise(() =>
      page.playwright.setContent('<body style="margin:0;width:800px;height:600px"></body>'),
    );

    return page;
  });

  return {
    browser,
    open,
    dispatches,
    moved: moved.promise,
    maximumOutstanding: () => maximumOutstanding,
  };
});

layer(Chromium.layer(), { excludeTestServices: true, timeout: Duration.seconds(60) })(
  "Motion integration",
  (it) => {
    it.effect("captures the planner once for every page and bypasses it for plain input", () =>
      Effect.gen(function* () {
        const planned: Array<{ readonly from: Motion.Point; readonly to: Motion.Point }> = [];
        let lateCalls = 0;

        const fixture = yield* setup({
          plan: (from, to) =>
            Effect.sync(() => {
              planned.push({ from, to });

              return [
                { ...from, afterMillis: 0 },
                { ...to, afterMillis: 5 },
              ];
            }),
        });

        const late: Motion.Service = {
          plan: (_from, to) =>
            Effect.sync(() => {
              lateCalls++;

              return [{ ...to, afterMillis: 0 }];
            }),
        };

        const first = yield* fixture.open.pipe(Effect.provideService(Motion.Motion, late));
        const second = yield* fixture.open.pipe(Effect.provideService(Motion.Motion, late));
        const firstTarget = { x: 100, y: 100 };
        const secondTarget = { x: 650, y: 450 };

        yield* first.hover(firstTarget).pipe(Effect.provideService(Motion.Motion, late));
        yield* second.hover(secondTarget).pipe(Effect.provideService(Motion.Motion, late));

        assert.strictEqual(lateCalls, 0);
        // Each page's pointer starts mid-viewport.
        assert.deepStrictEqual(planned, [
          { from: { x: 400, y: 300 }, to: firstTarget },
          { from: { x: 400, y: 300 }, to: secondTarget },
        ]);
        assert.strictEqual(fixture.dispatches.length, 4);

        let plainCalls = 0;

        const plain = yield* setup(
          {
            plan: (_from, to) =>
              Effect.sync(() => {
                plainCalls++;

                return [{ ...to, afterMillis: 0 }];
              }),
          },
          0,
          false,
        );

        const page = yield* plain.open;

        yield* page.hover(firstTarget);
        assert.strictEqual(plainCalls, 0);
        assert.strictEqual(plain.dispatches.length, 1);
      }),
    );

    it.effect("rejects an invalid complete schedule before publishing or submitting input", () =>
      Effect.gen(function* () {
        let current: (to: Motion.Point) => ReadonlyArray<Motion.Sample> = () => [];
        const fixture = yield* setup({ plan: (_from, to) => Effect.sync(() => current(to)) });
        const page = yield* fixture.open;

        const invalid: ReadonlyArray<(to: Motion.Point) => ReadonlyArray<Motion.Sample>> = [
          () => [],
          (to) => {
            const samples: Array<Motion.Sample> = [];

            samples[1] = { ...to, afterMillis: 0 };

            return samples;
          },
          (to) =>
            Array.from({ length: Motion.maximumSamples + 1 }, () => ({ ...to, afterMillis: 0 })),
          (to) => [
            { ...to, afterMillis: 20 },
            { ...to, afterMillis: 10 },
          ],
          (to) => [
            { ...to, x: Number.NaN, afterMillis: 0 },
            { ...to, afterMillis: 1 },
          ],
          (to) => [{ ...to, afterMillis: Number.NaN }],
          (to) => [{ ...to, afterMillis: -1 }],
          (to) => [{ ...to, x: to.x + 1, afterMillis: 0 }],
          (to) => [{ ...to, afterMillis: Motion.maximumDurationMillis + 1 }],
        ];

        for (const plan of invalid) {
          current = plan;
          const failure = yield* Effect.flip(page.hover({ x: 100, y: 100 }));

          assert.strictEqual(failure.reason._tag, "InvalidRequest");
          assert.isFalse(failure.dispatched);
        }
        assert.isEmpty(fixture.dispatches);
        assert.isEmpty(
          (yield* fixture.browser.recentEvents).filter((event) => event._tag === "TrackPlanned"),
        );
      }),
    );

    it.effect("publishes and performs exactly the copy it checked", () =>
      Effect.gen(function* () {
        let reads = 0;
        const second = { x: 500, y: 300, afterMillis: 40 };

        const fixture = yield* setup({
          plan: (_from, to) =>
            Effect.gen(function* () {
              // An accessor may answer differently on each read, and the planner keeps a
              // reference it changes while the glide is still in progress.
              const first = {
                get x() {
                  reads++;

                  return reads === 1 ? 450 : Number.NaN;
                },
                y: 300,
                afterMillis: 0,
              };

              yield* Effect.sleep(Duration.millis(10)).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    second.x = Number.NaN;
                  }),
                ),
                Effect.forkDetach,
              );

              return [first, second, { ...to, afterMillis: 80 }];
            }),
        });

        const page = yield* fixture.open;

        yield* page.hover({ x: 550, y: 300 });

        const plan = (yield* fixture.browser.recentEvents).find(
          (event) => event._tag === "TrackPlanned",
        );

        const expected = [
          { x: 450, y: 300, afterMillis: 0 },
          { x: 500, y: 300, afterMillis: 40 },
          { x: 550, y: 300, afterMillis: 80 },
        ];

        assert.strictEqual(reads, 1);
        assert.isNaN(second.x);
        assert.ok(plan?._tag === "TrackPlanned");
        assert.deepStrictEqual(plan.samples, expected);
        assert.deepStrictEqual(
          fixture.dispatches.map(({ input }) => ({ x: input.x, y: input.y })),
          expected.map(({ x, y }) => ({ x, y })),
        );
      }),
    );

    it.effect("moves the pointer with every default sample except a repeated exact endpoint", () =>
      Effect.gen(function* () {
        const fixture = yield* setup(yield* Motion.Motion);
        const page = yield* fixture.open;

        const record = Effect.promise(() =>
          page.playwright.evaluate(() => {
            const moves: Array<{ x: number; y: number; dx: number; dy: number }> = [];

            (window as unknown as { moves: typeof moves }).moves = moves;
            document.addEventListener("mousemove", (event) =>
              moves.push({
                x: event.clientX,
                y: event.clientY,
                dx: event.movementX,
                dy: event.movementY,
              }),
            );
          }),
        );

        // Rendering may deliver the last mousemove after the native reply; wait for the endpoint.
        const take = (target: Motion.Point) =>
          Effect.promise(async () => {
            await page.playwright.waitForFunction(
              ([x, y]) => {
                const moves = (window as unknown as { moves: Array<{ x: number; y: number }> })
                  .moves;

                return moves.at(-1)?.x === x && moves.at(-1)?.y === y;
              },
              [target.x, target.y],
            );

            return page.playwright.evaluate(() => {
              const recorded = window as unknown as {
                moves: Array<{ x: number; y: number; dx: number; dy: number }>;
              };

              return recorded.moves.splice(0);
            });
          });

        // A page's first mousemove has no previous position, so its movement is 0 by definition
        // (Chromium 153 reports it that way). Place the pointer before recording.
        yield* page.hover({ x: 640, y: 360 });
        yield* record;

        const targets = [
          { x: 440, y: 310 },
          { x: 700, y: 500 },
          { x: 120, y: 80 },
          { x: 126, y: 84 },
        ];

        for (const [index, target] of targets.entries()) {
          const sent = fixture.dispatches.length;

          yield* page.hover(target).pipe(Random.withSeed(`glide ${index}`));

          const plan = (yield* fixture.browser.recentEvents).findLast(
            (event) => event._tag === "TrackPlanned",
          );

          assert.ok(plan?._tag === "TrackPlanned");
          const positions = [plan.from, ...plan.samples.slice(0, -1)];

          // Native input: each move but the exact endpoint reaches a new integer position.
          const moves = fixture.dispatches.slice(sent).map(({ input }) => input);

          assert.deepStrictEqual(
            moves.map(({ x, y }) => ({ x, y })),
            plan.samples.map(({ x, y }) => ({ x, y })),
          );
          for (const [step, move] of moves.slice(0, -1).entries())
            assert.isTrue(move.x !== positions[step]!.x || move.y !== positions[step]!.y);
          assert.deepStrictEqual({ x: moves.at(-1)?.x, y: moves.at(-1)?.y }, target);

          // Chromium may coalesce moves within a frame, so a stationary DOM event could only come
          // from a glide that revisits a pixel. These seeded glides do not, which makes the page's
          // view exact: every mousemove moves the pointer except possibly the final one.
          const distinct = new Set(positions.map(({ x, y }) => `${x},${y}`));

          assert.strictEqual(distinct.size, positions.length);
          const dom = yield* take(target);

          for (const event of dom.slice(0, -1)) assert.isTrue(event.dx !== 0 || event.dy !== 0);
        }
      }),
    );

    for (const replyDelayMillis of [70, 320]) {
      it.effect(
        `submits every dense original sample on schedule with ${replyDelayMillis}ms replies`,
        () =>
          Effect.gen(function* () {
            let original: ReadonlyArray<Motion.Sample> = [];

            const fixture = yield* setup(
              {
                plan: (from, to) =>
                  Effect.sync(() => {
                    original = Array.from({ length: 270 }, (_, index) => ({
                      x: from.x + ((to.x - from.x) * (index + 1)) / 270,
                      y: from.y + ((to.y - from.y) * (index + 1)) / 270,
                      afterMillis: Math.floor(index / 3),
                    }));

                    return original;
                  }),
              },
              replyDelayMillis,
            );

            const page = yield* fixture.open;

            // A capture maps the browser's clock, so each sample carries the time it was meant for.
            yield* page.screencast().pipe(Stream.take(1), Stream.runDrain);
            yield* page.hover({ x: 670, y: 490 });
            const events = yield* fixture.browser.recentEvents;
            const plan = events.find((event) => event._tag === "TrackPlanned");
            const terminal = events.find((event) => event._tag === "TrackPerformed");

            const moves = fixture.dispatches.filter(
              (dispatch) => dispatch.input.type === "mouseMoved",
            );

            assert.isDefined(plan);
            assert.isDefined(terminal);
            if (plan === undefined || terminal === undefined) return;
            assert.deepStrictEqual(plan.samples, original);
            assert.deepStrictEqual(
              moves.map(({ input }) => ({ x: input.x, y: input.y })),
              original.map(({ x, y }) => ({ x, y })),
            );
            assert.isTrue(terminal.complete);
            assert.strictEqual(terminal.dispatched, original.length);
            assert.isAbove(fixture.maximumOutstanding(), 64);
            assert.isAtMost(fixture.maximumOutstanding(), Motion.maximumSamples + 64);

            // The 65th sample must pass the old receipt ceiling before even the first reply.
            // Equal offsets are intentional: neither coalescing nor reply pacing is permitted.
            assert.isBelow(moves[64]?.at ?? Infinity, moves[0]?.settledAt ?? 0);
            for (const [index, sample] of original.entries()) {
              const dispatch = moves[index];
              const timestamp = dispatch?.input.timestamp;

              assert.isDefined(dispatch);
              assert.isDefined(timestamp);
              if (dispatch === undefined || timestamp === undefined) continue;
              assert.isAtLeast(dispatch.at, plan.at + sample.afterMillis - 2);
              assert.isBelow(dispatch.at - plan.at - sample.afterMillis, 100);
              if (index > 0)
                assert.isAtLeast(timestamp, moves[index - 1]?.input.timestamp ?? Infinity);
            }
          }),
      );
    }

    it.effect("clips cancellation to the native submitted prefix and resumes from that point", () =>
      Effect.gen(function* () {
        let interrupted = true;

        const fixture = yield* setup({
          plan: (from, to) =>
            Effect.sync(() =>
              interrupted
                ? [
                    { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2, afterMillis: 0 },
                    { x: (from.x + 3 * to.x) / 4, y: (from.y + 3 * to.y) / 4, afterMillis: 300 },
                    { ...to, afterMillis: 1000 },
                  ]
                : [{ ...to, afterMillis: 0 }],
            ),
        });

        const page = yield* fixture.open;
        const moving = yield* page.hover({ x: 700, y: 500 }).pipe(Effect.forkChild);

        yield* Effect.promise(() => fixture.moved);
        yield* Fiber.interrupt(moving);
        const events = yield* fixture.browser.recentEvents;
        const plan = events.find((event) => event._tag === "TrackPlanned");
        const terminal = events.find((event) => event._tag === "TrackPerformed");

        const prefix = fixture.dispatches.filter(
          (dispatch) => dispatch.input.type === "mouseMoved",
        );

        assert.isDefined(plan);
        assert.isDefined(terminal);
        if (plan === undefined || terminal === undefined) return;
        assert.strictEqual(plan.samples.length, 3);
        assert.isFalse(terminal.complete);
        assert.strictEqual(terminal.dispatched, 1);
        assert.strictEqual(prefix.length, 1);
        assert.deepStrictEqual(
          { x: terminal.x, y: terminal.y },
          { x: prefix[0]?.input.x, y: prefix[0]?.input.y },
        );

        yield* Effect.sleep(Duration.millis(1050));
        assert.strictEqual(fixture.dispatches.length, 1);
        interrupted = false;
        yield* page.hover({ x: 50, y: 50 });

        const next = (yield* fixture.browser.recentEvents).filter(
          (event) => event._tag === "TrackPlanned",
        )[1];

        assert.isDefined(next);
        if (next !== undefined) assert.deepStrictEqual(next.from, { x: terminal.x, y: terminal.y });
      }),
    );
  },
);
