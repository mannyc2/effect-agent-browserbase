// PLAN input regressions through the public page and real local Chromium.
import { assert, it } from "@effect/vitest";
import { Clock, Deferred, Effect, Exit, Fiber, Option, Queue, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";

import { failFast } from "../src/Page.ts";
import * as Presentation from "../src/presentation/Presentation.ts";
import * as Stage from "../src/presentation/Stage.ts";
import * as Chromium from "../src/providers/Chromium.ts";
import * as Style from "../src/Style.ts";
import { unpaused } from "./fixtures.ts";
import * as TestCdp from "./support/TestCdp.ts";

const html = (source: string) => `data:text/html,${encodeURIComponent(source)}`;

it.live("a focus handler's effect survives a refused press receipt", () =>
  Effect.gen(function* () {
    const browser = yield* Chromium.open();

    const page = yield* browser.newPage(
      html("<button onfocus=\"document.title='focused';this.blur()\">Action</button>"),
    );

    const [button] = yield* page.find({ role: "button", name: "Action" });

    assert.isDefined(button);
    const error = yield* page.press("Enter", { on: button!.ref }).pipe(Effect.flip);

    assert.strictEqual(yield* page.title, "focused");
    assert.strictEqual(error.reason._tag, "NotActionable");
    assert.isTrue(error.dispatched, "focusing already ran page handlers");
  }).pipe(Effect.scoped),
);

it.effect(
  "a policy hold leaves the hand free and acquisition obeys failFast and its wait bound",
  () =>
    Effect.gen(function* () {
      const holding = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const acquiring = yield* Deferred.make<void>();
      const checkingFast = yield* Deferred.make<void>();
      let heldPage = "";
      let inspections = 0;

      const browser = yield* Chromium.open({
        actionTimeout: "200 millis",
        guard: (request) =>
          Effect.suspend(() => {
            if (request.page !== heldPage || request.action._tag !== "Hover") return Effect.void;
            inspections++;
            if (inspections === 2) return Deferred.succeed(checkingFast, undefined);
            if (inspections === 3) return Deferred.succeed(acquiring, undefined);
            if (inspections !== 1) return Effect.void;

            return Deferred.succeed(holding, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
            );
          }),
      });

      const first = yield* browser.newPage(html("<button>First</button>"));
      const next = yield* browser.newPage(html("<button>Next</button>"));

      const presenter = yield* Presentation.make({
        pacing: unpaused,
        motion: { plan: (_from, to) => Effect.succeed([{ ...to, afterMillis: 700 }]) },
      });

      const plans = yield* Queue.unbounded<void>();

      yield* browser.events().pipe(
        Stream.filter(({ event }) => event._tag === "TrackPlanned"),
        Stream.runForEach(() => Queue.offer(plans, undefined)),
        Effect.forkScoped,
      );
      heldPage = first.id;
      const waiting = yield* presenter.view(first).hover({ x: 30, y: 20 }).pipe(Effect.forkChild);

      yield* Deferred.await(holding);

      // Real protocol setup is independent of virtual action time. Each plan publication is
      // the boundary proving the hand was acquired, so no wall-clock sleep guesses ownership.
      const independent = yield* presenter
        .view(next)
        .hover({ x: 200, y: 150 })
        .pipe(Effect.forkChild);

      yield* Queue.take(plans);
      yield* TestClock.adjust("700 millis");
      yield* Fiber.join(independent);
      const active = yield* presenter.view(next).hover({ x: 210, y: 150 }).pipe(Effect.forkChild);

      yield* Queue.take(plans);

      const refused = yield* presenter
        .view(first)
        .hover({ x: 20, y: 20 })
        .pipe(failFast, Effect.flip, Effect.forkChild);

      yield* Deferred.await(checkingFast);
      yield* TestClock.adjust(0);
      assert.isDefined(refused.pollUnsafe(), "failFast must refuse without waiting for the hand");

      const bounded = yield* presenter
        .view(first)
        .hover({ x: 20, y: 20 })
        .pipe(Effect.flip, Effect.forkChild);

      yield* Deferred.await(acquiring);
      yield* TestClock.adjust("200 millis");
      assert.strictEqual((yield* Fiber.join(refused)).reason._tag, "Busy");
      assert.isDefined(bounded.pollUnsafe(), "hand acquisition must finish within its action wait");
      assert.strictEqual((yield* Fiber.join(bounded)).reason._tag, "Busy");
      yield* TestClock.adjust("500 millis");
      yield* Fiber.join(active);
      yield* Deferred.succeed(release, undefined);
      yield* Queue.take(plans);
      yield* TestClock.adjust("700 millis");
      yield* Fiber.join(waiting);
    }).pipe(Effect.scoped),
);

it.live("oversized presentation refuses before focus handlers or pointer input", () =>
  Effect.gen(function* () {
    const browser = yield* Chromium.open();

    const page = yield* browser.newPage(
      html('<input aria-label="Text" onfocus="document.title=\'focused\'">'),
    );

    const [field] = yield* page.find({ role: "textbox", name: "Text" });
    const view = (yield* Presentation.make({ pacing: unpaused })).view(page);
    const type = yield* view.type("a".repeat(2000), { into: field!.ref }).pipe(Effect.flip);
    const scroll = yield* view.scroll({ dy: 1_000_000 }).pipe(Effect.flip);

    for (const error of [type, scroll]) {
      assert.strictEqual(error.reason._tag, "InvalidRequest");
      assert.isFalse(error.dispatched);
    }
    assert.strictEqual(yield* page.title, "");
    assert.strictEqual(
      yield* page
        .read(() => document.querySelector("input")?.value ?? "", {
          arg: undefined,
          result: Schema.String,
        })
        .pipe(Effect.map(({ value }) => value)),
      "",
    );
  }).pipe(Effect.scoped),
);

it.live("custom styles are decoded before focus or pointer input", () =>
  Effect.gen(function* () {
    const browser = yield* Chromium.open();

    const page = yield* browser.newPage(
      html('<input aria-label="Text" onfocus="document.title=\'focused\'">'),
    );

    const [field] = yield* page.find({ role: "textbox", name: "Text" });

    const badTyping: Style.Style = {
      ...Style.plain,
      typing: () =>
        Effect.succeed([
          { phase: "down", key: "a", afterMillis: 10 },
          { phase: "up", key: "a", afterMillis: 0 },
        ]),
    };

    const badWheel: Style.Style = {
      ...Style.plain,
      wheel: () => Effect.succeed([{ dx: 0, dy: 20, afterMillis: -1 }]),
    };

    for (const action of [
      page.type("a", { into: field!.ref }).pipe(Style.provide(badTyping), Effect.asVoid),
      page.scroll({ dy: 20 }).pipe(Style.provide(badWheel)),
    ]) {
      const result = yield* action.pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(result), "a malformed custom schedule must be refused");
      const error = Exit.findErrorOption(result);

      assert.isTrue(Option.isSome(error), "style failures must stay typed");
      if (Option.isSome(error)) {
        assert.strictEqual(error.value.reason._tag, "InvalidRequest");
        assert.isFalse(error.value.dispatched);
      }
    }
    assert.strictEqual(yield* page.title, "");
    assert.isFalse(
      (yield* page.recentEvents).some(
        (event) => event._tag === "PointerPressed" || event._tag === "WheelScrolled",
      ),
    );
  }).pipe(Effect.scoped),
);

it.live("settlement preserves a protocol failure after acknowledged input", () =>
  Effect.gen(function* () {
    const faults = yield* TestCdp.make();

    faults.rule(
      { method: "Runtime.evaluate", script: "settle" },
      { _tag: "Fail", error: new Error("settle protocol failed") },
    );
    const browser = yield* faults.provide(Chromium.open());
    const page = yield* browser.newPage(html("<button>Press</button>"));
    const [button] = yield* page.find({ role: "button", name: "Press" });
    const error = yield* page.click(button!.ref).pipe(Effect.flip);

    assert.strictEqual(error.reason._tag, "Failed");
    assert.isTrue(error.dispatched);
  }).pipe(Effect.scoped),
);

it.live("presentation and future cuts run on the page clock under a suspended caller clock", () =>
  Effect.gen(function* () {
    const browser = yield* Chromium.open();
    const page = yield* browser.newPage(html("<button>Clock</button>"));

    const caller = Object.assign(Object.create(page.clock) as Clock.Clock, {
      monotonicTimeNanosUnsafe: () => 0n,
      sleep: () => Effect.never,
    });

    const presenter = yield* Presentation.make({
      pacing: { ...unpaused, unrelated: "10 millis" },
    }).pipe(Effect.provideService(Clock.Clock, caller));

    const view = presenter.view(page);

    yield* view
      .hover({ x: 100, y: 100 })
      .pipe(Effect.provideService(Clock.Clock, caller), Effect.timeout("2 seconds"));
    const stage = yield* Stage.make().pipe(Effect.provideService(Clock.Clock, caller));
    const asked = (yield* browser.now) + 30;

    const presented = yield* stage
      .present(view, { at: asked })
      .pipe(Effect.provideService(Clock.Clock, caller), Effect.timeout("3 seconds"));

    assert.isAtLeast(presented.at, asked);
    assert.strictEqual(presented.latency, presented.at - asked);
    assert.deepStrictEqual(yield* stage.current, Option.some(view));
  }).pipe(Effect.scoped),
);

it.effect("interrupts a waiting presenter before the occupied hand is released", () =>
  Effect.gen(function* () {
    const judged = yield* Deferred.make<void>();
    let waitingPage = "";

    const browser = yield* Chromium.open({
      actionTimeout: "30 seconds",
      guard: (request) =>
        request.page === waitingPage ? Deferred.succeed(judged, undefined) : Effect.void,
    });

    const first = yield* browser.newPage(html("<button>First</button>"));
    const next = yield* browser.newPage(html("<button>Next</button>"));

    const presenter = yield* Presentation.make({
      pacing: unpaused,
      motion: { plan: (_from, to) => Effect.succeed([{ ...to, afterMillis: 700 }]) },
    });

    const plans = yield* Queue.unbounded<void>();

    yield* browser.events().pipe(
      Stream.filter(({ event }) => event._tag === "TrackPlanned"),
      Stream.runForEach(() => Queue.offer(plans, undefined)),
      Effect.forkScoped,
    );
    const holder = yield* presenter.view(first).hover({ x: 30, y: 20 }).pipe(Effect.forkScoped);

    yield* Queue.take(plans);
    waitingPage = next.id;
    const waiter = yield* presenter.view(next).hover({ x: 20, y: 20 }).pipe(Effect.forkScoped);

    yield* Deferred.await(judged);
    yield* TestClock.adjust(0);
    const interrupting = yield* Fiber.interrupt(waiter).pipe(Effect.forkScoped);

    yield* TestClock.adjust(0);
    const cancelledBeforeRelease = interrupting.pollUnsafe() !== undefined;

    assert.isUndefined(holder.pollUnsafe(), "the first page still owns the hand");
    yield* TestClock.adjust("700 millis");
    yield* Fiber.join(holder);
    yield* Fiber.join(interrupting);
    assert.isTrue(cancelledBeforeRelease, "waiting for another page must remain interruptible");
    assert.isFalse((yield* next.recentEvents).some((event) => event._tag === "TrackPlanned"));

    const following = yield* presenter.view(next).hover({ x: 40, y: 20 }).pipe(Effect.forkScoped);

    yield* Queue.take(plans);
    yield* TestClock.adjust("700 millis");
    yield* Fiber.join(following);
  }).pipe(Effect.scoped),
);
