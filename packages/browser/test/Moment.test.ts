// Moments of real pages, laid out for scripted models: no model is called.
import { assert, describe, expectTypeOf, it, layer } from "@effect/vitest";
import { Arbitrary, Duration, Effect, Layer, Option, Schema, Stream } from "effect";
import { LanguageModel, Prompt, type Response } from "effect/ai";
import type { CDPSession } from "playwright-core";

import { Browser, make as makeBrowser } from "../src/Browser.ts";
import { BrowserError, Failed } from "../src/BrowserError.ts";
import {
  Action,
  type BrowserEvent,
  DialogShown,
  Navigated,
  PointerPressed,
  Subject,
  TrackEvent,
} from "../src/BrowserEvent.ts";
import { Change, Changes } from "../src/Change.ts";
import * as Chromium from "../src/Chromium.ts";
import { BrowserPaint, Frame, Screenshot } from "../src/Frame.ts";
import { boundsOf, within } from "../src/internal/timeline/window.ts";
import * as Moment from "../src/Moment.ts";
import { Snapshot } from "../src/Snapshot.ts";
import { Site, SiteLayer } from "./fixtures.ts";

const texts = (prompt: Prompt.Prompt) =>
  prompt.content.flatMap((message) =>
    message.role === "user"
      ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
      : [],
  );

const pictures = (prompt: Prompt.Prompt) =>
  prompt.content.flatMap((message) =>
    message.role === "user" ? message.content.filter((part) => part.type === "file") : [],
  );

const shot = (hostTime: number, byte: number) =>
  new Frame({
    page: "p1",
    session: "s1",
    data: new Uint8Array([0xff, 0xd8, byte]),
    timing: new Screenshot({ hostTime, uncertaintyMillis: 0 }),
    receivedAt: hostTime,
    width: 800,
    height: 600,
    document: 1,
    url: "https://shop.example/",
  });

const isTrackEvent = Schema.is(TrackEvent);

it("lays a moment out as one message: the outline, a timeline and captioned frames", () => {
  const moment = new Moment.Moment({
    page: "p1",
    since: 5000,
    until: 10_000,
    frames: [shot(7000, 1), shot(10_000, 2)],
    snapshot: new Snapshot({
      url: "https://shop.example/cart",
      title: "Cart",
      text: '- button "Pay" [ref=e3]',
      truncated: false,
      above: 0,
      below: 0,
      viewport: { width: 800, height: 600 },
      scroll: { y: 0, height: 600 },
    }),
    events: [
      new Action({
        at: 8800,
        startedAt: 8700,
        page: "p1",
        name: "click",
        target: "e3",
        subject: new Subject({ role: "button", name: "Pay", tag: "button", context: {} }),
        x: 40,
        y: 20,
        ok: true,
        dispatched: true,
      }),
      new PointerPressed({ at: 8750, page: "p1", x: 40, y: 20, button: "left", clickCount: 1 }),
      new Action({
        at: 9000,
        startedAt: 8900,
        page: "p1",
        name: "navigate",
        ok: true,
        dispatched: true,
      }),
      new Navigated({
        at: 9000,
        page: "p1",
        url: "https://shop.example/paid",
        document: 2,
        sameDocument: false,
      }),
      new DialogShown({ at: 9500, page: "p1", kind: "alert", message: "Paid" }),
    ],
    missing: [],
  });

  const prompt = Moment.toPrompt(moment);
  const [text = "", ...captions] = texts(prompt);

  assert.deepStrictEqual(
    prompt.content.map((message) => message.role),
    ["user"],
  );
  // The outline, then the events in order of time, each timed before the moment; with no record
  // of changes, every step is told. The frames follow, captioned with their times.
  const at = (line: string) => text.indexOf(line);

  assert.isAbove(at('- button "Pay" [ref=e3]'), 0);
  assert.isTrue(
    at('- button "Pay" [ref=e3]') < at('-1.2s click button "Pay"') &&
      at('-1.2s click button "Pay"') < at("-1.0s navigated to https://shop.example/paid") &&
      at("-1.0s navigated to https://shop.example/paid") < at('-0.5s a dialog (alert) said "Paid"'),
    text,
  );
  assert.deepStrictEqual(captions, ["-3.0s:", "The moment:"]);
  assert.deepStrictEqual(
    pictures(prompt).map((part) => part.data),
    moment.frames.map((frame) => frame.data),
  );
});

it("names what each action acted on, never by a ref", () => {
  const action = (at: number, fields: Partial<ConstructorParameters<typeof Action>[0]>) =>
    new Action({
      at,
      startedAt: at,
      page: "p1",
      name: "click",
      ok: true,
      dispatched: true,
      ...fields,
    });

  const prompt = Moment.toPrompt(
    new Moment.Moment({
      page: "p1",
      since: 5000,
      until: 10_000,
      frames: [shot(10_000, 1)],
      missing: [],
      events: [
        action(6000, {
          target: "300,320",
          subject: new Subject({ role: "canvas", name: "", tag: "canvas", context: {} }),
          x: 300,
          y: 320,
        }),
        action(7000, {
          name: "type",
          target: "e4",
          text: "ada@example.com",
          subject: new Subject({ role: "textbox", name: "Email", tag: "input", context: {} }),
          x: 10,
          y: 10,
        }),
        action(7500, {
          name: "select",
          target: "e5",
          text: "eth",
          subject: new Subject({ role: "combobox", name: "Coin", tag: "select", context: {} }),
        }),
        action(8000, {
          name: "drag",
          target: '"e6" -> {"x":380,"y":40}',
          subject: new Subject({ role: "slider", name: "Level", tag: "input", context: {} }),
          to: new Subject({ role: null, name: "", tag: "main", context: {} }),
          x: 380,
          y: 40,
        }),
        action(8500, { name: "press", target: "Enter" }),
        action(9000, {
          target: "e1",
          ok: false,
          dispatched: false,
          error: "e1 is not on the page any more",
        }),
        action(9500, {
          name: "navigate",
          target: "https://shop.example/item-e2",
          ok: false,
          dispatched: false,
          error: "timed out",
        }),
      ],
    }),
  );

  const [text = ""] = texts(prompt);

  // Each is named by what it acted on, at what point, with what keys or at what address. A failed
  // one says only that it failed: its error is advice to the caller that acted, and may name a ref.
  // A ref it was given is not named, though an address may hold one.
  for (const said of [
    "(300, 320)",
    '"ada@example.com"',
    '"Email"',
    '"eth"',
    '"Coin"',
    '"Level"',
    "(380, 40)",
    "Enter",
    "https://shop.example/item-e2",
  ])
    assert.include(text, said);
  for (const advice of ["not on the page any more", "timed out"]) assert.notInclude(text, advice);
  assert.notMatch(text.replace("item-e2", ""), /\be\d+\b/);
});

it("tells no event, and no outline, where the moment has none", () => {
  const empty = (changes?: Changes) =>
    texts(
      Moment.toPrompt(
        new Moment.Moment({
          page: "p1",
          since: 9000,
          until: 10_000,
          frames: [shot(10_000, 1)],
          events: [],
          changes,
          missing: [],
        }),
      ),
    );

  const timed = (text: string) => text.split("\n").filter((line) => /^-\d+\.\ds /.test(line));

  for (const changes of [
    undefined,
    new Changes({ document: 1, from: 0, until: 10_000, cursor: 0, dropped: 0, changes: [] }),
  ]) {
    const [text = "", ...captions] = empty(changes);

    assert.deepStrictEqual(timed(text), []);
    assert.notInclude(text, "Page:");
    assert.deepStrictEqual(captions, ["The moment:"]);
  }
});

it("says what a moment could not read and why, and shows no older frame as the moment", () => {
  const failed = (operation: string, detail: string) =>
    new BrowserError({ operation, reason: new Failed({ detail }), dispatched: false });

  const [text = "", ...captions] = texts(
    Moment.toPrompt(
      new Moment.Moment({
        page: "p1",
        since: 5000,
        until: 10_000,
        frames: [shot(7000, 1), shot(8000, 2)],
        events: [],
        missing: [
          failed("changes", "the record went quiet"),
          failed("frame", "no picture came"),
          failed("snapshot", "no outline came"),
        ],
      }),
    ),
  );

  for (const reason of ["the record went quiet", "no picture came", "no outline came"])
    assert.include(text, reason);
  assert.deepStrictEqual(captions, ["-3.0s:", "-2.0s:"]);
});

// ---------------------------------------------------------------------------------------------
// A window's bounds over its tracks, and its stillness, over many inputs.

const Time = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1000 }));
const times = Arbitrary.schema(Schema.Array(Time).check(Schema.isMaxLength(30)));
const byTime = (left: number, right: number) => left - right;

/** Events at these times, oldest first, every third a pointer press of the presentation track. */
const eventsAt = (at: ReadonlyArray<number>) =>
  at
    .toSorted(byTime)
    .map((at, index) =>
      index % 3 === 2
        ? new PointerPressed({ at, page: "p1", x: 1, y: 1, button: "left", clickCount: 1 })
        : new DialogShown({ at, page: "p1", kind: "alert", message: `${index}` }),
    );

const framesAt = (at: ReadonlyArray<number>) =>
  at.toSorted(byTime).map((at, index) => shot(at, index % 256));

/** A screencast frame: a paint, at its host time. */
const paintedAt = (hostTime: number) =>
  new Frame({
    ...shot(hostTime, 3),
    timing: new BrowserPaint({ timestamp: hostTime + 1e12, hostTime, uncertaintyMillis: 1 }),
  });

// How a bound is asked: a host time, a frame's paint or, for a start, a previous window's end or a
// duration back from the end.
const Asked = Schema.Struct({
  kind: Schema.Literals(["time", "frame", "window", "duration"]),
  millis: Schema.Int.check(Schema.isBetween({ minimum: -500, maximum: 1500 })),
});

describe("a window", () => {
  it.prop(
    "holds each event once and each frame painted in it, so consecutive windows tile the tracks",
    {
      events: times,
      frames: times,
      cuts: Arbitrary.schema(Schema.Tuple([Time, Time, Time])),
    },
    ({ events, frames, cuts }) => {
      const [a = 0, b = 0, c = 0] = cuts.toSorted(byTime);

      // Each cut has a frame on it and an event that is not the presentation track's, of every two
      // there, so every input tries the boundary.
      const tracks = {
        events: eventsAt([...events, ...cuts, ...cuts]),
        frames: framesAt([...frames, ...cuts]),
      };

      const first = within({ since: a, until: b }, tracks.events, tracks.frames);
      const second = within({ since: b, until: c }, tracks.events, tracks.frames);

      const at = (frames: ReadonlyArray<Frame>, time: number) =>
        frames.filter((frame) => frame.hostTime === time);

      // Every event after the first's start, up to the second's end, once and in order, apart
      // from the presentation track.
      assert.deepStrictEqual(
        [...first.events, ...second.events],
        tracks.events.filter((event) => event.at > a && event.at <= c && !isTrackEvent(event)),
      );
      // Every frame painted from the first's start to the second's end, in order; one painted at
      // the cut ends the first and begins the second.
      assert.deepStrictEqual(
        [...first.frames, ...second.frames.slice(at(second.frames, b).length)],
        tracks.frames.filter((frame) => frame.hostTime >= a && frame.hostTime <= c),
      );
      assert.deepStrictEqual(at(first.frames, b), at(second.frames, b));
    },
  );

  it.prop(
    "ends at its frame's paint or by now, and never starts after it ends",
    { now: Arbitrary.schema(Time), start: Arbitrary.schema(Asked), end: Arbitrary.schema(Asked) },
    ({ now, start, end }) => {
      // A frame is painted by now; a duration reaches back no less than nothing.
      const frame = shot(Math.min(end.millis, now), 1);
      const until = end.kind === "frame" ? frame : end.kind === "time" ? end.millis : undefined;
      const back = Math.abs(start.millis);

      const since =
        start.kind === "frame"
          ? shot(start.millis, 2)
          : start.kind === "window"
            ? new Moment.Window({
                page: "p1",
                since: start.millis - 100,
                until: start.millis,
                events: [],
                frames: [],
                missing: [],
              })
            : start.kind === "duration"
              ? Duration.millis(back)
              : start.millis;

      const bounds = Option.getOrUndefined(boundsOf({ since, until }, now));

      const ends =
        until === undefined
          ? now
          : typeof until === "number"
            ? Math.min(until, now)
            : until.hostTime;

      const starts = start.kind === "duration" ? ends - back : start.millis;

      assert.deepStrictEqual(bounds, { since: Math.min(starts, ends), until: ends });
      assert.isAtMost(bounds?.until ?? Infinity, now);
    },
  );

  it("asks for finite bounds, reaching back no less than nothing", () => {
    for (const since of [
      Number.NaN,
      Number.NEGATIVE_INFINITY,
      Duration.millis(-1),
      Duration.infinity,
    ])
      assert.isTrue(Option.isNone(boundsOf({ since }, 1000)), String(since));
    assert.isTrue(Option.isNone(boundsOf({ since: 0, until: Number.NaN }, 1000)));
  });

  it.prop(
    "is still since the last thing its record or its painted frames saw stir, unknown where neither saw",
    {
      from: Arbitrary.schema(Schema.UndefinedOr(Time)),
      changed: times,
      painted: times,
      screenshots: times,
    },
    ({ from, changed, painted, screenshots }) => {
      const [since, until] = [200, 1000];
      const seen = Math.max(since, from ?? since);
      const stirs = changed.filter((at) => at > seen);
      const paints = painted.filter((at) => at >= since).toSorted(byTime);

      // Screenshots show the page, not when it last changed.
      const frames = [
        ...paints.map((at) => paintedAt(at)),
        ...framesAt(screenshots.filter((at) => at >= since)),
      ].toSorted((left, right) => left.hostTime - right.hostTime);

      const changes =
        from === undefined
          ? undefined
          : new Changes({
              document: 1,
              from,
              until,
              cursor: 0,
              dropped: 0,
              changes: stirs.map(
                (at) =>
                  new Change({
                    kind: "text",
                    subject: new Subject({ role: null, name: "", tag: "span", context: {} }),
                    startedAt: at,
                    at,
                    before: "$1",
                    after: "$2",
                    count: 1,
                  }),
              ),
            });

      const still = Moment.stillness(
        new Moment.Window({ page: "p1", since, until, events: [], frames, changes, missing: [] }),
      );

      // A record that saw none of the window, or none at all, and no painted frame cannot tell.
      const recorded = from !== undefined && from < until;

      if (!recorded && paints.length === 0) return assert.isUndefined(still);
      const last = Math.max(recorded ? seen : since, ...(recorded ? stirs : []), ...paints);

      assert.strictEqual(still, until - last);
    },
  );
});

/** A new tab at `path`, in front and closed with the test, so no earlier frames are retained. */
const start = (path: string) =>
  Effect.gen(function* () {
    const browser = yield* Browser;

    const page = yield* Effect.acquireRelease(browser.newPage(), (page) =>
      Effect.ignore(page.close),
    );

    yield* page.goto((yield* Site).url(path));
    yield* page.bringToFront;

    return page;
  });

const usage = { inputTokens: { total: 100 }, outputTokens: { total: 10 } };

layer(Layer.mergeAll(Chromium.layer(), SiteLayer), {
  excludeTestServices: true,
  timeout: Duration.seconds(60),
})("Moment", (it) => {
  it.effect("captures a spinning game and gives it to a model in one call", () =>
    Effect.gen(function* () {
      const page = yield* start("/slots");

      yield* page.screencast().pipe(Stream.runDrain, Effect.forkScoped);
      yield* Effect.sleep(Duration.millis(300));
      yield* page.click({ x: 300, y: 320 });
      yield* Effect.sleep(Duration.millis(400));
      const moment = yield* Moment.capture(page, { frames: 2 });
      const prompts: Array<Prompt.Prompt> = [];

      const model = yield* LanguageModel.make({
        generateText: (options) =>
          Effect.sync(() => {
            prompts.push(options.prompt);

            const parts: Array<Response.PartEncoded> = [
              { type: "text", text: JSON.stringify({ spinning: true }) },
              { type: "finish", reason: "stop", usage },
            ];

            return parts;
          }),
        streamText: () => Stream.empty,
      });

      const { value } = yield* LanguageModel.generateObject({
        prompt: Prompt.setSystem(Moment.toPrompt(moment), "Say whether the reels are spinning."),
        schema: Schema.Struct({ spinning: Schema.Boolean }),
      }).pipe(Effect.provideService(LanguageModel.LanguageModel, model));

      const prompt = prompts[0];

      if (prompt === undefined) return yield* Effect.die("the model was not called");
      assert.deepStrictEqual(
        prompt.content.map((message) => message.role),
        ["system", "user"],
      );
      assert.strictEqual(moment.frames.length, 2);
      assert.isTrue(
        moment.events.some((event) => event._tag === "Action" && event.name === "click"),
      );
      assert.isTrue(value.spinning);
    }),
  );

  it.effect("tiles moments, so consecutive ones neither repeat nor skip an event", () =>
    Effect.gen(function* () {
      const page = yield* start("/form");
      const first = yield* Moment.capture(page);

      yield* page.press("Tab");
      const second = yield* Moment.capture(page, { since: first });

      yield* page.goto((yield* Site).url("/next"));
      const third = yield* Moment.capture(page, { since: second, snapshot: true });

      // A moment needs only its page: no Browser in context.
      expectTypeOf(Moment.capture(page)).toEqualTypeOf<
        Effect.Effect<Moment.Moment, BrowserError>
      >();
      assert.strictEqual(second.since, first.until);
      assert.strictEqual(third.since, second.until);
      assert.isUndefined(second.snapshot);
      assert.strictEqual(third.snapshot?.title, "Next");

      // Without a screencast, each moment is one new screenshot, and ends when it was taken.
      for (const moment of [first, second, third]) {
        assert.strictEqual(moment.frames.length, 1);
        assert.strictEqual(moment.frames[0]?.timing._tag, "Screenshot");
        assert.strictEqual(moment.until, moment.frames[0]?.hostTime);
      }
      assert.deepStrictEqual(
        second.events.map((event) => [event._tag, event._tag === "Action" ? event.name : ""]),
        [["Action", "press"]],
      );
      assert.isTrue(third.events.some((event) => event._tag === "Navigated"));
      assert.isFalse(
        third.events.some((event) => event._tag === "Action" && event.name === "press"),
      );

      // Together they hold each of the page's events after the first moment exactly once.
      assert.deepStrictEqual(
        [...second.events, ...third.events],
        (yield* page.recentEvents).filter(
          (event) => event.at > first.until && event.at <= third.until && !isTrackEvent(event),
        ),
      );
    }),
  );

  it.effect("names the control a navigating click acted on, though its ref now means another", () =>
    Effect.gen(function* () {
      const page = yield* start("/form");
      const before = yield* page.snapshot();
      const ref = /link "Next page" \[ref=(e\d+)\]/.exec(before.text)?.[1];

      if (ref === undefined) return yield* Effect.die("the form has no Next page link");
      yield* page.click(ref);
      yield* page.waitForText("The next page");
      const moment = yield* Moment.capture(page, { snapshot: true });

      const click = moment.events.find(
        (event) => event._tag === "Action" && event.name === "click",
      );

      assert.deepStrictEqual(
        click?._tag === "Action" ? click.subject : undefined,
        new Subject({ role: "link", name: "Next page", tag: "a", context: {} }),
      );
      // The new page's outline gives refs to its own elements; what follows it uses none of them.
      // The click came before the new document's record began, so it is told as a step.
      const [text = ""] = texts(Moment.toPrompt(moment));
      const outline = moment.snapshot?.rendered ?? "";
      const timeline = text.slice(text.indexOf(outline) + outline.length);

      assert.match(text, /\[ref=e\d+\]/);
      assert.include(timeline, '"Next page"');
      assert.notMatch(timeline, /\be\d+\b/);
    }),
  );

  it.effect("reaches back as far as `since` says, for frames and events alike", () =>
    Effect.gen(function* () {
      const page = yield* start("/slots");

      yield* page.screencast().pipe(Stream.runDrain, Effect.forkScoped);
      yield* Effect.sleep(Duration.millis(300));
      yield* page.click({ x: 300, y: 320 });
      yield* Effect.sleep(Duration.millis(1500));

      const recent = yield* Moment.capture(page, { since: Duration.millis(500), frames: 3 });
      const longer = yield* Moment.capture(page, { frames: 3 });

      assert.closeTo(recent.until - recent.since, 500, 1e-6);
      assert.isTrue(recent.frames.every((frame) => frame.hostTime >= recent.since));
      assert.isFalse(recent.events.some((event) => event._tag === "Action"));
      assert.closeTo(longer.until - longer.since, 5000, 1e-6);

      const click = longer.events.find(
        (event) => event._tag === "Action" && event.name === "click",
      );

      // The screencast ran from before the click, so the longer window's frames reach back past it.
      assert.isDefined(click);
      assert.isBelow(longer.frames[0]?.hostTime ?? Infinity, click?.at ?? -Infinity);
    }),
  );

  it.effect("rejects fewer than one frame, and a window that is not a finite duration", () =>
    Effect.gen(function* () {
      const page = yield* start("/form");

      const invalid: ReadonlyArray<Moment.CaptureOptions> = [
        { frames: 0 },
        { frames: 1.5 },
        { since: Duration.millis(-1) },
        { since: Number.NaN },
        { since: Duration.infinity },
      ];

      for (const options of invalid) {
        const error = yield* Moment.capture(page, options).pipe(Effect.flip);

        assert.strictEqual(error.reason._tag, "InvalidRequest", JSON.stringify(options));
        assert.isFalse(error.dispatched);
      }
    }),
  );

  // A delayed consumer airs a frame painted some seconds before, so it describes a window that
  // ended then.
  it.effect("reads a window that ended 3 s before, each of its tracks ending where it does", () =>
    Effect.gen(function* () {
      const browser = yield* Browser;
      const page = yield* start("/desk");
      const [menu] = yield* page.find({ role: "button", name: "Menu" });

      const price = (shown: string) =>
        Effect.promise(() =>
          page.playwright.evaluate((text) => {
            document.querySelector("#btc")!.textContent = text;
          }, shown),
        );

      yield* page.screencast().pipe(Stream.runDrain, Effect.forkScoped);
      yield* page.changes();
      yield* price("$1");
      yield* Effect.sleep(Duration.millis(300));
      const until = yield* browser.now;

      // After the window ends, the price moves again and a click lands, and both paint.
      yield* Effect.sleep(Duration.millis(100));
      yield* price("$2");
      yield* page.click(menu?.ref ?? "no menu");
      yield* Effect.sleep(Duration.millis(2900));
      const window = yield* page.window({ since: Duration.seconds(2), until });
      const kept = { events: yield* page.recentEvents, frames: yield* page.recentFrames };

      assert.deepStrictEqual([window.since, window.until], [until - 2000, until]);
      assert.isEmpty(window.missing);
      // Each track holds what came by the window's end, and nothing the page kept from after it.
      assert.deepStrictEqual(
        window.changes?.changes.map((change) => [change.before, change.after]),
        [["$61,240", "$1"]],
      );
      assert.closeTo(window.changes?.until ?? Number.NaN, until, 1);
      assert.isAbove(window.frames.length, 0);
      assert.isTrue(window.frames.every((frame) => frame.hostTime <= until));
      assert.isTrue(kept.frames.some((frame) => frame.hostTime > until));

      const clicked = (events: ReadonlyArray<BrowserEvent>) =>
        events.some((event) => event._tag === "Action" && event.name === "click");

      assert.isTrue(window.events.every((event) => event.at <= until));
      assert.isFalse(clicked(window.events));
      assert.isTrue(clicked(kept.events));
    }),
  );

  it.effect("keeps a moment whose picture or changes could not be read, saying why", () =>
    Effect.gen(function* () {
      const { browser, refuse } = yield* refusing;
      const page = yield* browser.newPage((yield* Site).url("/desk"));

      yield* page.changes();
      // No capture runs, so the picture is a new screenshot, which the page refuses; then the read
      // of what changed fails.
      refuse((method) => method === "Page.captureScreenshot");
      const unpictured = yield* Moment.capture(page);

      refuse(
        (method, params) =>
          method === "Runtime.evaluate" && JSON.stringify(params).includes(".changes("),
      );
      const unchanged = yield* Moment.capture(page, { since: unpictured });

      const why = (moment: Moment.Moment) =>
        moment.missing.map((error) => [error.operation, error.reason.message]);

      assert.deepStrictEqual(why(unpictured), [["frame", "the page could not answer"]]);
      assert.isDefined(unpictured.changes);
      assert.isEmpty(unpictured.frames);
      assert.deepStrictEqual(why(unchanged), [["changes", "the page could not answer"]]);
      assert.isUndefined(unchanged.changes);
      assert.strictEqual(unchanged.frames.length, 1);
      assert.strictEqual(unchanged.since, unpictured.until);
      // Its prompt says what could not be read and why, and no older frame poses as the moment.
      for (const moment of [unpictured, unchanged])
        assert.include(texts(Moment.toPrompt(moment)).join("\n"), "the page could not answer");
      assert.notInclude(texts(Moment.toPrompt(unpictured)), "The moment:");
    }),
  );
});

/**
 * A browser whose pages' own sessions refuse the calls `refuse` names, as a page that cannot answer
 * them would.
 */
const refusing = Effect.gen(function* () {
  const native = (yield* Browser).context.browser();

  if (native === null) return yield* Effect.die("the fixture requires local Chromium");

  const context = yield* Effect.acquireRelease(
    Effect.promise(() => native.newContext({ viewport: { width: 800, height: 600 } })),
    (context) => Effect.promise(() => context.close()),
  );

  const createSession = context.newCDPSession.bind(context);
  let refused = (_method: string, _params: unknown) => false;

  context.newCDPSession = async (target) => {
    const cdp = await createSession(target);
    const send = cdp.send.bind(cdp);

    const answering: CDPSession["send"] = (method, params) =>
      refused(method, params)
        ? Promise.reject(new Error("the page could not answer"))
        : send(method, params);

    cdp.send = answering;

    return cdp;
  };

  return {
    browser: yield* makeBrowser(context, { id: "refusing", provider: "test" }),
    refuse: (which: typeof refused) => {
      refused = which;
    },
  };
});
