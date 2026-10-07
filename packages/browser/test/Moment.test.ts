// Moments of real pages, laid out for scripted models: no model is called.
import { assert, describe, expectTypeOf, it, layer } from "@effect/vitest";
import { Duration, Effect, Layer, Schema, Stream } from "effect";
import { LanguageModel, Prompt, type Response } from "effect/ai";

import { Browser } from "../src/Browser.ts";
import type { BrowserError } from "../src/BrowserError.ts";
import {
  Action,
  DialogShown,
  Navigated,
  PointerPressed,
  Subject,
  TrackEvent,
} from "../src/BrowserEvent.ts";
import { Change } from "../src/Change.ts";
import * as Chromium from "../src/Chromium.ts";
import { Frame, Screenshot } from "../src/Frame.ts";
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
    data: new Uint8Array([0xff, 0xd8, byte]),
    timing: new Screenshot({ hostTime, uncertaintyMillis: 0 }),
    receivedAt: hostTime,
    width: 800,
    height: 600,
  });

const isTrackEvent = Schema.is(TrackEvent);

it("lays a moment out as one message: the outline, a timeline and captioned frames", () => {
  const moment = new Moment.Moment({
    page: "p1",
    from: 5000,
    at: 10_000,
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
        subject: new Subject({ role: "button", name: "Pay", tag: "button" }),
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
      new Navigated({ at: 9000, page: "p1", url: "https://shop.example/paid" }),
      new DialogShown({ at: 9500, page: "p1", kind: "alert", message: "Paid" }),
    ],
  });

  const prompt = Moment.toPrompt(moment);

  assert.deepStrictEqual(
    prompt.content.map((message) => message.role),
    ["user"],
  );
  assert.deepStrictEqual(texts(prompt), [
    [
      "One moment of a browser session. Rely only on what this material shows, and prefer concrete details: numbers, names, colours, positions and motion.",
      "",
      "Page: Cart",
      "URL: https://shop.example/cart",
      "Viewport: 800x600",
      '- button "Pay" [ref=e3]',
      "",
      "What happened (seconds before the moment, over 5.0s):",
      '-1.2s click button "Pay"',
      "-1.0s the tab went to https://shop.example/paid",
      '-0.5s a dialog (alert) said "Paid"',
      "What changed on the page was not recorded; the screenshots show it.",
      "",
      "2 screenshots follow, oldest first; the last one is the moment itself.",
    ].join("\n"),
    "-3.0s:",
    "The moment:",
  ]);
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
      from: 5000,
      at: 10_000,
      frames: [shot(10_000, 1)],
      events: [
        action(6000, {
          target: "300,320",
          subject: new Subject({ role: "canvas", name: "", tag: "canvas" }),
          x: 300,
          y: 320,
        }),
        action(7000, {
          name: "type",
          target: "e4",
          text: "ada@example.com",
          subject: new Subject({ role: "textbox", name: "Email", tag: "input" }),
          x: 10,
          y: 10,
        }),
        action(7500, {
          name: "select",
          target: "e5",
          text: "eth",
          subject: new Subject({ role: "combobox", name: "Coin", tag: "select" }),
        }),
        action(8000, {
          name: "drag",
          target: '"e6" -> {"x":380,"y":40}',
          subject: new Subject({ role: "slider", name: "Level", tag: "input" }),
          to: new Subject({ role: null, name: "", tag: "main" }),
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

  assert.include(
    texts(prompt)[0],
    [
      "-4.0s click canvas at (300, 320)",
      '-3.0s type "ada@example.com" into textbox "Email"',
      '-2.5s select "eth" in combobox "Coin"',
      '-2.0s drag slider "Level" to main at (380, 40)',
      "-1.5s press Enter",
      "-1.0s click (failed: e1 is not on the page any more)",
      "-0.5s navigate https://shop.example/item-e2 (failed: timed out)",
    ].join("\n"),
  );
});

it("says when nothing happened, and leaves out an outline the capture left out", () => {
  const prompt = Moment.toPrompt(
    new Moment.Moment({
      page: "p1",
      from: 9000,
      at: 10_000,
      frames: [shot(10_000, 1)],
      events: [],
    }),
  );

  assert.deepStrictEqual(texts(prompt), [
    [
      "One moment of a browser session. Rely only on what this material shows, and prefer concrete details: numbers, names, colours, positions and motion.",
      "",
      "What happened (seconds before the moment, over 1.0s):",
      "(no events in the window)",
      "What changed on the page was not recorded; the screenshots show it.",
      "",
      "One screenshot follows: the moment itself.",
    ].join("\n"),
    "The moment:",
  ]);
});

describe("a moment's account of what changed", () => {
  const span = new Subject({ role: null, name: "", tag: "span" });

  const action = (
    startedAt: number,
    at: number,
    fields: Partial<ConstructorParameters<typeof Action>[0]>,
  ) =>
    new Action({ at, startedAt, page: "p1", name: "click", ok: true, dispatched: true, ...fields });

  const change = (
    fields: Partial<ConstructorParameters<typeof Change>[0]> & { readonly at: number },
  ) =>
    new Change({
      startedAt: fields.at,
      kind: "text",
      subject: span,
      context: "",
      count: 1,
      ...fields,
    });

  const refresh = action(5800, 5900, {
    target: "e2",
    subject: new Subject({ role: "button", name: "Refresh", tag: "button" }),
  });

  const hover = action(7000, 7100, {
    name: "hover",
    target: "e3",
    subject: new Subject({ role: "link", name: "Help", tag: "a" }),
  });

  const missed = action(7500, 7500, {
    target: "e9",
    ok: false,
    dispatched: false,
    error: "e9 is not on the page any more",
  });

  const typed = action(8200, 8600, { name: "type", text: "bitcoin" });

  const spin = action(9400, 9500, {
    target: "300,320",
    subject: new Subject({ role: "canvas", name: "", tag: "canvas" }),
    x: 300,
    y: 320,
  });

  const moment = new Moment.Moment({
    page: "p1",
    from: 5000,
    at: 10_000,
    frames: [shot(10_000, 1)],
    events: [refresh, hover, missed, typed, spin],
    changes: [
      change({
        at: 6000,
        before: "$61,240",
        after: "$62,010",
        context: 'beside "Price", under "Bitcoin"',
      }),
      change({
        at: 6000,
        kind: "title",
        subject: new Subject({ role: null, name: "", tag: "title" }),
        before: "Quote",
        after: "Quote, refreshed",
      }),
      change({
        at: 6500,
        kind: "appeared",
        subject: new Subject({ role: "status", name: "", tag: "p" }),
        after: "Saved",
      }),
      change({
        at: 8000,
        before: "$62,010",
        after: "$62,100",
        context: 'beside "Price", under "Bitcoin"',
      }),
      change({
        at: 8500,
        kind: "value",
        subject: new Subject({ role: "textbox", name: "Search", tag: "input" }),
        before: "",
        after: "bitcoin",
        count: 7,
      }),
      change({
        at: 9000,
        startedAt: 8700,
        before: "$62,100",
        after: "$61,900",
        count: 3,
        context: 'beside "Price", under "Bitcoin"',
      }),
    ],
  });

  const account = (prompt: Prompt.Prompt) => {
    const [text = ""] = texts(prompt);

    return text.slice(text.indexOf("What changed")).split("\n").slice(1, -2);
  };

  it("leads with what changed, most notable first, and names actions as its causes", () => {
    assert.deepStrictEqual(account(Moment.toPrompt(moment)), [
      '-4.0s "$61,240" became "$62,010", then "$62,100", then "$61,900" (beside "Price", under "Bitcoin") (it changed 5 times), after a click on button "Refresh"',
      '-4.0s the title "Quote" became "Quote, refreshed", after a click on button "Refresh"',
      '-3.5s status appeared, reading "Saved", after a click on button "Refresh"',
      '-1.5s textbox "Search" now reads "bitcoin"',
      // A click on a canvas can change only its pixels, which no change records.
      "-0.5s click canvas at (300, 320)",
      "The text in view last changed at -1.0s.",
    ]);
  });

  it("lists every action as a step on request, or none at all", () => {
    const all = account(Moment.toPrompt(moment, { actions: "all" }));

    assert.deepStrictEqual(all.slice(4, -1), [
      '-4.1s click button "Refresh"',
      '-2.9s hover link "Help"',
      "-2.5s click (failed: e9 is not on the page any more)",
      '-1.4s type "bitcoin"',
      "-0.5s click canvas at (300, 320)",
    ]);
    assert.include(all[0], 'after a click on button "Refresh"');

    assert.deepStrictEqual(account(Moment.toPrompt(moment, { actions: "none" })), [
      '-4.0s "$61,240" became "$62,010", then "$62,100", then "$61,900" (beside "Price", under "Bitcoin") (it changed 5 times)',
      '-4.0s the title "Quote" became "Quote, refreshed"',
      '-3.5s status appeared, reading "Saved"',
      '-1.5s textbox "Search" now reads "bitcoin"',
      "The text in view last changed at -1.0s.",
    ]);
  });

  it("says where its record begins, lists the steps before it, and keeps look-alikes apart", () => {
    const partial = new Moment.Moment({
      page: "p1",
      from: 5000,
      at: 10_000,
      frames: [shot(10_000, 1)],
      events: [
        refresh,
        action(6600, 6700, { name: "hover", target: "e3", subject: hover.subject }),
      ],
      changesFrom: 6500,
      changes: [
        change({ at: 8000, before: "1", after: "2", context: 'row "Ether", column "1h"' }),
        change({ at: 9000, before: "5", after: "6", context: 'row "Ether", column "1h"' }),
        change({ at: 9500, kind: "disappeared", before: "First post", context: 'under "Feed"' }),
      ],
    });

    const [text = ""] = texts(Moment.toPrompt(partial));

    assert.include(
      text,
      [
        '-2.0s "1" became "2" (row "Ether", column "1h")',
        '-1.0s "5" became "6" (row "Ether", column "1h")',
        '-0.5s "First post" disappeared (under "Feed")',
        // Before the record began, a step is all there is to tell; after it, a hover that changed
        // nothing is left out.
        '-4.1s click button "Refresh"',
        "The text in view last changed at -0.5s.",
        "Changes before -3.5s were not recorded.",
      ].join("\n"),
    );

    const [still = ""] = texts(
      Moment.toPrompt(new Moment.Moment({ ...partial, events: [], changes: [] })),
    );

    assert.include(
      still,
      "No text in view changed after -3.5s.\nChanges before -3.5s were not recorded.",
    );
  });
});

/** A new tab at `path`, in front and closed with the test, so no earlier frames are retained. */
const start = (path: string) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const page = yield* Effect.acquireRelease(browser.newPage(), (page) => page.close);

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
      assert.strictEqual(pictures(prompt).length, 2);
      assert.include(texts(prompt).join("\n"), "click canvas at (300, 320)");
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
      assert.strictEqual(second.from, first.at);
      assert.strictEqual(third.from, second.at);
      assert.isUndefined(second.snapshot);
      assert.strictEqual(third.snapshot?.title, "Next");

      // Without a screencast, each moment is one new screenshot, and ends when it was taken.
      for (const moment of [first, second, third]) {
        assert.strictEqual(moment.frames.length, 1);
        assert.strictEqual(moment.frames[0]?.timing._tag, "Screenshot");
        assert.strictEqual(moment.at, moment.frames[0]?.hostTime);
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
          (event) => event.at > first.at && event.at <= third.at && !isTrackEvent(event),
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
        new Subject({ role: "link", name: "Next page", tag: "a" }),
      );
      // The new page's outline gives refs to its own elements; the timeline uses none of them.
      const [text = ""] = texts(Moment.toPrompt(moment));
      const timeline = text.slice(text.indexOf("What happened"));

      assert.match(text, /\[ref=e\d+\]/);
      // The new document's record had only begun, so the click is told as the navigation's cause.
      assert.include(timeline, 'after a click on link "Next page"');
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

      assert.closeTo(recent.at - recent.from, 500, 1e-6);
      assert.isTrue(recent.frames.every((frame) => frame.hostTime >= recent.from));
      assert.isFalse(recent.events.some((event) => event._tag === "Action"));
      assert.closeTo(longer.at - longer.from, 5000, 1e-6);

      const click = longer.events.find(
        (event) => event._tag === "Action" && event.name === "click",
      );

      // The screencast ran from before the click, so the longer window's frames reach back past it.
      assert.isDefined(click);
      assert.isBelow(longer.frames[0]?.hostTime ?? Infinity, click?.at ?? -Infinity);
    }),
  );

  it.effect("tells what a click changed on the page, and the click only as its cause", () =>
    Effect.gen(function* () {
      const page = yield* start("/quote");
      // The first read of a document starts its record, so this moment knows no earlier changes.
      const first = yield* Moment.capture(page);
      const ref = /button "Refresh" \[ref=(e\d+)\]/.exec((yield* page.snapshot()).text)?.[1];

      if (ref === undefined) return yield* Effect.die("the quote has no Refresh button");
      yield* page.click(ref);
      // The page's own script then moves the price twice more, well after the click.
      for (const price of ["$62,100", "$61,900"]) {
        yield* Effect.sleep(Duration.millis(1200));
        yield* Effect.promise(() =>
          page.playwright.evaluate((text) => {
            const element = document.querySelector("#price");

            if (element !== null) element.textContent = text;
          }, price),
        );
      }
      yield* Effect.sleep(Duration.millis(200));
      const second = yield* Moment.capture(page, { since: first });

      assert.deepStrictEqual(first.changes, []);
      assert.isAbove(first.changesFrom ?? -Infinity, first.from);
      assert.isUndefined(second.changesFrom);
      assert.deepStrictEqual(
        second.changes?.map((change) => [change.kind, change.before, change.after, change.context]),
        [
          ["text", "$61,240", "$62,010", 'beside "Price", under "Bitcoin"'],
          ["text", "-1.4%", "+0.3%", 'beside "24h", under "Bitcoin"'],
          ["text", "$62,010", "$62,100", 'beside "Price", under "Bitcoin"'],
          ["text", "$62,100", "$61,900", 'beside "Price", under "Bitcoin"'],
        ],
      );
      for (const change of second.changes ?? []) {
        assert.isAbove(change.at, second.from);
        assert.isAtMost(change.at, second.at);
      }

      const [text = ""] = texts(Moment.toPrompt(second));

      assert.match(
        text,
        /\n-\d\.\ds "\$61,240" became "\$62,010", then "\$62,100", then "\$61,900" \(beside "Price", under "Bitcoin"\), after a click on button "Refresh"\n/,
      );
      assert.match(
        text,
        /\n-\d\.\ds "-1\.4%" became "\+0\.3%" .*after a click on button "Refresh"\n/,
      );
      assert.notMatch(text, /\n-\d\.\ds click/);
    }),
  );

  it.effect(
    "sees tables, arrivals, departures, notices, fields and titles, but not out of view",
    () =>
      Effect.gen(function* () {
        const page = yield* start("/quote");
        const first = yield* Moment.capture(page);

        // Each step is its own burst, well apart, so none is taken for another's cause.
        const step = (change: () => void) =>
          Effect.promise(() => page.playwright.evaluate(change)).pipe(
            Effect.andThen(Effect.sleep(Duration.millis(300))),
          );

        yield* step(() => {
          const cell = document.querySelector("#eth1h");

          if (cell !== null) cell.textContent = "0.5%";
          document.querySelector("#below")?.replaceChildren("Changed below");
          document.title = "Quote, refreshed";
        });
        yield* step(() => {
          const item = document.createElement("li");

          item.textContent = "Second post";
          document.querySelector("#feed")?.append(item);
        });
        yield* step(() => document.querySelector("#feed li")?.remove());
        yield* step(() => document.querySelector("#notice")?.removeAttribute("hidden"));
        const search = /textbox "Search" \[ref=(e\d+)\]/.exec((yield* page.snapshot()).text)?.[1];

        if (search === undefined) return yield* Effect.die("the quote has no search box");
        yield* page.click(search);
        yield* page.type("bitcoin");
        yield* Effect.sleep(Duration.millis(200));
        const second = yield* Moment.capture(page, { since: first });

        assert.deepStrictEqual(
          second.changes?.map((change) => [
            change.kind,
            change.subject.role ?? change.subject.tag,
            change.before ?? null,
            change.after ?? null,
            change.context,
          ]),
          [
            ["title", "title", "Quote", "Quote, refreshed", ""],
            ["text", "td", "0.2%", "0.5%", 'row "Ether", column "1h"'],
            ["appeared", "li", null, "Second post", 'under "Bitcoin"'],
            ["disappeared", "ul", "First post", null, 'under "Bitcoin"'],
            ["appeared", "p", null, "Saved", 'under "Bitcoin"'],
            ["value", "textbox", "", "bitcoin", ""],
          ],
        );

        const [text = ""] = texts(Moment.toPrompt(second));

        assert.include(text, 'textbox "Search" now reads "bitcoin"');
        assert.notInclude(text, "Changed below");
      }),
  );

  it.effect("rejects fewer than one frame, and a window that is not a finite duration", () =>
    Effect.gen(function* () {
      const page = yield* start("/form");

      const invalid: ReadonlyArray<Moment.CaptureOptions> = [
        { frames: 0 },
        { frames: 1.5 },
        { since: -1 },
        { since: Number.NaN },
        { since: "Infinity" },
      ];

      for (const options of invalid) {
        const error = yield* Moment.capture(page, options).pipe(Effect.flip);

        assert.strictEqual(error.reason._tag, "InvalidRequest", JSON.stringify(options));
        assert.isFalse(error.dispatched);
      }
    }),
  );
});
