import { assert, describe, it, layer } from "@effect/vitest";
import { Duration, Effect, Schema, Stream } from "effect";
import { Browser } from "effect-browser/Browser";
import * as Chromium from "effect-browser/Chromium";
import { LanguageModel, type Prompt } from "effect/ai";

import * as Comparison from "../QuoteComparison.ts";
import { origin, routes, serve } from "../Sites.ts";
import { trialSeed } from "../Trial.ts";

const pictures = (prompt: Prompt.Prompt) =>
  prompt.content.flatMap((message) =>
    message.role === "user"
      ? message.content.flatMap((part) =>
          part.type === "file" && part.mediaType.startsWith("image/") ? [part] : [],
        )
      : [],
  );

const textOf = (prompt: Prompt.Prompt) =>
  prompt.content
    .flatMap((message) =>
      message.role === "system"
        ? [message.content]
        : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
    )
    .join("\n");

describe("quote baseline text", () => {
  it("keeps at most 4000 UTF-8 bytes without splitting a character", () => {
    for (const text of [
      "a".repeat(3999) + "é",
      "a".repeat(3998) + "é",
      "a".repeat(3998) + "字",
      "a".repeat(3997) + "😀",
      "é".repeat(3000),
    ]) {
      const clipped = Comparison.clipVisibleText(text);

      assert.isAtMost(new TextEncoder().encode(clipped).length, 4000);
      assert.notInclude(clipped, "�");
      assert.isTrue(text.startsWith(clipped));
    }
    assert.strictEqual(Comparison.clipVisibleText("a".repeat(3999) + "é"), "a".repeat(3999));
    assert.strictEqual(Comparison.clipVisibleText("a".repeat(3998) + "é"), "a".repeat(3998) + "é");
  });
});

layer(Chromium.layer(), { excludeTestServices: true, timeout: Duration.seconds(60) })(
  "quote comparison",
  (it) => {
    it.effect("reads every visible quote table of 20 dense native fixtures", () =>
      Effect.gen(function* () {
        const browser = yield* Browser;
        const tablePositions = new Set<number>();
        const periodPositions = new Set<number>();
        const tickers = new Set<string>();

        for (let trial = 1; trial <= 20; trial++) {
          const seed = trialSeed(1, "quote-dense", trial);
          const captured = yield* Comparison.prepare({ seed, dense: true });
          const { tables } = captured.facts.evidence;
          const answer = Comparison.answerFrom(captured.facts);

          // Fixture truth is an independent grader here, never the extraction input.
          assert.deepStrictEqual(answer, captured.expected);
          assert.deepStrictEqual(tables.map((table) => table.caption).toSorted(), [
            "Evening watchlist",
            "Perpetual futures",
            "Spot markets",
          ]);
          assert.isTrue(tables.every((table) => table.rows.length === 10));
          assert.strictEqual(captured.moment.frames.length, 1);
          assert.strictEqual(captured.moment.frames[0]?.timing._tag, "BrowserPaint");
          assert.deepStrictEqual(captured.facts.observation, {
            page: captured.moment.page,
            url: captured.moment.snapshot.url,
            at: captured.moment.at,
          });
          assert.strictEqual(captured.question, Comparison.question);
          assert.notInclude(captured.question, captured.expected.ticker);
          assert.isAtMost(new TextEncoder().encode(captured.baseline.text).length, 4000);
          assert.notInclude(captured.baseline.text, "__bench");
          assert.isTrue(Object.isFrozen(captured.moment));

          const spot = tables.find((table) => table.caption === "Spot markets");

          tablePositions.add(spot?.tableIndex ?? -1);
          periodPositions.add(spot?.headers.indexOf("24h %") ?? -1);
          tickers.add(captured.expected.ticker);
        }
        assert.strictEqual(tablePositions.size, 3);
        assert.strictEqual(periodPositions.size, 3);
        assert.strictEqual(tickers.size, 10);
        assert.isEmpty(yield* browser.pages);
        assert.isEmpty(browser.context.pages());
      }),
    );

    it.effect("extracts the same conclusions with poisoned and deleted grader state", () =>
      Effect.gen(function* () {
        const browser = yield* Browser;

        yield* serve(browser, 17);
        const page = yield* browser.newPage(origin + routes.denseQuotes);

        yield* Effect.addFinalizer(() => page.close.pipe(Effect.ignore));
        const at = yield* browser.now;
        const original = yield* Comparison.readVisibleFacts(page, at);

        yield* Effect.promise(() =>
          page.playwright.evaluate(() => {
            Reflect.set(window, "__bench", {
              focus: "PRIVATE-GRADER-POISON",
              price: 987654321,
              c1h: 9988,
              c24h: 8877,
              table: "Private",
            });
          }),
        );
        const poisoned = yield* Comparison.readVisibleFacts(page, at);

        assert.deepStrictEqual(poisoned, original);
        yield* Effect.promise(() =>
          page.playwright.evaluate(() => {
            Reflect.deleteProperty(window, "__bench");
          }),
        );
        assert.deepStrictEqual(yield* Comparison.readVisibleFacts(page, at), original);
        yield* Effect.promise(() =>
          page.playwright.locator("h1").evaluate((heading) => {
            heading.style.visibility = "hidden";
          }),
        );
        const failure = yield* Effect.flip(Comparison.readVisibleFacts(page, at));

        assert.strictEqual(failure._tag, "QuoteComparisonError");
        yield* Effect.promise(() =>
          page.playwright.evaluate(() => {
            const heading = document.querySelector("h1");

            if (heading !== null) heading.style.visibility = "visible";
            document.body.style.opacity = "0";
          }),
        );
        assert.strictEqual(
          (yield* Effect.flip(Comparison.readVisibleFacts(page, at)))._tag,
          "QuoteComparisonError",
        );
        yield* Effect.promise(() =>
          page.playwright.evaluate(() => {
            document.body.style.opacity = "1";
            const cover = document.createElement("div");

            cover.id = "test-cover";
            cover.style.cssText = "position:fixed;inset:0;z-index:100;background:black";
            document.body.append(cover);
          }),
        );
        assert.strictEqual(
          (yield* Effect.flip(Comparison.readVisibleFacts(page, at)))._tag,
          "QuoteComparisonError",
        );
        yield* Effect.promise(() =>
          page.playwright.evaluate(() => {
            document.getElementById("test-cover")?.remove();

            const table = [...document.querySelectorAll("table")].find(
              (candidate) => candidate.caption?.innerText === "Spot markets",
            );

            const price = [...(table?.querySelectorAll("th") ?? [])].find(
              (header) => header.textContent === "Price",
            );

            if (price !== undefined) price.textContent = "1h %";
          }),
        );
        assert.strictEqual(
          (yield* Effect.flip(Comparison.readVisibleFacts(page, at)))._tag,
          "QuoteComparisonError",
        );
      }).pipe(Effect.scoped),
    );

    it.effect(
      "rejects stale identity and wrong table, ticker or period provenance before a call",
      () =>
        Effect.gen(function* () {
          const captured = yield* Comparison.prepare({ seed: 7, dense: true });
          const facts = captured.facts;

          const [first, ...others] = facts.evidence.tables;

          if (first === undefined) return yield* Effect.die("The dense fixture has tables");
          const [row, ...rows] = first.rows;

          if (row === undefined) return yield* Effect.die("The dense fixture has rows");

          const withTable = (table: (typeof facts.evidence.tables)[number]): Comparison.Facts => ({
            ...facts,
            evidence: { ...facts.evidence, tables: [table, ...others] },
          });

          const withRow = (changed: typeof row) =>
            withTable({ ...first, rows: [changed, ...rows] });

          const invalid: ReadonlyArray<Comparison.Facts> = [
            { ...facts, observation: { ...facts.observation, page: "another-page" } },
            { ...facts, observation: { ...facts.observation, url: origin + "/other" } },
            { ...facts, observation: { ...facts.observation, at: facts.observation.at + 1 } },
            // A second table under the same caption makes "Spot markets" ambiguous.
            withTable({ ...first, caption: others[0]?.caption ?? first.caption }),
            // A repeated header would let one value answer two periods.
            withTable({
              ...first,
              headers: first.headers.map((header) => (header === "1h %" ? "24h %" : header)),
            }),
            // A row must be keyed by its own Asset cell.
            withRow({ ...row, ticker: "OTHER-USD" }),
            // A cell keeps the header of its own column.
            withRow({
              ...row,
              cells: row.cells.map((cell) =>
                cell.header === "24h %" ? { ...cell, header: "1h %" } : cell,
              ),
            }),
            // An unreadable value is not a conclusion.
            withRow({
              ...row,
              cells: row.cells.map((cell) =>
                cell.header === "Price" ? { ...cell, text: "n/a" } : cell,
              ),
            }),
            {
              ...facts,
              evidence: {
                ...facts.evidence,
                heading: { selector: "h1", text: "A".repeat(1024) + "-USD" },
              },
            },
          ];

          let calls = 0;

          const model = yield* LanguageModel.make({
            generateText: () =>
              Effect.sync(() => {
                calls++;

                return [];
              }),
            streamText: () => Stream.empty,
          });

          for (const changed of invalid) {
            const failure = yield* Comparison.describe(
              { ...captured, facts: changed },
              "facts",
            ).pipe(Effect.provideService(LanguageModel.LanguageModel, model), Effect.flip);

            assert.strictEqual(failure._tag, "QuoteComparisonError");
          }
          assert.strictEqual(calls, 0);
        }),
    );

    it.effect(
      "shares A's exact moment with additive facts and isolates the historical baseline",
      () =>
        Effect.gen(function* () {
          const captured = yield* Comparison.prepare({ seed: 11, dense: true });
          const privateValue = "PRIVATE-EXPECTED-ONLY";

          const hiddenGrader: Comparison.QuoteCase = {
            ...captured,
            expected: { ...captured.expected, ticker: privateValue, price: 987654321 },
          };

          const requests: Array<LanguageModel.ProviderOptions> = [];

          const visible = Comparison.answerFrom(captured.facts);

          if (visible === undefined) return yield* Effect.die("The facts must answer the question");

          const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Comparison.Answer))(
            visible,
          );

          const model = yield* LanguageModel.make({
            generateText: (request) =>
              Effect.sync(() => {
                requests.push(request);

                return [
                  { type: "text", text: encoded },
                  {
                    type: "finish",
                    reason: "stop",
                    usage: { inputTokens: { total: 1200 }, outputTokens: { total: 40 } },
                  },
                ];
              }),
            streamText: () => Stream.empty,
          });

          for (const arm of ["A", "B", "facts"] as const) {
            const outcome = yield* Comparison.describe(hiddenGrader, arm).pipe(
              Effect.provideService(LanguageModel.LanguageModel, model),
            );

            assert.deepStrictEqual(outcome.answer, visible);
            assert.isFalse(outcome.pass);
            assert.strictEqual(outcome.steps, 1);
            assert.strictEqual(outcome.usage.inputTokens, 1200);
            assert.strictEqual(outcome.usage.outputTokens, 40);
          }
          const a = requests[0];
          const b = requests[1];
          const additive = requests[2];

          if (a === undefined || b === undefined || additive === undefined)
            return yield* Effect.die("All three comparison prompts are required");
          for (const request of requests) {
            assert.notInclude(textOf(request.prompt), privateValue);
            assert.notInclude(textOf(request.prompt), "987654321");
            assert.notInclude(textOf(request.prompt), "__bench");
            assert.strictEqual(request.responseFormat.type, "json");
            if (request.responseFormat.type === "json")
              assert.strictEqual(request.responseFormat.schema, Comparison.Answer);
            assert.strictEqual(pictures(request.prompt).length, 1);
          }
          const aSystem = a.prompt.content.find((message) => message.role === "system");
          const factsSystem = additive.prompt.content.find((message) => message.role === "system");
          const bSystem = b.prompt.content.find((message) => message.role === "system");

          assert.isDefined(aSystem);
          assert.isDefined(factsSystem);
          assert.isDefined(bSystem);
          if (aSystem === undefined || factsSystem === undefined || bSystem === undefined)
            return yield* Effect.die("Each arm requires a system prompt");
          assert.isTrue(factsSystem.content.startsWith(aSystem.content + "\n\n"));
          // Every visible table reaches the model; the requested binding is still its job.
          assert.include(
            factsSystem.content,
            JSON.stringify(Comparison.conclusionsOf(captured.facts)),
          );
          for (const caption of ["Spot markets", "Perpetual futures", "Evening watchlist"])
            assert.include(factsSystem.content, JSON.stringify(caption));
          assert.notInclude(factsSystem.content, encoded);
          assert.deepStrictEqual(a.prompt.content.slice(1), additive.prompt.content.slice(1));
          assert.strictEqual(pictures(a.prompt)[0]?.data, captured.moment.frames[0]?.data);
          assert.strictEqual(pictures(additive.prompt)[0]?.data, captured.moment.frames[0]?.data);
          assert.strictEqual(pictures(b.prompt)[0]?.data, captured.baseline.data);
          assert.strictEqual(
            bSystem.content,
            "You narrate a live browser session for viewers. " + captured.question,
          );
          assert.strictEqual(
            textOf(b.prompt),
            bSystem.content + "\nVisible text on the page:\n" + captured.baseline.text,
          );
          assert.notInclude(textOf(b.prompt), "Timeline (seconds before the moment)");

          const browser = yield* Browser;
          const page = yield* browser.newPage();

          yield* Effect.addFinalizer(() => page.close.pipe(Effect.ignore));

          const dimensions = yield* Effect.promise(() =>
            page.playwright.evaluate(
              async (data) => {
                const bitmap = await createImageBitmap(
                  new Blob([Uint8Array.from(data)], { type: "image/jpeg" }),
                );

                try {
                  return { width: bitmap.width, height: bitmap.height };
                } finally {
                  bitmap.close();
                }
              },
              [...captured.baseline.data],
            ),
          );

          assert.deepStrictEqual(dimensions, { width: 640, height: 360 });
        }).pipe(Effect.scoped),
    );
  },
);
