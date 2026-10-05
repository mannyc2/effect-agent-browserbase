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

const FactCell = Schema.Struct({ columnIndex: Index, header: EvidenceText, text: EvidenceText });

const FactRow = Schema.Struct({
  rowIndex: Index,
  ticker: EvidenceText,
  cells: Schema.Array(FactCell).check(Schema.isMaxLength(16)),
});

const FactTable = Schema.Struct({
  tableIndex: Index,
  caption: EvidenceText,
  headers: Schema.Array(EvidenceText).check(Schema.isMaxLength(16)),
  rows: Schema.Array(FactRow).check(Schema.isMaxLength(64)),
});

/** Every visible quote table, each cell bound to its caption, row asset and exact header. */
const Evidence = Schema.Struct({
  heading: Schema.Struct({ selector: Schema.Literal("h1"), text: EvidenceText }),
  tables: Schema.Array(FactTable).check(Schema.isMaxLength(8)),
});

const VisibleDom = Schema.Struct({
  url: Schema.String,
  text: Schema.String,
  evidence: Evidence,
});

type VisibleDom = typeof VisibleDom.Type;

export const Facts = Schema.Struct({
  observation: Observation,
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
  /** Every displayed quote, for classifying a wrong answer's source after the model answers. */
  readonly rows: ReadonlyArray<QuoteRow>;
}

export type QuoteRow = (typeof QuoteTruth.Type)["rows"][number];

/**
 * Where a graded answer's values came from. The fixture gives every table, row and period a
 * distinct value, so each reported number identifies the cell it was read from.
 */
export interface Binding {
  /** A reported value belongs to another table, such as the same asset's futures quote. */
  readonly wrongTable: boolean;
  /** A reported value belongs to another row of the requested table. */
  readonly wrongRow: boolean;
  /** A reported change belongs to another period (1h, 24h or 7d) of the requested row. */
  readonly wrongPeriod: boolean;
  /** A reported value matches no displayed cell of its kind: a misread, not a binding. */
  readonly unsourced: boolean;
}

type Period = "c1h" | "c24h" | "c7d";

/** A displayed cell a reported value matches, and the period its field asked for. */
interface Source {
  readonly row: QuoteRow;
  readonly period: Period | undefined;
  readonly wanted: Period | undefined;
}

export const binding = (
  answer: Answer,
  expected: Answer,
  rows: ReadonlyArray<QuoteRow>,
): Binding => {
  const changes = [
    ["change1h", "c1h"],
    ["change24h", "c24h"],
  ] as const;

  const sources: ReadonlyArray<ReadonlyArray<Source>> = [
    rows.flatMap((row) =>
      row.price === answer.price ? [{ row, period: undefined, wanted: undefined }] : [],
    ),
    ...changes.map(([field, wanted]) =>
      rows.flatMap((row) =>
        (["c1h", "c24h", "c7d"] as const).flatMap((period) =>
          row[period] === answer[field] ? [{ row, period, wanted }] : [],
        ),
      ),
    ),
  ];

  const found = sources.flatMap((cells) => cells.slice(0, 1));
  const inTable = found.filter((cell) => cell.row.table === expected.table);
  const inRow = inTable.filter((cell) => cell.row.ticker === expected.ticker);

  return {
    wrongTable: found.some((cell) => cell.row.table !== expected.table),
    wrongRow: inTable.some((cell) => cell.row.ticker !== expected.ticker),
    wrongPeriod: inRow.some((cell) => cell.period !== cell.wanted),
    unsourced: sources.some((cells) => cells.length === 0),
  };
};

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

const millionsOf = (text: string) =>
  /^\$\d+\.\dM$/.test(text) ? Number(text.slice(1, -1)) * 1e6 : Number.NaN;

const ticker = /^[A-Z]{1,10}-USD$/;

/** A displayed cell as the number it shows, keyed by its exact header; undefined if unreadable. */
const valueOf = (header: string, text: string): string | number | undefined => {
  const value =
    header === "Asset"
      ? text
      : header === "Price"
        ? priceOf(text)
        : header === "24h volume"
          ? millionsOf(text)
          : /^\d+[hd] %$/.test(header)
            ? percentOf(text)
            : Number.NaN;

  return typeof value === "string"
    ? ticker.test(value)
      ? value
      : undefined
    : Number.isFinite(value)
      ? value
      : undefined;
};

// This is deliberately a fixture-specific reader, not a general page-facts or OCR service.
// Every table, header and value must be in the viewport, and a repeated label is an error.
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

      if (headings.length !== 1 || heading === undefined)
        throw new Error("The focused asset must have one visible heading");
      const tables = [...document.querySelectorAll("table")];

      if (tables.length > 8) throw new Error("The table evidence exceeds the fixture bound");

      return {
        url: location.href,
        text: document.body.innerText,
        evidence: {
          heading: { selector: "h1" as const, text: heading },
          tables: tables.map((table, tableIndex) => {
            const caption = table.caption;
            const headers = [...table.querySelectorAll("thead th")];
            const rows = [...table.querySelectorAll("tbody tr")];

            if (caption === null || !visible(caption))
              throw new Error("Every quote table must have a visible caption");
            if (headers.length > 16 || rows.length > 64)
              throw new Error("The row evidence exceeds the fixture bound");
            if (!headers.every(visible)) throw new Error("Every header must be visible");
            const names = headers.map((header) => header.textContent?.trim() ?? "");
            const assetColumn = names.indexOf("Asset");

            return {
              tableIndex,
              caption: caption.innerText.trim(),
              headers: names,
              rows: rows.map((row, rowIndex) => {
                const cells = [...row.querySelectorAll("td")];

                if (cells.length !== names.length || !cells.every(visible))
                  throw new Error("Every row must be visible and aligned with its headers");

                return {
                  rowIndex,
                  ticker: cells[assetColumn]?.textContent?.trim() ?? "",
                  cells: cells.map((cell, columnIndex) => ({
                    columnIndex,
                    header: names[columnIndex] ?? "",
                    text: cell.textContent?.trim() ?? "",
                  })),
                };
              }),
            };
          }),
        },
      };
    }),
  ).pipe(Effect.flatMap((value) => decode(VisibleDom, value, "Invalid visible quote evidence")));

const unique = (values: ReadonlyArray<string>) => new Set(values).size === values.length;

/** Check each value's table, row and header binding, not membership in a bag of numbers. */
export const validateFacts = (value: unknown, observation: Observation) =>
  Effect.gen(function* () {
    const facts = yield* decode(Facts, value, "Invalid quote facts");
    const { heading, tables } = facts.evidence;

    const bound = tables.every(
      (table) =>
        table.caption.length > 0 &&
        unique(table.headers) &&
        table.headers.includes("Asset") &&
        unique(table.rows.map((row) => row.ticker)) &&
        table.rows.every(
          (row) =>
            row.cells.length === table.headers.length &&
            row.cells.every(
              (cell, index) =>
                cell.columnIndex === index &&
                cell.header === table.headers[index] &&
                valueOf(cell.header, cell.text) !== undefined &&
                (cell.header !== "Asset" || cell.text === row.ticker),
            ),
        ),
    );

    if (
      facts.observation.page !== observation.page ||
      facts.observation.url !== observation.url ||
      facts.observation.at !== observation.at ||
      !ticker.test(heading.text) ||
      tables.length === 0 ||
      !unique(tables.map((table) => table.caption)) ||
      !bound
    )
      return yield* fail("The quote facts do not match this moment's visible provenance");

    return facts;
  });

/** The facts the model reads: every visible row as numbers keyed by its exact column headers. */
export const conclusionsOf = (facts: Facts) => ({
  focusedHeading: facts.evidence.heading.text,
  tables: facts.evidence.tables.map((table) => ({
    caption: table.caption,
    rows: table.rows.map((row) =>
      Object.fromEntries(row.cells.map((cell) => [cell.header, valueOf(cell.header, cell.text)])),
    ),
  })),
});

/**
 * The answer a reader of these facts gives when it binds the requested table, the heading's row
 * and the requested periods. Only the free rehearsal and tests use it; no arm receives it.
 */
export const answerFrom = (facts: Facts): Answer | undefined => {
  const table = facts.evidence.tables.find((candidate) => candidate.caption === "Spot markets");
  const row = table?.rows.find((candidate) => candidate.ticker === facts.evidence.heading.text);

  const read = (header: string) => {
    const cell = row?.cells.find((candidate) => candidate.header === header);

    return cell === undefined ? undefined : valueOf(header, cell.text);
  };

  const price = read("Price");
  const change1h = read("1h %");
  const change24h = read("24h %");

  return table === undefined ||
    row === undefined ||
    typeof price !== "number" ||
    typeof change1h !== "number" ||
    typeof change24h !== "number"
    ? undefined
    : { ticker: row.ticker, price, change1h, change24h, column: "24h %", table: table.caption };
};

/** Exposed only in the benchmark so extraction can be tested after deleting grader state. */
export const readVisibleFacts = (page: Page, at: number) =>
  Effect.gen(function* () {
    const dom = yield* readDom(page);
    const observation = { page: page.id, url: dom.url, at };

    return yield* validateFacts({ observation, evidence: dom.evidence }, observation);
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
    const facts = yield* validateFacts({ observation, evidence: after.evidence }, observation);
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
      rows: state.rows,
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

      const conclusions = JSON.stringify(conclusionsOf(facts));

      if (new TextEncoder().encode(conclusions).length > 8192)
        return yield* fail("The quote conclusions exceed the benchmark facts bound");
      instructions +=
        "\n\nCaller-computed conclusions from every quote table visible in this moment, each value keyed by its table caption, row asset and exact column header:\n" +
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
