// The market board's tasks: seeded changes the page never gives away, and grading that judges what
// an answer says rather than how it says it. No model is called.
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Schedule } from "effect";
import { Browser } from "effect-browser/Browser";
import * as Chromium from "effect-browser/Chromium";
import * as Moment from "effect-browser/Moment";

import { tasks } from "../Catalog.ts";
import { BoardTruth, origin, routes, serve, truth } from "../Sites.ts";
import {
  assetsIn,
  type BoardAnswer,
  feed,
  frameHistory,
  gradeBoard,
  gradeCaption,
  gradeFlux,
} from "../Tasks.ts";
import { modelOf } from "./scripted.ts";

const tick: BoardAnswer = {
  priceChanged: true,
  asset: "SOL-USD",
  table: "Perpetual futures",
  priceBefore: 149.52,
  priceAfter: 149.31,
  noticeShown: false,
  notice: "",
};

const alert: BoardAnswer = {
  priceChanged: false,
  asset: "",
  table: "",
  priceBefore: null,
  priceAfter: null,
  noticeShown: true,
  notice: "Price alert: BTC-USD crossed $64,000.00",
};

const nothing: BoardAnswer = { ...alert, noticeShown: false, notice: "" };

describe("board grading", () => {
  for (const answer of [
    tick,
    { ...tick, asset: "sol", table: "perps" },
    { ...tick, asset: "Solana (SOLUSD)", table: "the Perpetual Futures table" },
    { ...tick, priceBefore: 149.520_01, priceAfter: 149.31 },
  ])
    it(`accepts the tick told as ${answer.asset} in ${answer.table}`, () =>
      assert.isTrue(gradeBoard(answer, tick).pass, gradeBoard(answer, tick).detail));

  for (const [wrong, answer] of [
    ["asset", { ...tick, asset: "ETH-USD" }],
    ["second asset", { ...tick, asset: "SOL-USD or ETH-USD" }],
    ["table", { ...tick, table: "Spot markets" }],
    ["swapped prices", { ...tick, priceBefore: 149.31, priceAfter: 149.52 }],
    ["final price only", { ...tick, priceBefore: null }],
    ["missed change", nothing],
    ["invented notice", { ...tick, noticeShown: true, notice: "SOL moved" }],
  ] as const)
    it(`rejects a tick with the wrong ${wrong}`, () =>
      assert.isFalse(gradeBoard(answer, tick).pass, gradeBoard(answer, tick).detail));

  for (const notice of [
    "Price alert: BTC-USD crossed $64,000.00",
    "An alert said Bitcoin had crossed 64000",
    "btc crossed $64,000",
    "Bitcoin crossed 64,000 about 1.4 seconds before the moment; see the link in the alert",
  ])
    it(`accepts the alert told as "${notice}"`, () =>
      assert.isTrue(gradeBoard({ ...alert, notice }, alert).pass));

  for (const notice of [
    "Price alert: BTC-USD crossed $65,000.00",
    "Price alert: ETH-USD crossed",
    "BTC-USD crossed $64,000 or $65,000",
    "BTC-USD or ETH-USD crossed $64,000",
  ])
    it(`rejects the alert told as "${notice}"`, () =>
      assert.isFalse(gradeBoard({ ...alert, notice }, alert).pass));

  it("reads a ticker that is also a word only where it names the asset", () => {
    assert.deepStrictEqual(assetsIn("LINK crossed $15.00"), ["LINK"]);
    assert.deepStrictEqual(assetsIn("link-usd, Chainlink"), ["LINK"]);
    assert.deepStrictEqual(assetsIn("SOL-USD, with a link to the chart, dot points, etc."), [
      "SOL",
    ]);
    assert.deepStrictEqual(assetsIn("sol, btc and Eth"), ["BTC", "ETH"]);
  });

  it("rejects a change or a notice where nothing happened", () => {
    assert.isTrue(gradeBoard(nothing, nothing).pass);
    assert.isFalse(gradeBoard(tick, nothing).pass);
    assert.isFalse(gradeBoard(alert, nothing).pass);
  });

  // SOL-USD stopped ticking at $147.10; ETH-USD still ticks.
  const churns = [
    { ticker: "SOL-USD", table: "Spot markets", settles: true, stoppedAt: 1 },
    { ticker: "ETH-USD", table: "Perpetual futures", settles: false, stoppedAt: null },
  ].map((churn) => ({ ...churn, first: 146.2, price: 147.1, ticks: 4 }));

  it("holds a list of what still changes and what settled to which is which, and at what", () => {
    const settled = { asset: "Solana", state: "settled", price: 147.1 } as const;
    const changing = { asset: "ETH-USD", state: "still changing", price: null } as const;

    assert.isTrue(gradeFlux({ changes: [changing, settled] }, churns).pass);
    assert.isFalse(gradeFlux({ changes: [settled] }, churns).pass);
    assert.isFalse(
      gradeFlux({ changes: [{ ...changing, state: "settled" }, settled] }, churns).pass,
    );
    assert.isFalse(gradeFlux({ changes: [changing, { ...settled, price: 146.2 }] }, churns).pass);
    assert.isFalse(
      gradeFlux({ changes: [changing, settled, { ...settled, asset: "BTC" }] }, churns).pass,
    );
  });

  it("finds a caption misstating what moves or rests, by what it says of each price", () => {
    const verdicts = (caption: string) =>
      gradeCaption({ caption }, churns).detail.split("; answered")[0];

    for (const [caption, verdict] of [
      [
        "SOL-USD settles at $147.10 while ETH-USD continues fluctuating, now at $3,152.61.",
        "SOL-USD settled: told, ETH-USD moving: told",
      ],
      [
        "SOL-USD rises to $147.10 and ETH-USD rises to $3,152.61.",
        "SOL-USD settled: told, ETH-USD moving: misstated",
      ],
      [
        "Live quotes: SOL-USD rises to $147.10 and ETH-USD holds at $3,152.61.",
        "SOL-USD settled: told, ETH-USD moving: misstated",
      ],
      [
        "ETH-USD is $3,152.61 and Solana is $147.10, both fluctuating.",
        "SOL-USD settled: misstated, ETH-USD moving: told",
      ],
      ["The market board shows prices.", "SOL-USD settled: missed, ETH-USD moving: missed"],
    ] as const)
      assert.strictEqual(verdicts(caption), verdict, caption);
  });
});

/** Push one of the board's feed events, then read what the page shows and holds. */
const pushed = (seed: number, push: "tick" | "flash") =>
  Effect.gen(function* () {
    const browser = yield* Browser;

    yield* serve(browser, seed);
    const page = yield* browser.firstPage;

    yield* page.goto(origin + routes.board);
    yield* feed(page, push);
    if (push === "flash")
      yield* truth(page, BoardTruth).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("50 millis"),
          until: (board) => board.hiddenAt !== null,
        }),
      );
    const board = yield* truth(page, BoardTruth);

    const text = yield* Effect.promise(() =>
      page.playwright.evaluate(() => document.body.innerText),
    );

    return { board, text, title: yield* page.title };
  }).pipe(Effect.scoped, Effect.provide(Chromium.layer()));

const money = (value: number) =>
  "$" +
  value.toLocaleString("en-US", {
    minimumFractionDigits: value < 1 ? 4 : 2,
    maximumFractionDigits: value < 1 ? 4 : 2,
  });

describe("board fixture", () => {
  it.live("varies the tick with the seed and keeps no trace of the former price", () =>
    Effect.gen(function* () {
      const seen = new Set<string>();

      for (const seed of [1, 2, 3, 4, 5, 6]) {
        const { board, text, title } = yield* pushed(seed, "tick");
        const change = board.change;

        if (change === null) throw new Error("the tick changed nothing");
        seen.add(`${change.ticker} ${change.table}`);
        assert.notStrictEqual(change.before, change.after);
        assert.include(text, money(change.after));
        assert.notInclude(text, money(change.before));
        assert.strictEqual(title, "Market board | Harbor Markets");
      }

      assert.isAtLeast(seen.size, 4);
    }),
  );

  it.live("varies the alert with the seed and removes every trace of it", () =>
    Effect.gen(function* () {
      const seen = new Set<string>();

      for (const seed of [1, 2, 3, 4, 5, 6]) {
        const { board, text } = yield* pushed(seed, "flash");
        const notice = board.notice;

        if (notice === null) throw new Error("the flash showed nothing");
        seen.add(notice.text);
        assert.notInclude(text, notice.text);
        assert.notInclude(text, money(notice.level));
      }

      assert.isAtLeast(seen.size, 4);
    }),
  );
});

describe("board tasks", () => {
  // A describer that always says nothing changed, as a narrator that only compares outlines does.
  const unchanged = modelOf(() =>
    Effect.succeed([
      { type: "text", text: JSON.stringify(nothing) },
      {
        type: "finish",
        reason: "stop",
        usage: { inputTokens: { total: 1200 }, outputTokens: { total: 40 } },
      },
    ]),
  );

  for (const [name, passes] of [
    ["board-tick", false],
    ["board-flash", false],
    ["board-scrolled", false],
    ["board-steady", true],
  ] as const)
    it.live(`"nothing changed" ${passes ? "passes" : "fails"} ${name}`, () =>
      Effect.gen(function* () {
        const task = tasks.find((candidate) => candidate.name === name);

        if (task === undefined) throw new Error(`no task ${name}`);

        const outcome = yield* task
          .withModel({ seed: 23, onUsage: () => Effect.void })
          .pipe(Effect.provide(Layer.merge(Chromium.layer({ frameHistory }), unchanged)));

        assert.strictEqual(outcome.pass, passes, outcome.detail);
      }),
    );

  // What a moment adds beyond its frames: its changes tell the price that no picture holds.
  it.live("board-scrolled's moment tells the price that changed before the scroll", () =>
    Effect.gen(function* () {
      const task = tasks.find((candidate) => candidate.name === "board-scrolled");
      const told: Array<{ readonly prompt: string; readonly expected: BoardAnswer }> = [];

      if (task === undefined) throw new Error("no task board-scrolled");
      yield* task
        .withModel({
          seed: 7,
          onUsage: () => Effect.void,
          trace: (entry) =>
            Effect.sync(() => {
              if (entry._tag !== "Moment") return;

              const [text] = Moment.toPrompt(entry.moment).content.flatMap((message) =>
                message.role === "user"
                  ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
                  : [],
              );

              told.push({ prompt: text ?? "", expected: entry.expected as BoardAnswer });
            }),
        })
        .pipe(Effect.provide(Layer.merge(Chromium.layer({ frameHistory }), unchanged)));

      const [{ prompt, expected } = { prompt: "", expected: nothing }] = told;

      assert.isNotNull(expected.priceAfter);
      assert.include(prompt, money(expected.priceAfter ?? 0), prompt);
      assert.include(prompt, money(expected.priceBefore ?? 0), prompt);
    }),
  );
});
