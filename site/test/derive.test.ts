// A run's chapters, from its recorded events alone: the pages it went to, named as the run named
// them, its searches with their results folded in, and its report.
import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";

import { chapterAt, derive, pageName } from "../src/player/derive.ts";
import { Replay } from "../src/replay.ts";
import { replay } from "./fixture.ts";

describe("pageName", () => {
  const names = ["What price will Bitcoin hit in 2026?", "US-Iran ceasefire continues through...?"];

  it("names a page after the name its address was made from", () => {
    assert.strictEqual(
      pageName("https://polymarket.com/event/what-price-will-bitcoin-hit-before-2027", names),
      "What price will Bitcoin hit in 2026?",
    );
    assert.strictEqual(
      pageName("https://polymarket.com/event/us-iran-ceasefire-continues-throughptptpt", names),
      "US-Iran ceasefire continues through...?",
    );
  });

  it("puts a page no name fits in words, and a site's root as its host", () => {
    assert.strictEqual(
      pageName("https://polymarket.com/event/what-price-will-ethereum-hit", names),
      "What price will ethereum hit",
    );
    assert.strictEqual(pageName("https://www.polymarket.com/", names), "polymarket.com");
    // bea3a16 decoded legal URL paths without guarding malformed percent escapes.
    assert.strictEqual(pageName("https://example.com/offer-50%", names), "Offer 50%");
    assert.strictEqual(pageName("https://example.com/%E0%A4", names), "%E0%A4");
  });
});

describe("chapters", () => {
  const searched = Schema.decodeSync(Replay)({
    ...Schema.encodeSync(Replay)(replay),
    events: [
      {
        sequence: 1,
        event: {
          _tag: "Navigated",
          at: 200,
          page: "p1",
          url: "https://polymarket.com/",
          document: 1,
          sameDocument: false,
        },
      },
      {
        sequence: 2,
        event: {
          _tag: "Action",
          at: 4000,
          startedAt: 3500,
          page: "p1",
          name: "type",
          url: "https://polymarket.com/",
          target: "e7",
          options: {},
          subject: { role: "textbox", name: "Search", tag: "input", context: {} },
          text: "ceasefire",
          ok: true,
          dispatched: true,
        },
      },
      {
        sequence: 3,
        event: {
          _tag: "Navigated",
          at: 5000,
          page: "p1",
          url: "https://polymarket.com/search?_q=ceasefire",
          document: 1,
          sameDocument: true,
        },
      },
      {
        sequence: 4,
        event: {
          _tag: "Navigated",
          at: 9000,
          page: "p1",
          url: "https://polymarket.com/event/us-iran-ceasefire-continues-throughptptpt",
          document: 1,
          sameDocument: true,
        },
      },
    ],
    steps: [
      ...Schema.encodeSync(Replay)(replay).steps,
      { at: 25_000, step: 3, text: "", calls: [{ name: "done", params: {} }], results: [] },
    ],
    outcome: {
      ...Schema.encodeSync(Replay)(replay).outcome,
      answer: {
        markets: [
          {
            title: "US-Iran ceasefire continues through...?",
            outcome: "October 12",
            chance: 97,
            why: "Each date is its own bet.",
          },
        ],
      },
    },
  });

  it("has a chapter per page and search, with the search's results in the search's", () => {
    const { chapters } = derive(searched);

    assert.deepStrictEqual(chapters, [
      { at: 1000, title: "polymarket.com" },
      { at: 3500, title: "Searching for “ceasefire”" },
      { at: 9000, title: "US-Iran ceasefire continues through...?" },
      { at: 25_000, title: "The report" },
    ]);
    assert.strictEqual(chapterAt(chapters, 8999)?.title, "Searching for “ceasefire”");
  });
});
