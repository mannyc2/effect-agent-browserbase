// The three arms share one captured moment. Grader truth is kept outside every prompt and the
// facts builder; this comparison decides whether a caller-computed facts input merits a public API.
import { Effect, Schedule, Schema, Stream } from "effect";
import type * as Agent from "effect-browser/Agent";
import { Browser } from "effect-browser/Browser";
import type { BrowserError } from "effect-browser/BrowserError";
import * as Moment from "effect-browser/Moment";
import type { Page } from "effect-browser/Page";
import { type AiError, LanguageModel, Prompt } from "effect/ai";

import { origin, QuoteTruth, routes, serve } from "./Sites.ts";

export const Answer = Schema.Struct({
  ticker: Schema.String,
  price: Schema.Finite,
  change1h: Schema.Finite,
  change24h: Schema.Finite,
  column: Schema.String,
  table: Schema.String,
});

export type Answer = typeof Answer.Type;
export const Arm = Schema.Literals(["A", "B", "facts"]);
export type Arm = typeof Arm.Type;

export const question =
  "In the Spot markets table, read the row for the focused asset named in the page's h1 heading. Report its ticker, price, 1-hour and 24-hour percentage changes as displayed, the exact header of the 24-hour percentage column, and the table name. Do not use another period or another table with the same ticker.";

export class ComparisonError extends Schema.TaggedError<ComparisonError>()("QuoteComparisonError", {
  detail: Schema.String,
}) {}

const Observation = Schema.Struct({
  page: Schema.String,
  url: Schema.String,
  at: Schema.Finite,
});

export type Observation = typeof Observation.Type;

const Index = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const EvidenceText = Schema.String.check(Schema.isMaxLength(256));

const Cell = Schema.Struct({
  tableIndex: Index,
  rowIndex: Index,
  columnIndex: Index,
  table: EvidenceText,
  row: EvidenceText,
  header: EvidenceText,
  text: EvidenceText,
});

const Evidence = Schema.Struct({
  heading: Schema.Struct({ selector: Schema.Literal("h1"), text: EvidenceText }),
  caption: Schema.Struct({ tableIndex: Index, text: EvidenceText }),
  price: Cell,
  change1h: Cell,
  change24h: Cell,
});

const VisibleDom = Schema.Struct({
  url: Schema.String,
  text: Schema.String,
  evidence: Evidence,
});

type VisibleDom = typeof VisibleDom.Type;

export const Facts = Schema.Struct({
  observation: Observation,
  conclusions: Answer,
  evidence: Evidence,
});

export type Facts = typeof Facts.Type;

export interface QuoteCase {
  readonly seed: number;
  readonly dense: boolean;
  readonly task: "quote-table" | "quote-dense";
  readonly moment: Moment.Moment;
  readonly question: string;
  readonly baseline: {
    readonly data: Uint8Array;
    readonly width: 640;
    readonly height: 360;
    readonly text: string;
    /** Chromium's high-quality filter differs from the research prototype's Lanczos. */
    readonly resize: "chromium-canvas-high";
  };
  readonly facts: Facts;
  /** Used only after a model answers. Never passed to a prompt or the facts builder. */
  readonly expected: Answer;
}

export interface Outcome {
  readonly pass: boolean;
  readonly detail: string;
  readonly answer: Answer;
  readonly steps: 1;
  readonly usage: Agent.Usage;
}

export const grade = (answer: Answer, expected: Answer) => ({
  pass:
    answer.ticker === expected.ticker &&
    answer.price === expected.price &&
    answer.change1h === expected.change1h &&
    answer.change24h === expected.change24h &&
    answer.column === expected.column &&
    answer.table === expected.table,
  detail: `answered ${Schema.encodeSync(Schema.fromJsonString(Answer))(answer)}, expected ${Schema.encodeSync(Schema.fromJsonString(Answer))(expected)}`,
});

const fail = (detail: string) => new ComparisonError({ detail });

const native = <A>(detail: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: () => fail(detail) });

const decode = <A, I>(schema: Schema.Codec<A, I>, value: unknown, detail: string) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(() => fail(detail)));

const priceOf = (text: string) =>
  /^\$(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2,4}$/.test(text)
    ? Number(text.slice(1).replaceAll(",", ""))
    : Number.NaN;

const percentOf = (text: string) =>
  /^[+-]?\d+\.\d{2}%$/.test(text) ? Number(text.slice(0, -1)) : Number.NaN;

// This is deliberately a fixture-specific reader, not a general page-facts or OCR service.
// Headers and values must be in the viewport, and a repeated label is an error, not a guess.
const readDom = (page: Page): Effect.Effect<VisibleDom, ComparisonError> =>
  native("The visible quote evidence could not be read unambiguously", () =>
    page.playwright.evaluate(() => {
      const visible = (element: Element) => {
        const rect = element.getBoundingClientRect();

        for (
          let ancestor: Element | null = element;
          ancestor !== null;
          ancestor = ancestor.parentElement
        ) {
          const style = getComputedStyle(ancestor);

          if (
            style.display === "none" ||
            style.visibility !== "visible" ||
            Number(style.opacity) === 0
          )
            return false;
        }

        const front = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );

        return (
          rect.width > 0 &&
          rect.height > 0 &&
          rect.left >= 0 &&
          rect.top >= 0 &&
          rect.right <= innerWidth &&
          rect.bottom <= innerHeight &&
          front !== null &&
          (front === element || element.contains(front))
        );
      };

      const headings = [...document.querySelectorAll("h1")].filter(visible);
      const heading = headings[0]?.textContent?.trim();

      if (headings.length !== 1 || heading === undefined || !/^[A-Z]{1,10}-USD$/.test(heading))
        throw new Error("The focused asset must have one visible heading");
      const tables = [...document.querySelectorAll("table")];

      if (tables.length > 8) throw new Error("The table evidence exceeds the fixture bound");

      const matching = tables.filter((table) => {
        const caption = table.caption;

        return caption !== null && visible(caption) && caption.innerText.trim() === "Spot markets";
      });

      const table = matching[0];

      if (matching.length !== 1 || table === undefined || table.caption === null)
        throw new Error("The requested table must have one visible caption");
      const tableIndex = tables.indexOf(table);
      const caption = table.caption.innerText.trim();
      const headers = [...table.querySelectorAll("thead th")];
      const rows = [...table.querySelectorAll("tbody tr")];

      if (headers.length > 16 || rows.length > 64)
        throw new Error("The row evidence exceeds the fixture bound");
      const names = headers.map((header) => header.textContent?.trim() ?? "");
      const assetColumn = names.indexOf("Asset");

      if (assetColumn < 0 || names.lastIndexOf("Asset") !== assetColumn)
        throw new Error("The asset header must be unique");

      const matchingRows = rows.filter(
        (row) => row.querySelectorAll("td")[assetColumn]?.textContent?.trim() === heading,
      );

      const row = matchingRows[0];

      if (matchingRows.length !== 1 || row === undefined)
        throw new Error("The focused asset must have one row in the requested table");
      const cells = [...row.querySelectorAll("td")];
      const assetCell = cells[assetColumn];
      const assetHeader = headers[assetColumn];

      if (
        cells.length !== headers.length ||
        assetCell === undefined ||
        assetHeader === undefined ||
        !visible(assetCell) ||
        !visible(assetHeader)
      )
        throw new Error("The row and its asset header must be visible and aligned");

      const cell = (header: string) => {
        const columnIndex = names.indexOf(header);
        const column = headers[columnIndex];
        const value = cells[columnIndex];

        if (
          columnIndex < 0 ||
          names.lastIndexOf(header) !== columnIndex ||
          column === undefined ||
          value === undefined ||
          !visible(column) ||
          !visible(value)
        )
          throw new Error("The value and its unique header must be visible");

        return {
          tableIndex,
          rowIndex: rows.indexOf(row),
          columnIndex,
          table: caption,
          row: heading,
          header,
          text: value.textContent?.trim() ?? "",
        };
      };

      return {
        url: location.href,
        text: document.body.innerText,
        evidence: {
          heading: { selector: "h1" as const, text: heading },
          caption: { tableIndex, text: caption },
          price: cell("Price"),
          change1h: cell("1h %"),
          change24h: cell("24h %"),
        },
      };
    }),
  ).pipe(Effect.flatMap((value) => decode(VisibleDom, value, "Invalid visible quote evidence")));

const factsOf = (dom: VisibleDom, observation: Observation): Facts => ({
  observation,
  conclusions: {
    ticker: dom.evidence.heading.text,
    price: priceOf(dom.evidence.price.text),
    change1h: percentOf(dom.evidence.change1h.text),
    change24h: percentOf(dom.evidence.change24h.text),
    column: dom.evidence.change24h.header,
    table: dom.evidence.caption.text,
  },
  evidence: dom.evidence,
});

/** Check the bound table/row/header sources, not membership in a bag of numbers. */
export const validateFacts = (value: unknown, observation: Observation) =>
  Effect.gen(function* () {
    const facts = yield* decode(Facts, value, "Invalid quote facts");
    const { conclusions, evidence } = facts;
    const sources = [evidence.price, evidence.change1h, evidence.change24h];

    if (
      facts.observation.page !== observation.page ||
      facts.observation.url !== observation.url ||
      facts.observation.at !== observation.at ||
      evidence.caption.text !== "Spot markets" ||
      conclusions.table !== evidence.caption.text ||
      conclusions.ticker !== evidence.heading.text ||
      !/^[A-Z]{1,10}-USD$/.test(evidence.heading.text) ||
      sources.some(
        (source) =>
          source.tableIndex !== evidence.caption.tableIndex ||
          source.rowIndex !== evidence.price.rowIndex ||
          source.table !== conclusions.table ||
          source.row !== conclusions.ticker,
      ) ||
      new Set(sources.map((source) => source.columnIndex)).size !== sources.length ||
      evidence.price.header !== "Price" ||
      evidence.change1h.header !== "1h %" ||
      evidence.change24h.header !== "24h %" ||
      conclusions.column !== evidence.change24h.header ||
      conclusions.price !== priceOf(evidence.price.text) ||
      conclusions.change1h !== percentOf(evidence.change1h.text) ||
      conclusions.change24h !== percentOf(evidence.change24h.text)
    )
      return yield* fail("The quote conclusions do not match this moment's visible provenance");

    return facts;
  });

/** Exposed only in the benchmark so extraction can be tested after deleting grader state. */
export const readVisibleFacts = (page: Page, at: number) =>
  Effect.gen(function* () {
    const dom = yield* readDom(page);
    const observation = { page: page.id, url: dom.url, at };

    return yield* validateFacts(factsOf(dom, observation), observation);
  });

/** Keep a complete UTF-8 prefix; a cut character must not expand into a replacement glyph. */
export const clipVisibleText = (text: string): string =>
  new TextDecoder().decode(new TextEncoder().encode(text).subarray(0, 4000), { stream: true });

const resize = (page: Page, data: Uint8Array) =>
  native("The captured quote image could not be resized", () =>
    page.playwright.evaluate(async (base64) => {
      const raw = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([raw], { type: "image/jpeg" }));

      try {
        if (bitmap.width !== 1280 || bitmap.height !== 720)
          throw new Error("The comparison requires a 1280 by 720 source image");
        const canvas = new OffscreenCanvas(640, 360);
        const drawing = canvas.getContext("2d");

        if (drawing === null) throw new Error("The resize canvas is unavailable");
        drawing.imageSmoothingEnabled = true;
        drawing.imageSmoothingQuality = "high";
        drawing.drawImage(bitmap, 0, 0, 640, 360);
        const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 });

        return [...new Uint8Array(await blob.arrayBuffer())];
      } finally {
        bitmap.close();
      }
    }, Buffer.from(data).toString("base64")),
  ).pipe(Effect.map((bytes) => Uint8Array.from(bytes)));

export const prepare = (options: {
  readonly seed: number;
  readonly dense: boolean;
}): Effect.Effect<QuoteCase, BrowserError | ComparisonError, Browser> =>
  Effect.gen(function* () {
    const browser = yield* Browser;

    yield* serve(browser, options.seed);

    const page = yield* browser.newPage(
      origin + (options.dense ? routes.denseQuotes : routes.quotes),
    );

    yield* Effect.addFinalizer(() => page.close.pipe(Effect.ignore));
    const before = yield* readDom(page);

    const paintAfter = yield* native("The quote page did not reach its paint barrier", () =>
      page.playwright.evaluate(async () => {
        await document.fonts.ready;
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => resolve());
          });
        });

        return performance.timeOrigin + performance.now();
      }),
    ).pipe(
      Effect.timeoutOrElse({
        duration: "5 seconds",
        orElse: () => fail("The quote page did not reach its paint barrier"),
      }),
    );

    yield* page.screencast().pipe(Stream.runDrain, Effect.forkScoped);
    yield* page.recentFrames.pipe(
      Effect.repeat({
        schedule: Schedule.spaced("25 millis"),
        until: (frames) =>
          frames.some(
            (frame) => frame.timing._tag === "BrowserPaint" && frame.timing.timestamp >= paintAfter,
          ),
      }),
      Effect.timeoutOrElse({
        duration: "5 seconds",
        orElse: () => fail("The comparison did not capture a native frame"),
      }),
    );
    const moment = yield* Moment.capture(page, { frames: 1 });
    const after = yield* readDom(page);

    const encodeDom = (dom: VisibleDom) =>
      Schema.encodeEffect(Schema.fromJsonString(VisibleDom))(dom).pipe(
        Effect.mapError(() => fail("The visible quote evidence could not be encoded")),
      );

    const beforeEncoded = yield* encodeDom(before);
    const afterEncoded = yield* encodeDom(after);

    // Static quotes let us bracket the capture instead of pretending a DOM read and a frame
    // are atomic. A changed page invalidates the whole triplet before any model admission.
    if (beforeEncoded !== afterEncoded || after.url !== moment.snapshot.url)
      return yield* fail("The quote evidence changed while the shared moment was captured");
    const frame = moment.frames[0];

    if (
      moment.frames.length !== 1 ||
      frame === undefined ||
      frame.timing._tag !== "BrowserPaint" ||
      frame.timing.timestamp < paintAfter
    )
      return yield* fail("The comparison requires one native captured frame");
    const observation = { page: moment.page, url: moment.snapshot.url, at: moment.at };
    const facts = yield* validateFacts(factsOf(after, observation), observation);
    const baselineImage = yield* resize(page, frame.data);

    // Only this grader branch reads fixture state. Its values never influence extraction,
    // questions, image preparation or a model request.
    const state = yield* native("The quote grader state is unavailable", () =>
      page.playwright.evaluate(() => (window as unknown as { __bench: unknown }).__bench),
    ).pipe(Effect.flatMap((value) => decode(QuoteTruth, value, "Invalid quote grader state")));

    const expected = {
      ticker: state.focus,
      price: state.price,
      change1h: state.c1h,
      change24h: state.c24h,
      column: state.header,
      table: state.table,
    };

    Object.freeze(moment.frames);
    Object.freeze(moment.events);
    Object.freeze(moment);

    return {
      seed: options.seed,
      dense: options.dense,
      task: options.dense ? "quote-dense" : "quote-table",
      moment,
      question,
      baseline: {
        data: baselineImage,
        width: 640,
        height: 360,
        // The historical baseline slices bytes before decoding, not JavaScript characters.
        text: clipVisibleText(after.text),
        resize: "chromium-canvas-high",
      },
      facts,
      expected,
    } satisfies QuoteCase;
  }).pipe(Effect.scoped);

export const describe = (
  captured: QuoteCase,
  arm: Arm,
): Effect.Effect<Outcome, AiError.AiError | ComparisonError, LanguageModel.LanguageModel> =>
  Effect.gen(function* () {
    let instructions = captured.question;

    if (arm === "facts") {
      const facts = yield* validateFacts(captured.facts, {
        page: captured.moment.page,
        url: captured.moment.snapshot.url,
        at: captured.moment.at,
      });

      const conclusions = yield* Schema.encodeEffect(Schema.fromJsonString(Answer))(
        facts.conclusions,
      ).pipe(Effect.mapError(() => fail("The quote conclusions could not be encoded")));

      if (new TextEncoder().encode(conclusions).length > 1024)
        return yield* fail("The quote conclusions exceed the benchmark facts bound");
      instructions +=
        "\n\nCaller-computed conclusions from this moment's visible table, bound to its caption, focused row and exact column headers:\n" +
        conclusions;
    }

    const described =
      arm === "B"
        ? yield* LanguageModel.generateObject({
            schema: Answer,
            objectName: "moment",
            prompt: Prompt.fromMessages([
              Prompt.makeMessage("system", {
                content: "You narrate a live browser session for viewers. " + captured.question,
              }),
              Prompt.makeMessage("user", {
                content: [
                  Prompt.makePart("text", {
                    text: "Visible text on the page:\n" + captured.baseline.text,
                  }),
                  Prompt.makePart("file", {
                    mediaType: "image/jpeg",
                    data: captured.baseline.data,
                  }),
                ],
              }),
            ]),
          }).pipe(
            Effect.map((response) => ({
              value: response.value,
              usage: {
                inputTokens: response.usage.inputTokens.total ?? 0,
                outputTokens: response.usage.outputTokens.total ?? 0,
                cachedInputTokens: response.usage.inputTokens.cacheRead ?? 0,
              },
            })),
          )
        : yield* Moment.describe(captured.moment, { schema: Answer, instructions });

    return {
      ...grade(described.value, captured.expected),
      answer: described.value,
      steps: 1,
      usage: described.usage,
    } satisfies Outcome;
  });
