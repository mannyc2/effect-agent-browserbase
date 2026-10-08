// The change record: its rules over many inputs, without a page, and what it records on real pages.
import { assert, describe, it, layer } from "@effect/vitest";
import { Arbitrary, Duration, Effect, Layer, Schema, Stream } from "effect";
import { Prompt } from "effect/ai";

import { Browser } from "../src/Browser.ts";
import { Subject } from "../src/BrowserEvent.ts";
import { Change, Changes } from "../src/Change.ts";
import * as Chromium from "../src/Chromium.ts";
import { fold, type Folded } from "../src/internal/timeline/fold.inpage.ts";
import { type Bounds, history } from "../src/internal/timeline/history.inpage.ts";
import * as Moment from "../src/Moment.ts";
import type { Page } from "../src/Page.ts";
import { Site, SiteLayer } from "./fixtures.ts";

// ---------------------------------------------------------------------------------------------
// The record's rules, on its history alone. A record with small bounds is compared with one that
// keeps everything, given the same notes.

const values = ["$1", "$2", "$3", "$10", null] as const;

const Note = Schema.Struct({
  key: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5 })),
  value: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: values.length - 1 })),
  // 0 is the same batch of mutations as the note before.
  step: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })),
  seen: Schema.Boolean,
});

const notes = Arbitrary.schema(Schema.Array(Note).check(Schema.isMaxLength(60)));
const fraction = Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })));

const keys = Array.from({ length: 6 }, (_, index) => ({ index }));

/** The same notes given to a record of `bounds` and to one that keeps everything. */
const recorded = (
  given: ReadonlyArray<typeof Note.Type>,
  bounds: Bounds,
  seenAlways = false,
) => {
  const capped = history(fold(), bounds);
  const whole = history(fold(), { tracks: Infinity, samples: Infinity, retention: Infinity });
  let at = 1000;

  for (const record of [capped, whole]) record.begin(at);
  for (const { key, value, step, seen } of given) {
    at += step;
    for (const record of [capped, whole]) {
      const target = keys[key] ?? keys[0]!;
      const sample = record.note(target, "content", at, values[value], () => "$0");

      if (sample !== undefined) record.settle(target, sample, undefined, seenAlways || seen);
    }
  }

  return { capped, whole, end: at };
};

/** A window inside the notes' span, by two fractions of it. */
const window = (end: number, start: number, finish: number) => {
  const since = 1000 + ((end - 1000) * Math.min(start, finish)) / 100;

  return { since, until: since + ((end - since) * Math.max(start, finish)) / 100 };
};

const byKey = (folded: ReadonlyArray<Folded>) =>
  new Map(folded.map(({ track, ...rest }) => [track.key, rest]));

const total = (folded: ReadonlyArray<Folded>) => folded.reduce((sum, one) => sum + one.count, 0);

describe("the change record's history", () => {
  it.prop(
    "is whole after `from`: a window there reads as if nothing had been let go",
    { given: notes, start: fraction, finish: fraction },
    ({ given, start, finish }) => {
      const { capped, whole, end } = recorded(given, { tracks: 3, samples: 4, retention: Infinity });
      const { since, until } = window(end, start, finish);
      const read = capped.read(since, until, end);
      const after = Math.max(since, read.from);
      const kept = capped.read(after, until, end);

      assert.strictEqual(kept.dropped, 0);
      assert.deepStrictEqual(byKey(kept.folded), byKey(whole.read(after, until, end).folded));
    },
  );

  it.prop(
    "counts every change it let go, and moves `from` past it",
    { given: notes, start: fraction, finish: fraction },
    ({ given, start, finish }) => {
      const { capped, whole, end } = recorded(given, { tracks: 3, samples: 4, retention: Infinity }, true);
      const { since, until } = window(end, start, finish);
      const read = capped.read(since, until, end);
      const missing = total(whole.read(since, until, end).folded) - total(read.folded);

      assert.isAtLeast(read.dropped, missing);
      if (missing > 0) assert.isAbove(read.from, since);
    },
  );

  it.prop(
    "keeps news where elements keep changing: a single change, once kept, is never let go",
    { given: notes, at: fraction },
    ({ given, at }) => {
      const news = { news: true };
      const record = history(fold(), { tracks: 3, samples: 4, retention: Infinity });
      const cut = Math.floor((given.length * at) / 100);
      let time = 1000;
      let noted: number | undefined;

      record.begin(time);
      for (const [index, { key, value, step, seen }] of given.entries()) {
        time += step + 1;
        if (index === cut) {
          const sample = record.note(news, "content", time, "Order placed", () => null);

          if (sample !== undefined) record.settle(news, sample, undefined, true);
          noted = sample === undefined ? undefined : time;
        }
        const sample = record.note(keys[key] ?? news, "content", time, values[value], () => "$0");

        if (sample !== undefined) record.settle(keys[key] ?? news, sample, undefined, seen);
      }
      const told = record.read(0, time + 1, time + 1).folded.some((one) => one.track.key === news);

      assert.strictEqual(told, noted !== undefined);
    },
  );

  it.prop(
    "counts changes of value, not mutations, and reports a number's lowest and highest",
    { given: notes },
    ({ given }) => {
      const record = history(fold(), { tracks: Infinity, samples: Infinity, retention: Infinity });
      const key = { only: true };
      const shown: Array<string | null> = ["$0"];
      let time = 1000;

      for (const { value } of given) {
        time += 1;
        const sample = record.note(key, "content", time, values[value], () => "$0");

        if (sample !== undefined) record.settle(key, sample, undefined, true);
        if (values[value] !== shown.at(-1)) shown.push(values[value] ?? null);
      }
      const [one] = record.read(0, time, time).folded;
      const words = shown.filter((each) => each !== null);
      const numbers = words.map((each) => Number(each.slice(1)));

      assert.strictEqual(one?.count ?? 0, shown.length - 1);
      if (one === undefined || one.count < 2 || words.length < shown.length) return;
      assert.strictEqual(one.lowest, words[numbers.indexOf(Math.min(...numbers))]);
      assert.strictEqual(one.highest, words[numbers.indexOf(Math.max(...numbers))]);
    },
  );
});

// ---------------------------------------------------------------------------------------------
// A moment's account: news before what keeps changing, whatever the changes.

const Told = Schema.Struct({
  count: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 })),
  earlier: Schema.Boolean,
  startedAt: Schema.Int.check(Schema.isBetween({ minimum: 5000, maximum: 9900 })),
});

const textOf = (prompt: Prompt.Prompt) =>
  prompt.content.flatMap((message) =>
    message.role === "user"
      ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
      : [],
  )[0] ?? "";

describe("a moment's account", () => {
  it.prop(
    "tells news before what keeps changing",
    { told: Arbitrary.schema(Schema.Array(Told).check(Schema.isMinLength(1), Schema.isMaxLength(12))) },
    ({ told }) => {
      const changes = told.map(
        ({ count, earlier, startedAt }, index) =>
          new Change({
            kind: "text",
            subject: new Subject({ role: null, name: "", tag: "span", context: {} }),
            startedAt,
            at: startedAt + 50,
            before: `before-${index}`,
            after: `after-${index}`,
            count,
            earlier: earlier ? startedAt - 100 : undefined,
          }),
      );

      const text = textOf(
        Moment.toPrompt(
          new Moment.Moment({
            page: "p1",
            from: 5000,
            at: 10_000,
            frames: [],
            events: [],
            changes: new Changes({
              document: 0,
              from: 0,
              until: 10_000,
              cursor: 0,
              dropped: 0,
              changes,
            }),
          }),
        ),
      );

      const line = (index: number) => text.indexOf(`"after-${index}"`);
      const news = told.flatMap((one, index) => (one.count === 1 && !one.earlier ? [line(index)] : []));
      const flux = told.flatMap((one, index) => (one.count > 1 || one.earlier ? [line(index)] : []));

      assert.isTrue(
        news.every((at) => at !== -1 && flux.every((later) => at < later)),
        text,
      );
    },
  );
});

// ---------------------------------------------------------------------------------------------
// Real pages.

/** A new tab at `path`, in front and closed with the test. */
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

const run = (page: Page, script: () => void) =>
  Effect.promise(() => page.playwright.evaluate(script));

/** The ref of the one button `name` names. */
const button = (page: Page, name: string) =>
  page.find({ role: "button", name }).pipe(
    Effect.flatMap(([found]) =>
      found === undefined ? Effect.die(`no button ${name}`) : Effect.succeed(found.ref),
    ),
  );

const told = (changes: Changes) =>
  changes.changes.map((change) => [change.kind, change.before, change.after]);

layer(Layer.mergeAll(Chromium.layer(), SiteLayer), {
  excludeTestServices: true,
  timeout: Duration.seconds(60),
})("the change record on a page", (it) => {
  it.effect("tells a toast shown and removed as appeared, then disappeared", () =>
    Effect.gen(function* () {
      const page = yield* start("/desk");
      const first = yield* page.changes();

      yield* run(page, () => {
        const toast = document.createElement("div");

        toast.textContent = "Order placed";
        document.querySelector("#alerts")?.append(toast);
      });
      yield* Effect.sleep(Duration.millis(300));
      const shown = yield* page.changes({ since: first });

      yield* run(page, () => document.querySelector("#alerts div")?.remove());
      yield* Effect.sleep(Duration.millis(300));
      const gone = yield* page.changes({ since: shown });

      assert.deepStrictEqual(told(shown), [["appeared", undefined, "Order placed"]]);
      assert.deepStrictEqual(told(gone), [["disappeared", "Order placed", undefined]]);
      // Over both windows it came and went.
      assert.deepStrictEqual(told(yield* page.changes({ since: first })), [
        ["brief", undefined, "Order placed"],
      ]);
    }),
  );

  it.effect("sees a class and a style show and hide, and nothing out of view or unseen", () =>
    Effect.gen(function* () {
      const page = yield* start("/desk");
      const first = yield* page.changes();

      // The alert a class hid since the page loaded, a line an inline style hid, text below the
      // fold, and text no one can see.
      yield* run(page, () => {
        document.querySelector("#notice")?.classList.remove("closed");
        document.body.insertAdjacentHTML(
          "afterbegin",
          '<p id="tip" style="display:none">Tip: limit orders</p><p>Fee <span id="ghost" style="opacity:0">$1</span></p>',
        );
      });
      yield* Effect.sleep(Duration.millis(300));
      yield* run(page, () => {
        const tip = document.querySelector<HTMLElement>("#tip");
        const ghost = document.querySelector("#ghost");
        const below = document.querySelector("#below");

        if (tip !== null) tip.style.display = "block";
        if (ghost !== null) ghost.textContent = "$2";
        if (below !== null) below.textContent = "Changed below";
      });
      yield* Effect.sleep(Duration.millis(300));
      const shown = yield* page.changes({ since: first });

      yield* run(page, () => document.querySelector("#notice")?.classList.add("closed"));
      yield* Effect.sleep(Duration.millis(300));
      const hidden = yield* page.changes({ since: shown });

      assert.sameDeepMembers(told(shown), [
        ["appeared", undefined, "Market closes early today"],
        ["appeared", undefined, "Tip: limit orders"],
        ["appeared", undefined, "Fee"],
      ]);
      assert.deepStrictEqual(told(hidden), [["disappeared", "Market closes early today", undefined]]);
    }),
  );

  it.effect("puts a one-off \"Order placed\" before a ticker beside it, with the ticker's range", () =>
    Effect.gen(function* () {
      const page = yield* start("/desk");

      yield* page.screencast().pipe(Stream.runDrain, Effect.forkScoped);
      yield* page.changes();
      yield* run(page, () => {
        const prices = [61_240, 61_310, 61_190, 61_450, 61_380];
        let tick = 0;

        setInterval(() => {
          const btc = document.querySelector("#btc");

          if (btc !== null) btc.textContent = `$${(prices[++tick % prices.length] ?? 0).toLocaleString("en-US")}`;
        }, 100);
      });
      yield* Effect.sleep(Duration.millis(700));
      yield* page.click(yield* button(page, "Place order"));
      yield* page.waitForText("Order placed");
      yield* Effect.sleep(Duration.millis(200));
      const moment = yield* Moment.capture(page, { since: Duration.seconds(2) });
      const changes = moment.changes?.changes ?? [];
      const placed = changes.find((change) => change.after === "Order placed");
      const ticker = changes.find((change) => change.subject.context.row === "BTC");

      assert.deepStrictEqual([placed?.kind, placed?.count, placed?.earlier], ["appeared", 1, undefined]);
      assert.isAbove(ticker?.count ?? 0, 3);
      assert.deepStrictEqual([ticker?.lowest, ticker?.highest], ["$61,190", "$61,450"]);
      assert.deepStrictEqual(ticker?.subject.context, { row: "BTC", column: "Price", heading: "Desk" });

      const text = textOf(Moment.toPrompt(moment));

      assert.isBelow(text.indexOf('"Order placed"'), text.indexOf('"$61,'), text);
    }),
  );

  it.effect("counts what a capped burst let go, and moves `from` past it", () =>
    Effect.gen(function* () {
      const page = yield* start("/desk");
      const first = yield* page.changes();

      // News first, then more elements at once than the record keeps.
      yield* run(page, () => {
        document.querySelector("#answer")!.textContent = "Order placed";
      });
      yield* Effect.sleep(Duration.millis(300));
      yield* run(page, () =>
        document.body.insertAdjacentHTML(
          "afterbegin",
          Array.from({ length: 300 }, (_, index) => `<b>Lot ${index}</b>`).join(" "),
        ),
      );
      yield* Effect.sleep(Duration.millis(300));
      const burst = yield* page.changes({ since: first });

      assert.isAtLeast(burst.dropped, 300 - 255);
      assert.isAbove(burst.from, first.until);
      // What came before the burst is still told.
      assert.isTrue(burst.changes.some((change) => change.after === "Order placed"));
      assert.isAtMost(burst.changes.length, 256);
    }),
  );

  it.effect("names no cause for a tick that follows an inert click", () =>
    Effect.gen(function* () {
      const page = yield* start("/desk");
      const menu = yield* button(page, "Menu");

      yield* page.changes();
      yield* run(page, () => {
        let tick = 0;

        setInterval(() => {
          const btc = document.querySelector("#btc");

          if (btc !== null) btc.textContent = `$61,${240 + ++tick * 10}`;
        }, 300);
      });
      yield* Effect.sleep(Duration.millis(900));
      const before = yield* page.changes();

      yield* page.click(menu);
      yield* Effect.sleep(Duration.millis(700));
      const after = yield* page.changes({ since: before });

      assert.isNotEmpty(after.changes);
      assert.isTrue(after.changes.every((change) => change.cause === undefined));
    }),
  );

  it.effect("names the click a delayed answer inside its form followed", () =>
    Effect.gen(function* () {
      const page = yield* start("/desk");

      yield* page.changes();
      yield* page.click(yield* button(page, "Place order"));
      yield* page.waitForText("Order placed");
      yield* Effect.sleep(Duration.millis(100));
      const moment = yield* Moment.capture(page, { since: Duration.seconds(3) });
      const placed = moment.changes?.changes.find((change) => change.after === "Order placed");
      const click = moment.events.find((event) => event._tag === "Action" && event.name === "click");

      // 600 ms on, too late to be direct, but inside the form whose button was clicked.
      assert.isDefined(placed?.cause);
      assert.isAbove(placed?.startedAt ?? 0, (placed?.cause ?? 0) + 500);
      assert.isAtLeast(placed?.cause ?? 0, (click?.at ?? Infinity) - 1000);
      assert.include(textOf(Moment.toPrompt(moment)), 'after click button "Place order"');
    }),
  );

  it.effect("masks what a field holds unless asked, and ends a window at a frame's paint", () =>
    Effect.gen(function* () {
      const page = yield* start("/desk");
      const amount = (yield* page.find({ role: "textbox", name: "Amount" }))[0]?.ref ?? "";

      yield* page.screencast().pipe(Stream.runDrain, Effect.forkScoped);
      const first = yield* page.changes();

      yield* page.type("25", { into: amount });
      yield* Effect.sleep(Duration.millis(300));
      const frame = yield* page.frame({ maxAge: 0 });

      yield* run(page, () => {
        document.querySelector("#btc")!.textContent = "$70,000";
      });
      yield* Effect.sleep(Duration.millis(300));

      const typed = (changes: Changes) =>
        changes.changes.find((change) => change.kind === "value")?.after;

      assert.strictEqual(typed(yield* page.changes({ since: first })), "••••");
      assert.strictEqual(typed(yield* page.changes({ since: first, unmask: true })), "25");
      // A window that ends at the frame holds nothing painted after it.
      assert.isFalse(
        (yield* page.changes({ since: first, until: frame })).changes.some(
          (change) => change.after === "$70,000",
        ),
      );
    }),
  );

  it.effect("continues each read where the last ended, and records a new document from its start", () =>
    Effect.gen(function* () {
      const page = yield* start("/desk");
      const reads = [yield* page.changes()];

      for (const price of ["$1", "$2", "$3", "$4"]) {
        yield* Effect.promise(() =>
          page.playwright.evaluate((text) => {
            document.querySelector("#btc")!.textContent = text;
          }, price),
        );
        yield* Effect.sleep(Duration.millis(50));
        reads.push(yield* page.changes({ since: reads.at(-1) }));
      }
      // Four windows, each holding its one change, each starting where the last ended.
      assert.deepStrictEqual(
        reads.slice(1).map(told),
        [
          [["text", "$61,240", "$1"]],
          [["text", "$1", "$2"]],
          [["text", "$2", "$3"]],
          [["text", "$3", "$4"]],
        ],
      );

      // The page's next document records from its start, with no read of its own.
      yield* page.goto((yield* Site).url("/desk"));
      yield* run(page, () => {
        document.querySelector("#answer")!.textContent = "Order placed";
      });
      yield* Effect.sleep(Duration.millis(300));
      const next = yield* page.changes();

      assert.strictEqual(next.document, reads[0]!.document + 1);
      assert.deepStrictEqual(told(next), [["appeared", undefined, "Order placed"]]);
    }),
  );
});
