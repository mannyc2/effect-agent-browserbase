import { assert, layer } from "@effect/vitest";
import { Clock, Deferred, Duration, Effect, Fiber, Random, Stream } from "effect";
import type { BrowserContext, CDPSession } from "playwright-core";

import { Browser, make as makeBrowser, type Service as BrowserService } from "../src/Browser.ts";
import * as Chromium from "../src/Chromium.ts";
import type { Page } from "../src/Page.ts";

interface NativeInput {
  readonly type?: string;
  readonly x?: number;
  readonly y?: number;
  readonly button?: string;
  readonly clickCount?: number;
  readonly deltaX?: number;
  readonly deltaY?: number;
  readonly key?: string;
  readonly text?: string;
}

interface Dispatch {
  readonly target: Parameters<BrowserContext["newCDPSession"]>[0];
  readonly method: string;
  readonly input: NativeInput;
  readonly at: number;
}

interface NativeEvent {
  readonly type: string;
  readonly key: string;
  readonly trusted: boolean;
}

interface RecordedWindow {
  readonly inputEvents: Array<NativeEvent>;
  clicks: number;
}

const setup = Effect.fnUntraced(function* (humanize = true) {
  const native = (yield* Browser).context.browser();
  const clock = yield* Clock.Clock;

  if (native === null) return yield* Effect.die("the fixture requires a launched Chromium");

  const context = yield* Effect.acquireRelease(
    Effect.promise(() => native.newContext({ viewport: { width: 800, height: 600 } })),
    (context) => Effect.promise(() => context.close()),
  );

  const createSession = context.newCDPSession.bind(context);
  const dispatches: Array<Dispatch> = [];
  const moved = Promise.withResolvers<void>();
  const pressed = Promise.withResolvers<void>();

  // Observe actual protocol dispatch without replacing Chromium or the provider's page registry.
  context.newCDPSession = async (target) => {
    const session = await createSession(target);
    const send = session.send.bind(session);

    const observed: CDPSession["send"] = (method, params) => {
      const input = params as NativeInput | undefined;

      if (method.startsWith("Input."))
        dispatches.push({
          target,
          method,
          input: input ?? {},
          at: Number(clock.monotonicTimeNanosUnsafe()) / 1e6,
        });

      return send(method, params).then((result) => {
        if (method === "Input.dispatchMouseEvent" && input?.type === "mouseMoved") moved.resolve();
        if (method === "Input.dispatchMouseEvent" && input?.type === "mousePressed")
          pressed.resolve();

        return result;
      });
    };

    session.send = observed;

    return session;
  };

  const browser = yield* makeBrowser(context, { id: "track-test", provider: "test" }, { humanize });

  const open = Effect.gen(function* () {
    const page = yield* browser.newPage();

    yield* Effect.promise(() =>
      page.playwright.setContent(
        '<body style="margin:0;height:1800px"><button style="position:absolute;left:80px;top:80px;width:160px;height:50px;cursor:crosshair">Count</button><input aria-label="Text" style="position:absolute;left:80px;top:220px;width:240px;height:40px;cursor:text"></body>',
      ),
    );
    yield* Effect.promise(() =>
      page.playwright.evaluate(() => {
        const recorded = window as unknown as RecordedWindow;

        Object.assign(recorded, { inputEvents: [], clicks: 0 });
        document.querySelector("button")?.addEventListener("click", () => {
          recorded.clicks += 1;
        });
        for (const type of ["keydown", "keyup", "mousedown", "mouseup"] as const)
          document.addEventListener(type, (event) => {
            recorded.inputEvents.push({
              type,
              key: event instanceof KeyboardEvent ? event.key : "",
              trusted: event.isTrusted,
            });
          });
      }),
    );

    return page;
  });

  return { browser, open, dispatches, moved: moved.promise, pressed: pressed.promise };
});

const nativeEvents = (page: Page) =>
  Effect.promise(() =>
    page.playwright.evaluate(() => (window as unknown as RecordedWindow).inputEvents),
  );

const replay = Effect.fnUntraced(function* (browser: BrowserService) {
  const recent = yield* browser.recentEvents;

  return yield* browser.events({ after: 0 }).pipe(Stream.take(recent.length), Stream.runCollect);
});

// The consumer needs one coherent track, including interrupted prefixes, to draw a cursor without
// inventing motion or leaving a pressed state onscreen. These checks pair that public track with
// real protocol dispatch and native DOM outcomes.
layer(Chromium.layer(), { excludeTestServices: true, timeout: Duration.seconds(60) })(
  "Track",
  (it) => {
    it.effect(
      "replays one shared pointer track across pages with the input that actually ran",
      () =>
        Effect.gen(function* () {
          const fixture = yield* setup();
          const first = yield* fixture.open;
          const second = yield* fixture.open;
          const button = { x: 150, y: 100 };
          const field = { x: 150, y: 240 };

          const subscribed = yield* Deferred.make<void>();
          const firstPlanned = yield* Deferred.make<void>();
          const livePlans: Array<{ readonly sequence: number; readonly submitted: number }> = [];

          const watching = yield* fixture.browser.events({ after: 0 }).pipe(
            Stream.runForEach((record) =>
              Effect.gen(function* () {
                if (record.event._tag === "PageOpened" && record.event.page === second.id)
                  yield* Deferred.succeed(subscribed, undefined);
                if (record.event._tag === "TrackPlanned") {
                  livePlans.push({
                    sequence: record.sequence,
                    submitted: fixture.dispatches.filter(
                      (dispatch) => dispatch.input.type === "mouseMoved",
                    ).length,
                  });
                  yield* Deferred.succeed(firstPlanned, undefined);
                }
              }),
            ),
            Effect.forkChild,
          );

          yield* Deferred.await(subscribed);

          const firstHover = yield* first
            .hover(button)
            .pipe(Random.withSeed("track-first"), Effect.forkChild);

          yield* Deferred.await(firstPlanned);

          const secondHover = yield* second
            .hover(field)
            .pipe(Random.withSeed("track-second"), Effect.forkChild);

          yield* Fiber.join(firstHover);
          yield* Fiber.join(secondHover);
          yield* first.click(button).pipe(Random.withSeed("track-click"));
          yield* Effect.promise(() => first.playwright.locator("input").focus());
          yield* first.type("Aé").pipe(Random.withSeed("track-type"));
          yield* first.press("ArrowLeft");

          const cursorCount = (yield* fixture.browser.recentEvents).filter(
            (event) => event._tag === "CursorChanged",
          ).length;

          yield* first.scroll({ dy: 240 });
          yield* Fiber.interrupt(watching);

          const records = yield* replay(fixture.browser);
          const plans = records.filter((record) => record.event._tag === "TrackPlanned");
          const terminals = records.filter((record) => record.event._tag === "TrackPerformed");
          const events = records.map((record) => record.event);

          const moves = fixture.dispatches.filter(
            (dispatch) => dispatch.input.type === "mouseMoved",
          );

          assert.strictEqual(plans.length, 4);
          assert.strictEqual(terminals.length, plans.length);
          assert.strictEqual(livePlans.length, plans.length);
          assert.isBelow(terminals[0]?.sequence ?? Infinity, plans[1]?.sequence ?? 0);
          const firstPlan = plans[0]?.event;

          assert.isDefined(firstPlan);
          if (firstPlan === undefined || firstPlan._tag !== "TrackPlanned") return;
          assert.closeTo(firstPlan.from.x, 400, 80);
          assert.closeTo(firstPlan.from.y, 300, 60);
          assert.deepStrictEqual(
            plans
              .slice(1)
              .map((record) =>
                record.event._tag === "TrackPlanned" ? record.event.from : undefined,
              ),
            [button, field, button],
          );
          assert.deepStrictEqual(
            plans.map(({ event }) => ("page" in event ? event.page : undefined)),
            [first.id, second.id, first.id, first.id],
          );

          let expectedMoves = 0;

          for (const [index, record] of plans.entries()) {
            const plan = record.event;

            if (plan._tag !== "TrackPlanned") continue;

            const terminal = terminals.find(
              (candidate) =>
                candidate.event._tag === "TrackPerformed" &&
                candidate.event.plan === record.sequence,
            )?.event;

            const last = plan.samples.at(-1);

            assert.isDefined(terminal);
            assert.isDefined(last);
            assert.isAbove(plan.samples.length, 0);
            assert.deepStrictEqual(
              plan.samples.map((sample) => sample.afterMillis),
              plan.samples
                .map((sample) => sample.afterMillis)
                .toSorted((left, right) => left - right),
            );
            assert.isTrue(
              plan.samples.every(
                (sample) =>
                  Number.isFinite(sample.afterMillis) &&
                  sample.afterMillis >= 0 &&
                  Number.isFinite(sample.x) &&
                  Number.isFinite(sample.y),
              ),
            );
            if (terminal === undefined || terminal._tag !== "TrackPerformed" || last === undefined)
              continue;
            assert.deepStrictEqual(livePlans[index], {
              sequence: record.sequence,
              submitted: expectedMoves,
            });
            assert.isTrue(terminal.complete);
            assert.strictEqual(terminal.dispatched, plan.samples.length);
            assert.deepStrictEqual({ x: terminal.x, y: terminal.y }, { x: last.x, y: last.y });
            assert.isAtLeast(terminal.at, plan.at);
            expectedMoves += terminal.dispatched;
          }
          assert.strictEqual(moves.length, expectedMoves);
          const cursors = events.filter((event) => event._tag === "CursorChanged");

          // Humanized scroll now inspects the wheel origin, so it can report the actual
          // center hit's cursor instead of carrying the previous button's crosshair forward.
          assert.deepStrictEqual(
            cursors.slice(cursorCount).map(({ page, cursor }) => ({ page, cursor })),
            [{ page: first.id, cursor: "auto" }],
          );
          assert.isTrue(
            cursors.some((event) => event.page === first.id && event.cursor === "crosshair"),
          );
          assert.isTrue(
            cursors.some((event) => event.page === second.id && event.cursor === "text"),
          );
          const presses = events.filter((event) => event._tag === "PointerPressed");
          const releases = events.filter((event) => event._tag === "PointerReleased");

          assert.deepStrictEqual(
            presses.map(({ x, y, button, clickCount }) => ({ x, y, button, clickCount })),
            [{ ...button, button: "left", clickCount: 1 }],
          );
          assert.deepStrictEqual(
            releases.map(({ x, y, button, clickCount }) => ({ x, y, button, clickCount })),
            [{ ...button, button: "left", clickCount: 1 }],
          );
          const wheels = events.filter((event) => event._tag === "WheelScrolled");

          const wheelDispatches = fixture.dispatches.filter(
            (dispatch) => dispatch.input.type === "mouseWheel",
          );

          assert.deepStrictEqual(
            wheels.map(({ x, y, dx, dy }) => ({ x, y, dx, dy })),
            wheelDispatches.map(({ input }) => ({
              x: input.x,
              y: input.y,
              dx: input.deltaX,
              dy: input.deltaY,
            })),
          );
          assert.strictEqual(
            wheels.reduce((sum, wheel) => sum + wheel.dy, 0),
            240,
          );
          assert.deepStrictEqual(
            events
              .filter((event) => event._tag === "KeyChanged")
              .map(({ key, phase }) => [key, phase]),
            [
              ["A", "down"],
              ["A", "up"],
              ["ArrowLeft", "down"],
              ["ArrowLeft", "up"],
            ],
          );
          assert.deepStrictEqual(
            events.filter((event) => event._tag === "TextInserted").map((event) => event.text),
            ["é"],
          );
          assert.strictEqual(
            yield* Effect.promise(() => first.playwright.locator("input").inputValue()),
            "Aé",
          );
          assert.strictEqual(
            yield* Effect.promise(() =>
              first.playwright.evaluate(() => (window as unknown as RecordedWindow).clicks),
            ),
            1,
          );
          assert.isAbove(
            yield* Effect.promise(() => first.playwright.evaluate(() => window.scrollY)),
            0,
          );
          assert.isTrue((yield* nativeEvents(first)).every((event) => event.trusted));
        }),
    );

    it.effect("ends an interrupted glide at its submitted prefix and resumes from that point", () =>
      Effect.gen(function* () {
        const fixture = yield* setup();
        const page = yield* fixture.open;

        const moving = yield* page
          .hover({ x: 760, y: 550 })
          .pipe(Random.withSeed("track-interrupt"), Effect.forkChild);

        yield* Effect.promise(() => fixture.moved);
        yield* Fiber.interrupt(moving);
        const before = yield* fixture.browser.recentEvents;
        const plan = before.find((event) => event._tag === "TrackPlanned");
        const terminal = before.find((event) => event._tag === "TrackPerformed");
        const moves = fixture.dispatches.filter((dispatch) => dispatch.input.type === "mouseMoved");
        const last = moves.at(-1)?.input;

        assert.isDefined(plan);
        assert.isDefined(terminal);
        assert.isDefined(last);
        if (plan === undefined || terminal === undefined || last === undefined) return;
        assert.isFalse(terminal.complete);
        assert.isAbove(terminal.dispatched, 0);
        assert.isBelow(terminal.dispatched, plan.samples.length);
        assert.strictEqual(terminal.dispatched, moves.length);
        assert.deepStrictEqual({ x: terminal.x, y: terminal.y }, { x: last.x, y: last.y });

        yield* page.hover({ x: 40, y: 40 }).pipe(Random.withSeed("track-resume"));
        const after = yield* replay(fixture.browser);
        const next = after.filter((record) => record.event._tag === "TrackPlanned")[1]?.event;

        assert.isDefined(next);
        if (next === undefined || next._tag !== "TrackPlanned") return;
        assert.deepStrictEqual(next.from, { x: terminal.x, y: terminal.y });
      }),
    );

    it.effect("rejects nonfinite input values before creating a track or dispatching input", () =>
      Effect.gen(function* () {
        const fixture = yield* setup(false);
        const page = yield* fixture.open;

        for (const operation of [
          page.scroll({ dy: Infinity }),
          page.scroll({ dx: Number.NaN }),
          page.click({ x: 150, y: 100 }, { clickCount: Number.NaN }),
          page.press("a", { times: Infinity }),
        ]) {
          const failure = yield* Effect.flip(operation);

          assert.strictEqual(failure.reason._tag, "InvalidRequest");
          assert.isFalse(failure.dispatched);
        }
        assert.isEmpty(fixture.dispatches);
        assert.isEmpty(
          (yield* fixture.browser.recentEvents).filter((event) => event._tag === "TrackPlanned"),
        );
      }),
    );

    it.effect("records interrupted mouse and key releases exactly once", () =>
      Effect.gen(function* () {
        const fixture = yield* setup(false);
        const page = yield* fixture.open;

        const clicking = yield* page
          .click({ x: 150, y: 100 }, { holdMillis: 5000 })
          .pipe(Effect.forkChild);

        yield* Effect.promise(() => fixture.pressed);
        yield* Fiber.interrupt(clicking);
        yield* Effect.promise(() => page.playwright.locator("input").focus());

        const pressing = yield* page
          .press("Shift+ArrowLeft", { holdMillis: 5000 })
          .pipe(Effect.forkChild);

        yield* Effect.promise(() =>
          page.playwright.waitForFunction(() =>
            (window as unknown as RecordedWindow).inputEvents.some(
              (event) => event.type === "keydown" && event.key === "ArrowLeft",
            ),
          ),
        );
        yield* Fiber.interrupt(pressing);
        yield* page.type("x");
        const events = yield* fixture.browser.recentEvents;

        // The caller interrupted both actions after their input reached the page.
        assert.deepStrictEqual(
          events.flatMap((event) =>
            event._tag === "Action" ? [[event.name, event.ok, event.dispatched, event.error]] : [],
          ),
          [
            ["click", false, true, "interrupted"],
            ["press", false, true, "interrupted"],
            ["type", true, true, undefined],
          ],
        );
        assert.strictEqual(events.filter((event) => event._tag === "PointerPressed").length, 1);
        assert.strictEqual(events.filter((event) => event._tag === "PointerReleased").length, 1);
        assert.deepStrictEqual(
          fixture.dispatches
            .filter((dispatch) =>
              ["mousePressed", "mouseReleased"].includes(dispatch.input.type ?? ""),
            )
            .map((dispatch) => dispatch.input.type),
          ["mousePressed", "mouseReleased"],
        );
        const changes = events.filter((event) => event._tag === "KeyChanged");

        assert.deepStrictEqual(
          changes.map(({ key, phase }) => [key, phase]),
          [
            ["Shift", "down"],
            ["ArrowLeft", "down"],
            ["ArrowLeft", "up"],
            ["Shift", "up"],
            ["x", "down"],
            ["x", "up"],
          ],
        );
        const observed = yield* nativeEvents(page);

        assert.deepStrictEqual(
          observed
            .filter((event) => event.type === "keydown" || event.type === "keyup")
            .map((event) => [event.key, event.type === "keydown" ? "down" : "up"]),
          changes.map(({ key, phase }) => [key, phase]),
        );
        assert.isTrue(observed.every((event) => event.trusted));
        assert.strictEqual(
          yield* Effect.promise(() => page.playwright.locator("input").inputValue()),
          "x",
        );
      }),
    );
  },
);
