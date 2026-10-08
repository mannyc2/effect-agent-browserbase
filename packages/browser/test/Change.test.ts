// The change record: its rules over many inputs, without a page, and what it records on real pages.
import { assert, describe, it, layer } from "@effect/vitest";
import { Arbitrary, Duration, Effect, Layer, Schema, Stream } from "effect";
import { type Prompt } from "effect/ai";

import { Browser } from "../src/Browser.ts";
import { Action, Subject } from "../src/BrowserEvent.ts";
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
  // Read as the page renders it, as what arrived is, rather than at once, as a price is.
  rendered: Schema.Boolean,
});

const notes = Arbitrary.schema(Schema.Array(Note).check(Schema.isMaxLength(60)));
const fraction = Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })));

const keys = Array.from({ length: 6 }, (_, index) => ({ index }));

/** The same notes given to a record of `bounds` and to one that keeps everything. */
const recorded = (given: ReadonlyArray<typeof Note.Type>, bounds: Bounds, seenAlways = false) => {
  const capped = history(fold(), bounds);
  const whole = history(fold(), { tracks: Infinity, samples: Infinity, retention: Infinity });
  let at = 1000;

  for (const record of [capped, whole]) record.begin(at);
  for (const { key, value, step, seen, rendered } of given) {
    at += step;
    for (const record of [capped, whole])
      noted(record, keys[key]!, at, values[value] ?? null, seenAlways || seen, rendered);
  }

  return { capped, whole, end: at };
};

/** A note as the recorder makes it: what it shows known at once, or judged as the page renders. */
const noted = (
  record: ReturnType<typeof history>,
  key: object,
  at: number,
  shown: string | null,
  seen: boolean,
  rendered = false,
) => {
  const sample = record.note(key, "content", at, rendered ? undefined : shown, () => "$0");

  if (sample !== undefined && rendered) record.settle(key, sample, shown, seen);
  else if (sample !== undefined) sample.seen = seen;
};

/** A window inside the notes' span, by two fractions of it. */
const window = (end: number, start: number, finish: number) => {
  const since = 1000 + ((end - 1000) * Math.min(start, finish)) / 100;

  return { since, until: since + ((end - since) * Math.max(start, finish)) / 100 };
};

const byKey = (folded: ReadonlyArray<Folded>) =>
  new Map(folded.map(({ track, ...rest }) => [track.key, rest]));

const total = (folded: ReadonlyArray<Folded>) => folded.reduce((sum, one) => sum + one.count, 0);

// Elements fewer than the keys, so they give way; or changes per element fewer, so they do.
const bounded = Arbitrary.schema(Schema.Literals([0, 1])).pipe(
  Arbitrary.map((which) =>
    which === 0
      ? { tracks: 3, samples: 4, retention: Infinity }
      : { tracks: 6, samples: 2, retention: Infinity },
  ),
);

describe("the change record's history", () => {
  it.prop(
    "is whole after `from`: a window there reads as if nothing had been let go",
    { given: notes, bounds: bounded, start: fraction, finish: fraction },
    ({ given, bounds, start, finish }) => {
      const { capped, whole, end } = recorded(given, bounds);
      const { since, until } = window(end, start, finish);
      const read = capped.read(since, until, end);
      const after = Math.max(since, read.from);
      const kept = capped.read(after, until, end);

      assert.strictEqual(kept.dropped, 0);
      assert.deepStrictEqual(byKey(kept.folded), byKey(whole.read(after, until, end).folded));
    },
  );

  it.prop(
    "never states what an element showed at `since` that it does not know",
    { given: notes, bounds: bounded, start: fraction, finish: fraction },
    ({ given, bounds, start, finish }) => {
      const { capped, whole, end } = recorded(given, bounds);
      const { since, until } = window(end, start, finish);
      const truth = byKey(whole.read(since, until, end).folded);

      for (const { track, before } of capped.read(since, until, end).folded)
        if (before !== undefined) assert.strictEqual(before, truth.get(track.key)?.before);
    },
  );

  it.prop(
    "counts every change it let go, and moves `from` past it",
    { given: notes, bounds: bounded, start: fraction, finish: fraction },
    ({ given, bounds, start, finish }) => {
      const { capped, whole, end } = recorded(given, bounds, true);
      const { since, until } = window(end, start, finish);
      const read = capped.read(since, until, end);
      const missing = total(whole.read(since, until, end).folded) - total(read.folded);
      const kept = capped.read(0, end, end).folded;

      assert.isAtLeast(read.dropped, missing);
      if (missing > 0) assert.isAbove(read.from, since);
      // What it keeps stays within its bounds.
      assert.isAtMost(kept.length, bounds.tracks);
      for (const { track } of kept) assert.isAtMost(track.samples.length, bounds.samples);
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
      let placedAt: number | undefined;

      record.begin(time);
      for (const [index, { key, value, step, seen, rendered }] of given.entries()) {
        time += step + 1;
        if (index === cut) {
          const sample = record.note(news, "content", time, "Order placed", () => null);

          if (sample !== undefined) sample.seen = true;
          placedAt = sample === undefined ? undefined : time;
        }
        noted(record, keys[key]!, time, values[value] ?? null, seen, rendered);
      }
      const told = record.read(0, time + 1, time + 1).folded.some((one) => one.track.key === news);

      assert.strictEqual(told, placedAt !== undefined);
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

      for (const { value, rendered } of given) {
        time += 1;
        noted(record, key, time, values[value] ?? null, true, rendered);
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
  const click = (name: string, startedAt: number) =>
    new Action({
      at: startedAt + 100,
      startedAt,
      page: "p1",
      name: "click",
      subject: new Subject({ role: "button", name, tag: "button", context: {} }),
      ok: true,
      dispatched: true,
    });

  const appeared = (after: string, at: number, cause?: number) =>
    new Change({
      kind: "appeared",
      subject: new Subject({ role: null, name: "", tag: "li", context: {} }),
      startedAt: at,
      at,
      after,
      count: 1,
      cause,
    });

  const recorded = (from: number, changes: ReadonlyArray<Change>) =>
    new Changes({ document: 0, from, until: 10_000, cursor: 0, dropped: 0, changes });

  const moment = (events: ReadonlyArray<Action>, changes?: Changes) =>
    textOf(
      Moment.toPrompt(
        new Moment.Moment({
          page: "p1",
          since: 5000,
          until: 10_000,
          frames: [],
          events,
          changes,
          missing: [],
        }),
      ),
    );

  it("names as a cause only an action that ran as the input arrived", () => {
    // The line that tells what appeared after a click that began at `startedAt`.
    const placed = (startedAt: number) =>
      moment([click("Place order", startedAt)], recorded(0, [appeared("Order placed", 8600, 8000)]))
        .split("\n")
        .find((line) => line.includes('"Order placed"'));

    assert.include(placed(7950), '"Place order"');
    // A click that had ended before the input came did not send it.
    assert.notInclude(placed(6000), '"Place order"');
  });

  it("tells as a step an action that changes followed and none names, and no other", () => {
    const text = moment(
      [click("Options", 6000), click("Load more", 7000), click("Menu", 9000)],
      recorded(0, [appeared("Share", 6050, 6050), appeared("Result 2", 7800)]),
    );

    // Options is named once, as what its menu followed; Load more, whose results came out of its
    // reach, as a step; and Menu, which nothing followed, not at all.
    assert.strictEqual(text.split('"Options"').length, 2, text);
    assert.include(text, '"Load more"');
    assert.notInclude(text, '"Menu"');
  });

  it("says no more of a window its record did not see than with no record", () => {
    const events = [click("Load more", 7000)];

    // A page's first moment: its record begins as the moment ends.
    assert.strictEqual(moment(events, recorded(10_000, [])), moment(events));
  });

  it.prop(
    "tells news before what keeps changing",
    {
      told: Arbitrary.schema(
        Schema.Array(Told).check(Schema.isMinLength(1), Schema.isMaxLength(12)),
      ),
    },
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
            since: 5000,
            until: 10_000,
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
            missing: [],
          }),
        ),
      );

      const line = (index: number) => text.indexOf(`"after-${index}"`);

      const news = told.flatMap((one, index) =>
        one.count === 1 && !one.earlier ? [line(index)] : [],
      );

      const flux = told.flatMap((one, index) =>
        one.count > 1 || one.earlier ? [line(index)] : [],
      );

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
  page
    .find({ role: "button", name })
    .pipe(
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
      assert.deepStrictEqual(told(hidden), [
        ["disappeared", "Market closes early today", undefined],
      ]);
    }),
  );

  it.effect(
    'tells a one-off "Order placed" as news beside a ticker, with the ticker\'s range',
    () =>
      Effect.gen(function* () {
        const page = yield* start("/desk");

        yield* page.screencast().pipe(Stream.runDrain, Effect.forkScoped);
        yield* page.changes();
        yield* run(page, () => {
          const prices = [61_240, 61_310, 61_190, 61_450, 61_380];
          let tick = 0;

          setInterval(() => {
            const btc = document.querySelector("#btc");

            if (btc !== null)
              btc.textContent = `$${(prices[++tick % prices.length] ?? 0).toLocaleString("en-US")}`;
          }, 100);
        });
        yield* Effect.sleep(Duration.millis(700));
        yield* page.click(yield* button(page, "Place order"));
        yield* page.waitFor({ text: "Order placed" });
        yield* Effect.sleep(Duration.millis(200));
        const moment = yield* Moment.capture(page, { since: Duration.seconds(2) });
        const changes = moment.changes?.changes ?? [];
        const placed = changes.find((change) => change.after === "Order placed");
        const ticker = changes.find((change) => change.subject.context.row === "BTC");

        assert.deepStrictEqual(
          [placed?.kind, placed?.count, placed?.earlier],
          ["appeared", 1, undefined],
        );
        assert.isAbove(ticker?.count ?? 0, 3);
        assert.deepStrictEqual([ticker?.lowest, ticker?.highest], ["$61,190", "$61,450"]);
        assert.deepStrictEqual(ticker?.subject.context, {
          row: "BTC",
          column: "Price",
          heading: "Desk",
        });
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

  it.effect("names no cause for what changes on its own after an inert click", () =>
    Effect.gen(function* () {
      const page = yield* start("/desk");
      const menu = yield* button(page, "Menu");

      const tick = run(page, () => {
        const btc = document.querySelector("#btc");

        if (btc !== null) btc.textContent = `$61,${Number(btc.textContent?.slice(-3)) + 10}`;
      });

      // The page's own feed adds a line elsewhere 250 ms on, as a chat does.
      const line = run(page, () => {
        setTimeout(
          () => document.querySelector("#alerts")?.insertAdjacentHTML("beforeend", "<p>gg wp</p>"),
          250,
        );
      });

      yield* page.changes();
      // A line follows a click on a page that ticked a second before.
      yield* tick;
      yield* Effect.sleep(Duration.millis(1000));
      const ticked = yield* page.changes();

      yield* line;
      yield* page.click(menu);
      yield* Effect.sleep(Duration.millis(2500));
      const busy = yield* page.changes({ since: ticked });

      // On a page still for two seconds, a slow ticker ticks just after a click, and the feed
      // adds a line again.
      yield* line;
      yield* page.click(menu);
      yield* tick;
      yield* Effect.sleep(Duration.millis(400));
      const still = yield* page.changes({ since: busy });

      assert.deepStrictEqual(told(busy), [["appeared", undefined, "gg wp"]]);
      assert.sameDeepMembers(told(still), [
        ["text", "$61,250", "$61,260"],
        ["appeared", undefined, "gg wp"],
      ]);
      // None names the click: the line on a busy page, the slow tick, nor the feed's next line.
      assert.deepStrictEqual(
        [busy, still].flatMap(({ changes }) =>
          changes.flatMap((change) => (change.cause === undefined ? [] : [change.after])),
        ),
        [],
      );
    }),
  );

  it.effect(
    "names the click its effects followed, out of its reach on a still page or later in its form",
    () =>
      Effect.gen(function* () {
        const page = yield* start("/desk");

        // Menu opens a menu where a portal puts it, at the end of the body, and its item a dialog.
        yield* run(page, () =>
          document.addEventListener("click", ({ target }) => {
            const opens =
              target instanceof Element && target.id === "menu"
                ? '<div role="menu" style="position:fixed;top:40px;left:200px"><button type="button" role="menuitem">Share</button></div>'
                : target instanceof Element && target.getAttribute("role") === "menuitem"
                  ? '<div role="dialog" style="position:fixed;top:80px;left:200px">Share this page</div>'
                  : "";

            document.body.insertAdjacentHTML("beforeend", opens);
          }),
        );
        yield* page.changes();
        yield* page.click(yield* button(page, "Menu"));
        yield* page.click(
          (yield* page.find({ role: "menuitem", name: "Share" }))[0]?.ref ?? "no menu",
        );
        yield* page.click(yield* button(page, "Place order"));
        yield* page.waitFor({ text: "Order placed" });
        yield* Effect.sleep(Duration.millis(100));
        const moment = yield* Moment.capture(page, { since: Duration.seconds(3) });
        const changes = moment.changes?.changes ?? [];
        const changed = (after: string) => changes.find((change) => change.after === after);
        const [menu, sheet, placed] = ["Share", "Share this page", "Order placed"].map(changed);

        // At once, out of reach: the menu, and the dialog, though the menu holding the item that
        // opened it came just before.
        assert.isDefined(menu?.cause);
        assert.isAbove(sheet?.cause ?? 0, menu?.cause ?? Infinity);
        // 600 ms on, too late to be direct, but inside the form whose button was clicked.
        assert.isAbove(placed?.cause ?? 0, sheet?.cause ?? Infinity);
        assert.isAbove(placed?.startedAt ?? 0, (placed?.cause ?? Infinity) + 500);
      }),
  );

  it.effect("masks what a field holds unless asked, and ends a window at a frame's paint", () =>
    Effect.gen(function* () {
      const page = yield* start("/desk");
      const field = (name: string) => page.find({ role: "textbox", name });
      const amount = (yield* field("Amount"))[0]?.ref ?? "";
      const memo = (yield* field("Memo"))[0]?.ref ?? "";
      const pin = (yield* field("PIN"))[0]?.ref ?? "";

      yield* page.screencast().pipe(Stream.runDrain, Effect.forkScoped);
      const first = yield* page.changes();

      yield* page.type("25", { into: amount });
      yield* page.type("sell at 70k", { into: memo });
      yield* page.type("4321", { into: pin });
      yield* Effect.sleep(Duration.millis(300));
      const frame = yield* page.frame({ maxAge: 0 });

      yield* run(page, () => {
        document.querySelector("#btc")!.textContent = "$70,000";
      });
      yield* Effect.sleep(Duration.millis(300));

      const typed = (changes: Changes) =>
        changes.changes.flatMap((change) => (change.kind === "value" ? [change.after] : []));

      const masked = yield* page.changes({ since: first });

      // What was typed shows only as a field's value, masked, in an editable region too, and a
      // secret field's stays masked when unmasked.
      assert.deepStrictEqual(typed(masked), ["••••", "••••", "••••"]);
      assert.notInclude(JSON.stringify(masked), "sell");
      assert.deepStrictEqual(typed(yield* page.changes({ since: first, unmask: true })), [
        "25",
        "sell at 70k",
        "••••",
      ]);
      // A window that ends at the frame holds nothing painted after it.
      assert.isFalse(
        (yield* page.changes({ since: first, until: frame })).changes.some(
          (change) => change.after === "$70,000",
        ),
      );
    }),
  );

  it.effect(
    "continues each read where the last ended, and records a new document from its start",
    () =>
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
        assert.deepStrictEqual(reads.slice(1).map(told), [
          [["text", "$61,240", "$1"]],
          [["text", "$1", "$2"]],
          [["text", "$2", "$3"]],
          [["text", "$3", "$4"]],
        ]);

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
