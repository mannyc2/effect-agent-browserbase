// The fixtures' seeded data, read independently of their grading: a seed replays its page, another
// changes the graded values, and the page shows what its truth says. The gates run every task's
// scripted solution.
import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Browser } from "effect-browser/Browser";

import { MarketTruth, origin, QuoteTruth, routes, serve, truth } from "../Sites.ts";
import * as Chromium from "./browser.ts";

/** Read the visible cells independently of the fixture's grading values. */
const quotePage = (path: string, seed: number) =>
  Effect.gen(function* () {
    const browser = yield* Browser;

    yield* serve(browser, seed);
    const page = yield* browser.firstPage;

    yield* page.goto(origin + path);
    const expected = yield* truth(page, QuoteTruth);

    const {
      value: { headers, cells },
    } = yield* page.read(
      (expected) => {
        const table = Array.from(document.querySelectorAll("table")).find(
          (table) => table.getAttribute("aria-label") === expected.table,
        );

        const row = Array.from(table?.querySelectorAll("tr") ?? []).find((row) =>
          row.textContent?.includes(expected.focus),
        );

        return {
          headers: Array.from(
            table?.querySelectorAll("th") ?? [],
            (cell) => cell.textContent ?? "",
          ),
          cells: Array.from(row?.querySelectorAll("td") ?? [], (cell) => cell.textContent ?? ""),
        };
      },
      {
        arg: expected,
        result: Schema.Struct({
          headers: Schema.Array(Schema.String),
          cells: Schema.Array(Schema.String),
        }),
      },
    );

    return { expected, headers, cells };
  }).pipe(Effect.scoped, Effect.provide(Chromium.layer()));

describe("quote fixtures", () => {
  it.live("replays a seed and changes the graded values for another trial", () =>
    Effect.gen(function* () {
      const first = yield* quotePage(routes.denseQuotes, 23);
      const replay = yield* quotePage(routes.denseQuotes, 23);
      const other = yield* quotePage(routes.denseQuotes, 24);

      assert.deepStrictEqual(replay, first);
      assert.notDeepEqual(other.expected, first.expected);
    }),
  );

  for (const path of [routes.quotes, routes.denseQuotes]) {
    it.live(`renders the requested row under its real percentage headers on ${path}`, () =>
      Effect.gen(function* () {
        const { expected, headers, cells } = yield* quotePage(path, 23);

        const value = (header: string) =>
          Number((cells[headers.indexOf(header)] ?? "").replace(/[$,%+]/g, ""));

        assert.include(cells, expected.focus);
        assert.strictEqual(value("Price"), expected.price);
        assert.strictEqual(value("1h %"), expected.c1h);
        assert.strictEqual(value("24h %"), expected.c24h);
        assert.strictEqual(value("7d %"), expected.c7d);
      }),
    );
  }
});

describe("market fixture", () => {
  it.live("drifts up for even seeds and down for odd ones, so no constant trend passes", () =>
    Effect.gen(function* () {
      const browser = yield* Browser;
      const trends: Array<string> = [];

      // The newest route serves each page, so every page is seeded with its own trial.
      for (const seed of [10, 11, 12, 13]) {
        yield* serve(browser, seed);
        const page = yield* browser.newPage(origin + routes.order);

        trends.push((yield* truth(page, MarketTruth)).trend);
        yield* page.close;
      }

      assert.deepStrictEqual(trends, ["up", "down", "up", "down"]);
    }).pipe(Effect.scoped, Effect.provide(Chromium.layer())),
  );
});
