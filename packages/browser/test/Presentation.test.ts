// Performed input: what a presenter's style plans, and what its views do on real Chromium, beside
// plain input on other pages.
import { assert, describe, it, layer } from "@effect/vitest";
import { Duration, Effect, Fiber, Layer, MutableRef, Option, Random, Schedule } from "effect";

import { Browser, make as makeBrowser } from "../src/Browser.ts";
import type { Action, BrowserEvent } from "../src/BrowserEvent.ts";
import * as Chromium from "../src/Chromium.ts";
import * as Style from "../src/internal/input/style.ts";
import * as Motion from "../src/Motion.ts";
import type { Page } from "../src/Page.ts";
import * as Presentation from "../src/Presentation.ts";
import type { Snapshot } from "../src/Snapshot.ts";
import { Site, SiteLayer, unpaused } from "./fixtures.ts";

const performed = Style.performed({
  pointer: MutableRef.make(Option.none()),
  motion: Motion.lognormal,
  wordsPerMinute: 70,
});

const average = (numbers: ReadonlyArray<number>) =>
  numbers.reduce((total, number) => total + number, 0) / numbers.length;

// The text typing produces: insertions, and keys pressed down, with Backspace removing one.
const replay = (events: ReadonlyArray<Style.TypingEvent>) =>
  events
    .flatMap((event) =>
      event.phase === "insert" ? [...event.key] : event.phase === "down" ? [event.key] : [],
    )
    .join("");

describe("Presentation's style", () => {
  it.effect("types about 70 words a minute, each key held about 110 ms, keys overlapping", () =>
    Effect.gen(function* () {
      const text =
        "Thoughtful pacing keeps each sentence readable while the next word starts with a short pause. ".repeat(
          4,
        );

      const rates: Array<number> = [];
      const holds: Array<number> = [];
      let overlaps = 0;

      for (const seed of [7, 19, 43, 83]) {
        const events = yield* performed.typing(text, false).pipe(Random.withSeed(seed));
        const pressed = new Map<string, number>();

        rates.push(text.length / 5 / ((events.at(-1)?.afterMillis ?? 0) / 60_000));
        for (const event of events) {
          if (event.phase === "down") {
            if (pressed.size > 0) overlaps += 1;
            pressed.set(event.key.toLowerCase(), event.afterMillis);
          } else if (event.phase === "up") {
            holds.push(event.afterMillis - (pressed.get(event.key.toLowerCase()) ?? Number.NaN));
            pressed.delete(event.key.toLowerCase());
          }
        }
        assert.strictEqual(pressed.size, 0);
        assert.strictEqual(replay(events), text);
      }

      const sorted = holds.toSorted((left, right) => left - right);

      assert.closeTo(average(rates), 70, 5);
      assert.closeTo(average(holds), 110, 5);
      assert.isAtLeast(sorted[0] ?? 0, 60);
      assert.isAtMost(sorted.at(-1) ?? Infinity, 220);
      assert.isAbove(overlaps, 50);
    }),
  );

  it.effect("never holds one physical key twice, and types what no key makes as text", () =>
    Effect.gen(function* () {
      const text = "aAaA11!!aA..>> é👩‍💻\n終";
      const events = yield* performed.typing(text, false).pipe(Random.withSeed(71));
      const held = new Set<string>();
      // These literal pairs share physical US keys even though their text differs.
      const physical = (key: string) => key.toLowerCase().replace("!", "1").replace(">", ".");

      for (const event of events) {
        if (event.phase === "down") {
          assert.isFalse(held.has(physical(event.key)));
          held.add(physical(event.key));
        } else if (event.phase === "up") held.delete(physical(event.key));
      }
      assert.strictEqual(replay(events), text);
      assert.strictEqual(
        events
          .filter((event) => event.phase === "insert")
          .map((event) => event.key)
          .join(""),
        "é👩‍💻\n終",
      );
      assert.deepStrictEqual(
        events,
        yield* performed.typing(text, false).pipe(Random.withSeed(71)),
      );
    }),
  );

  it.effect("holds a press about 80 ms, now and then longer", () =>
    Effect.gen(function* () {
      const holds = yield* Effect.forEach(Array.from({ length: 512 }), () => performed.hold).pipe(
        Random.withSeed("mouse-holds"),
      );

      assert.closeTo(average(holds), 80, 6);
      assert.isAtLeast(Math.min(...holds), 35);
      assert.isAtMost(Math.max(...holds), 200);
      assert.isAbove(Math.max(...holds), 140);
    }),
  );

  it.effect("turns the wheel in 100 px notches, in bursts of at most nine", () =>
    Effect.gen(function* () {
      const steps = yield* performed.wheel(0, 2050).pipe(Random.withSeed("wheel"));

      const gaps = steps
        .slice(1)
        .map((step, index) => step.afterMillis - (steps[index]?.afterMillis ?? 0));

      assert.lengthOf(steps, 21);
      assert.closeTo(
        steps.reduce((total, step) => total + step.dy, 0),
        2050,
        1e-9,
      );
      for (const [index, gap] of gaps.entries())
        if ((index + 1) % 9 === 0) assert.isTrue(gap >= 600 && gap <= 2600, `burst gap ${gap}`);
        else assert.isTrue(gap >= 30 && gap <= 140, `notch gap ${gap}`);
    }),
  );

  it.effect("plans plain input at once: a jump, one wheel step, keys or one insertion", () =>
    Effect.gen(function* () {
      const from = { x: 10, y: 10 };
      const to = { x: 300, y: 200 };

      assert.deepStrictEqual(yield* Style.plain.glide(from, to, false), [
        { ...to, afterMillis: 0 },
      ]);
      assert.deepStrictEqual(yield* Style.plain.wheel(0, 300), [
        { dx: 0, dy: 300, afterMillis: 0 },
      ]);
      assert.deepStrictEqual(yield* Style.plain.typing("a b", true), [
        { afterMillis: 0, phase: "insert", key: "a b" },
      ]);
      assert.deepStrictEqual(
        (yield* Style.plain.typing("aé", false)).map((event) => [event.phase, event.key]),
        [
          ["down", "a"],
          ["up", "a"],
          ["insert", "é"],
        ],
      );
    }),
  );
});

/** The ref of the line for this role and name. */
const refOf = (snapshot: Snapshot, role: string, name: string): string => {
  const ref = new RegExp(`${role} "${name}"[^\\n]*?\\[ref=(e\\d+)\\]`).exec(snapshot.text)?.[1];

  assert.isDefined(ref, `no ${role} "${name}" in:\n${snapshot.text}`);

  return ref ?? "";
};

const eventually = (check: Effect.Effect<boolean>) =>
  check.pipe(
    Effect.repeat({ until: (done) => done, schedule: Schedule.spaced("10 millis") }),
    Effect.timeout("10 seconds"),
  );

/** A planner whose glides are straight and take `millis`, in 60 samples a second. */
const straight = (millis: number): Motion.Service => ({
  plan: (from, to) =>
    Effect.sync(() => {
      if (Math.hypot(to.x - from.x, to.y - from.y) < 2) return [{ ...to, afterMillis: 0 }];
      const count = Math.max(1, Math.round((millis / 1000) * 60));

      return Array.from({ length: count }, (_, index) => ({
        x:
          index === count - 1 ? to.x : Math.round(from.x + ((to.x - from.x) * (index + 1)) / count),
        y:
          index === count - 1 ? to.y : Math.round(from.y + ((to.y - from.y) * (index + 1)) / count),
        afterMillis: ((index + 1) * millis) / count,
      }));
    }),
});

const eventsOf = (browser: Browser["Service"], page: Page) =>
  Effect.map(browser.recentEvents, (events) =>
    events.filter(
      (event): event is BrowserEvent & { readonly page: string } =>
        "page" in event && event.page === page.id,
    ),
  );

layer(Layer.mergeAll(Chromium.layer(), SiteLayer), {
  excludeTestServices: true,
  timeout: Duration.seconds(60),
})("Presentation", (it) => {
  it.effect("glides a view's pointer where its page itself jumps", () =>
    Effect.gen(function* () {
      const browser = yield* Browser;
      const page = yield* browser.newPage((yield* Site).url("/form"));
      const presenter = yield* Presentation.make({ pacing: unpaused });
      const submit = refOf(yield* page.snapshot(), "button", "Submit");

      yield* page.click(submit);
      yield* presenter.view(page).click(submit);

      const plans = (yield* eventsOf(browser, page)).filter(
        (event) => event._tag === "TrackPlanned",
      );

      assert.lengthOf(plans, 2);
      assert.lengthOf(plans[0]?._tag === "TrackPlanned" ? plans[0].samples : [], 1);
      assert.isAbove(plans[1]?._tag === "TrackPlanned" ? plans[1].samples.length : 0, 5);
    }),
  );

  // A presented page may glide on air while the agent reads and clicks another page off air.
  it.effect("runs plain input on another page while a view glides, neither waiting", () =>
    Effect.gen(function* () {
      const browser = yield* Browser;
      const site = yield* Site;
      const shown = yield* browser.newPage(site.url("/form"));
      const behind = yield* browser.newPage(site.url("/form"));
      const presenter = yield* Presentation.make({ motion: straight(2000), pacing: unpaused });
      const gliding = yield* presenter.view(shown).hover({ x: 700, y: 500 }).pipe(Effect.forkChild);

      yield* eventually(
        Effect.map(eventsOf(browser, shown), (events) =>
          events.some((event) => event._tag === "TrackPlanned"),
        ),
      );
      const asked = yield* browser.now;

      yield* behind.click({ x: 900, y: 650 });
      const clicked = (yield* browser.now) - asked;

      assert.isBelow(clicked, 1000);
      assert.isUndefined(gliding.pollUnsafe(), "the glide goes on");
      yield* Fiber.join(gliding);
      const events = yield* eventsOf(browser, shown);
      const plan = events.find((event) => event._tag === "TrackPlanned");
      const done = events.find((event) => event._tag === "TrackPerformed");

      // The glide kept its schedule: it ended about 2 s after it began.
      assert.isTrue(done?._tag === "TrackPerformed" && done.complete);
      assert.isBelow((done?.at ?? Infinity) - (plan?.at ?? 0), 2500);
    }),
  );

  it.effect("waits as a person reacts: least on, longer after a new document, most elsewhere", () =>
    Effect.gen(function* () {
      const browser = yield* Browser;
      const site = yield* Site;
      const page = yield* browser.newPage(site.url("/navigating"));
      const other = yield* browser.newPage(site.url("/navigating"));

      const presenter = yield* Presentation.make({
        pacing: {
          expected: "150 millis",
          surprise: "400 millis",
          unrelated: "800 millis",
          wordsPerMinute: 70,
        },
        motion: straight(50),
      });

      const view = presenter.view(page);
      const snapshot = yield* page.snapshot();
      const still = refOf(snapshot, "button", "Still");

      // A random source whose normal draws are zero, so each wait is its median.
      const medians = Effect.provideService(Random.Random, {
        nextIntUnsafe: () => 0,
        nextDoubleUnsafe: () => 0.25,
      });

      yield* view.click(still).pipe(medians);
      yield* view.click(still).pipe(medians);
      yield* view.click(refOf(snapshot, "link", "Link")).pipe(medians);
      yield* view.click(refOf(yield* page.snapshot(), "button", "Continue")).pipe(medians);
      yield* presenter.view(other).click({ x: 20, y: 340 }).pipe(medians);

      const actions = (yield* browser.recentEvents).filter(
        (event): event is Action =>
          event._tag === "Action" &&
          event.name === "click" &&
          (event.page === page.id || event.page === other.id),
      );

      const gaps = actions
        .slice(1)
        .map((action, index) => action.startedAt - (actions[index]?.at ?? 0));

      // Another click on the page, a link's, a click on the document it reached, another page's.
      for (const [index, median] of [150, 150, 400, 800].entries())
        assert.closeTo(gaps[index] ?? 0, median, 100, `wait ${index + 1}: ${gaps.join(", ")}`);
    }),
  );

  it.effect("gives presentation a budget of its own, outside the action timeout", () =>
    Effect.gen(function* () {
      const native = (yield* Browser).context.browser();

      if (native === null) return yield* Effect.die("the fixture requires local Chromium");

      const context = yield* Effect.acquireRelease(
        Effect.promise(() => native.newContext({ viewport: { width: 800, height: 600 } })),
        (context) => Effect.promise(() => context.close()),
      );

      const browser = yield* makeBrowser(
        context,
        { id: "budget", provider: "test" },
        { actionTimeout: "1 second" },
      );

      const page = yield* browser.newPage((yield* Site).url("/form"));
      const presenter = yield* Presentation.make({ motion: straight(1500), pacing: unpaused });
      const asked = yield* browser.now;

      // Two glides of 1.5 s each, in an action with 1 s to do its own work.
      yield* presenter.view(page).drag({ x: 100, y: 500 }, { x: 600, y: 300 });
      assert.isAbove((yield* browser.now) - asked, 2900);
    }),
  );

  it.effect("starts a glide on aim, which the action on its target completes", () =>
    Effect.gen(function* () {
      const browser = yield* Browser;
      const page = yield* browser.newPage((yield* Site).url("/form"));
      const presenter = yield* Presentation.make({ motion: straight(600), pacing: unpaused });
      const view = presenter.view(page);
      const submit = refOf(yield* page.snapshot(), "button", "Submit");

      const of = <Tag extends BrowserEvent["_tag"]>(tag: Tag) =>
        Effect.map(browser.recentEvents, (events) =>
          events.filter(
            (event): event is Extract<BrowserEvent, { readonly _tag: Tag }> =>
              event._tag === tag && "page" in event && event.page === page.id,
          ),
        );

      yield* view.aim(submit);
      // The glide is under way before the click is asked for.
      yield* eventually(Effect.map(of("TrackPlanned"), (plans) => plans.length === 1));
      yield* view.click(submit);
      const [aimed, clicked] = yield* of("TrackPlanned");
      const [arrived] = yield* of("TrackPerformed");

      assert.isTrue(arrived?.complete);
      assert.isAbove(aimed?.samples.length ?? 0, 5);
      assert.lengthOf(clicked?.samples ?? [], 1);
      // The aim was no action of its own.
      assert.deepStrictEqual(
        (yield* of("Action")).map((action) => action.name),
        ["navigate", "click"],
      );
      assert.lengthOf(yield* of("PointerPressed"), 1);

      // An aim at somewhere else stops where it is, and the click glides on from there.
      yield* view.aim({ x: 700, y: 500 });
      yield* eventually(Effect.map(of("TrackPlanned"), (plans) => plans.length === 3));
      yield* Effect.sleep("100 millis");
      yield* view.click({ x: 900, y: 650 });
      const plans = yield* of("TrackPlanned");
      const stopped = (yield* of("TrackPerformed"))[2];

      assert.isFalse(stopped?.complete);
      assert.deepStrictEqual(plans[3]?.from, { x: stopped?.x, y: stopped?.y });
    }),
  );
});
