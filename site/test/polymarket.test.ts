// The demo's check against Polymarket's API.
import { assert, describe, it } from "@effect/vitest";

import { apiChance, type ApiEvent } from "../demo/polymarket.ts";

const events: ReadonlyArray<ApiEvent> = [
  {
    title: "Fed decision in December?",
    markets: [
      {
        question: "Fed cuts 25 bps in December?",
        groupItemTitle: "25 bps decrease",
        outcomes: '["Yes", "No"]',
        outcomePrices: '["0.71", "0.29"]',
      },
      {
        question: "No change in Fed rates in December?",
        groupItemTitle: "No change",
        outcomes: '["Yes", "No"]',
        outcomePrices: '["0.27", "0.73"]',
      },
    ],
  },
  {
    title: "Eagles vs. Jaguars",
    markets: [
      {
        question: "Eagles vs. Jaguars",
        outcomes: '["Eagles", "Jaguars"]',
        outcomePrices: '["0.515", "0.485"]',
      },
    ],
  },
  {
    title: "Old market",
    markets: [
      {
        question: "Old market",
        outcomes: '["Yes","No"]',
        outcomePrices: '["1","0"]',
        closed: true,
      },
    ],
  },
];

const reported = (title: string, outcome: string) => ({ title, outcome, chance: 0, why: "" });

describe("apiChance", () => {
  it("reads an option of a multi-market event by its name", () => {
    assert.deepStrictEqual(apiChance(reported("Fed decision in December", "No change"), events), {
      chance: 27,
    });
  });

  it("reads a binary market's named outcome, whatever the case and punctuation", () => {
    assert.deepStrictEqual(apiChance(reported("eagles vs jaguars", "jaguars"), events), {
      chance: 48.5,
    });
  });

  it("finds a market by its own question", () => {
    assert.deepStrictEqual(apiChance(reported("Fed cuts 25 bps in December?", "Yes"), events), {
      chance: 71,
    });
  });

  it("reads a binary market quoted by the words of its question as its Yes", () => {
    const box: ReadonlyArray<ApiEvent> = [
      {
        title: 'Will "Other Mommy" Opening Weekend Box Office be between 27m and 30m?',
        markets: [
          {
            question: 'Will "Other Mommy" Opening Weekend Box Office be between 27m and 30m?',
            outcomes: '["Yes", "No"]',
            outcomePrices: '["0.56", "0.44"]',
          },
        ],
      },
    ];

    const found = apiChance(
      reported(
        'Will "Other Mommy" Opening Weekend Box Office be between 27m and 30m?',
        "between 27m and 30m",
      ),
      box,
    );

    assert.closeTo("chance" in found ? found.chance : Number.NaN, 56, 1e-9);
  });

  it("says what is missing", () => {
    assert.ok("missing" in apiChance(reported("Old market", "Yes"), events));
    assert.ok("missing" in apiChance(reported("Eagles vs. Jaguars", "Draw"), events));
    assert.ok("missing" in apiChance(reported("Something else", "Yes"), events));
    assert.deepStrictEqual(apiChance(reported("Fed decision in December?", "Yes"), events), {
      missing: '"Yes" is none of its options, 25 bps decrease, No change',
    });
  });
});
