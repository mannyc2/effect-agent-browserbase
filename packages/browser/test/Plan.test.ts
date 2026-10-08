import { writeFileSync } from "node:fs";

import { assert, describe, it, layer } from "@effect/vitest";
import { Arbitrary, Duration, Effect, Exit, Layer, Schema } from "effect";

import { Browser } from "../src/Browser.ts";
import type { BrowserError } from "../src/BrowserError.ts";
import {
  Action,
  type BrowserEvent,
  Navigated,
  PageOpened,
  Subject,
  type SubjectContext,
} from "../src/BrowserEvent.ts";
import * as Chromium from "../src/Chromium.ts";
import { choose } from "../src/internal/reading/choose.ts";
import { type FindQuery, Found, type Page } from "../src/Page.ts";
import * as Plan from "../src/Plan.ts";
import { DriftSite, DriftSiteLayer, type Operator, operators } from "./drift.ts";

// Context words from a small vocabulary, so elements share and differ in them often.
const maybe = (values: ReadonlyArray<string>) =>
  Arbitrary.schema(Schema.Union([Schema.Undefined, Schema.Literals(values)]));

const context = Arbitrary.all({
  row: maybe(["BTC", "ETH", "SOL"]),
  column: maybe(["Trade", "Price"]),
  label: maybe(["BTC $64,210", "ETH $3,105", "New here?"]),
  heading: maybe(["Prices", "News"]),
});

const buy = (subject: SubjectContext, ref = "e1") =>
  new Found({
    ref,
    subject: new Subject({ role: "button", name: "Buy", tag: "button", context: subject }),
    box: { x: 0, y: 0, width: 10, height: 10 },
    inViewport: true,
    state: { disabled: false, focused: false },
  });

const candidates = Arbitrary.map(Arbitrary.array(context, { maxLength: 6 }), (contexts) =>
  contexts.map((one, index) => buy(one, `e${index + 1}`)),
);

// What `choose` decides, as a plain value: the element chosen, or why none was.
const decide = (subject: Subject, found: ReadonlyArray<Found>) =>
  Effect.runSync(
    choose(subject, found).pipe(
      Effect.map((one) => ({ _tag: "One" as const, found: one })),
      Effect.catch((error) =>
        Effect.succeed(
          error._tag === "Ambiguous"
            ? { _tag: "Ambiguous" as const, count: error.count }
            : { _tag: error._tag },
        ),
      ),
    ),
  );

const shape = (choice: {
  readonly _tag: string;
  readonly found?: Found;
  readonly count?: number;
}) => (choice.found === undefined ? JSON.stringify(choice) : `One ${choice.found.ref}`);

// Whether a context names a row, read as words, independently of how `choose` reads it.
const names = (subject: SubjectContext, row: string) =>
  Object.values(subject).some(
    (value) =>
      typeof value === "string" && value.toLowerCase().split(/\s+/).includes(row.toLowerCase()),
  );

describe("Plan's choice of a subject", () => {
  it.prop(
    "chooses the same element whatever order the page lists them in",
    {
      recorded: context,
      found: candidates,
      turn: Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5 }))),
    },
    ({ recorded, found, turn }) => {
      const reordered = found.toReversed();

      const turned = [
        ...reordered.slice(turn % (found.length || 1)),
        ...reordered.slice(0, turn % (found.length || 1)),
      ];

      assert.strictEqual(
        shape(decide(buy(recorded).subject, turned)),
        shape(decide(buy(recorded).subject, found)),
      );
    },
  );

  it.prop(
    "never chooses an element in another row or under another column",
    { recorded: context, found: candidates },
    ({ recorded, found }) => {
      const choice = decide(buy(recorded).subject, found);

      if (choice._tag !== "One") return;
      const chosen = choice.found.subject.context;

      assert.isTrue(recorded.row === undefined || names(chosen, recorded.row));
      assert.isTrue(
        recorded.column === undefined ||
          chosen.column === undefined ||
          chosen.column === recorded.column,
      );
    },
  );

  it.prop(
    "finds a copy of what it chose as good, with no ordinal to prefer one",
    { recorded: context, found: candidates },
    ({ recorded, found }) => {
      const choice = decide(buy(recorded).subject, found);

      if (choice._tag !== "One") return;

      const copied = decide(buy(recorded).subject, [
        ...found,
        buy(choice.found.subject.context, "e99"),
      ]);

      assert.strictEqual(copied._tag, "Ambiguous");
      assert.isAtLeast(copied._tag === "Ambiguous" ? copied.count : 0, 2);
    },
  );

  it.prop(
    "pays no heed to an element in another row, beyond saying the subject moved",
    { recorded: context, found: candidates },
    ({ recorded, found }) => {
      if (recorded.row === undefined) return;
      const subject = buy(recorded).subject;
      const before = decide(subject, found);

      assert.strictEqual(
        shape(decide(subject, [...found, buy({ row: "XRP" }, "e98")])),
        shape(before._tag === "Missing" ? { _tag: "Drifted" } : before),
      );
    },
  );

  it("prefers a field read the same to its words found in another field", () => {
    const same = buy({ label: "ETH $3,105" }, "e1");
    const elsewhere = buy({ heading: "ETH $3,105 today" }, "e2");

    assert.strictEqual(shape(decide(same.subject, [elsewhere, same])), "One e1");
  });

  it.prop(
    "reports nothing missing while something has the role and name",
    { recorded: context, found: candidates },
    ({ recorded, found }) => {
      assert.strictEqual(
        decide(buy(recorded).subject, found)._tag === "Missing",
        found.length === 0,
      );
    },
  );
});

const at = { at: 1, page: "p1" };

const opened = new PageOpened({ ...at, url: "about:blank" });

const typed = (text: string) =>
  new Action({
    ...at,
    at: 5,
    startedAt: 4,
    name: "type",
    target: "e7",
    text,
    options: { submit: true },
    subject: new Subject({ role: "textbox", name: "Search", tag: "input", context: {} }),
    ok: true,
    dispatched: true,
  });

const walk = (text: string): ReadonlyArray<BrowserEvent> => [
  opened,
  new Navigated({
    ...at,
    at: 2,
    url: "https://example.com/markets-moved",
    document: 1,
    sameDocument: false,
  }),
  new Action({
    ...at,
    at: 3,
    startedAt: 1,
    name: "navigate",
    target: "https://example.com/markets",
    ok: true,
    dispatched: true,
  }),
  typed(text),
  new Action({
    ...at,
    at: 6,
    startedAt: 6,
    name: "click",
    target: "300,320",
    x: 300,
    y: 320,
    ok: true,
    dispatched: true,
    box: { x: 0, y: 100, width: 600, height: 400 },
    subject: new Subject({ role: "canvas", name: "", tag: "canvas", context: {} }),
  }),
  new Action({
    ...at,
    at: 8,
    startedAt: 7,
    name: "click",
    target: "e9",
    ok: false,
    dispatched: false,
    error: "e9 is not on the page any more",
  }),
  new Action({
    ...at,
    page: "p2",
    at: 9,
    startedAt: 9,
    name: "press",
    target: "Enter",
    ok: true,
    dispatched: true,
  }),
];

describe("Plan.fromEvents", () => {
  it("keeps one page's completed steps, where each ended and what else each asked", () => {
    const plan = Plan.fromEvents(walk("bitcoin"));

    assert.deepStrictEqual(
      plan.steps.map(({ action, url, target, input, point, box }) => [
        action,
        url,
        target,
        input,
        point,
        box,
      ]),
      [
        [
          "navigate",
          "https://example.com/markets-moved",
          "https://example.com/markets",
          undefined,
          undefined,
          undefined,
        ],
        ["type", "https://example.com/markets-moved", undefined, "search", undefined, undefined],
        [
          "click",
          "https://example.com/markets-moved",
          undefined,
          undefined,
          { x: 300, y: 320 },
          { x: 0, y: 100, width: 600, height: 400 },
        ],
      ],
    );
    assert.deepStrictEqual(plan.steps[1]?.options, { submit: true });
    assert.deepStrictEqual(plan.inputs, ["search"]);
  });

  it.prop(
    "never keeps what was typed",
    { text: Arbitrary.schema(Schema.String.check(Schema.isPattern(/^typed:[\w ]{1,20}$/))) },
    ({ text }) => {
      const encoded = JSON.stringify(Schema.encodeSync(Plan.Plan)(Plan.fromEvents(walk(text))));

      assert.notInclude(encoded, text);
    },
  );

  it("reads back only a plan of its own version", () => {
    const plan = Plan.fromEvents(walk("bitcoin"));
    const encoded = Schema.encodeSync(Plan.Plan)(plan);

    assert.deepStrictEqual(Schema.decodeSync(Plan.Plan)(encoded), plan);
    assert.isTrue(Exit.isFailure(Schema.decodeUnknownExit(Plan.Plan)({ ...encoded, version: 2 })));
    assert.isTrue(
      Exit.isFailure(Schema.decodeUnknownExit(Plan.Plan)({ steps: [{ id: "a", run: [] }] })),
    );
  });
});

/** The ref of the one element a query finds, failing the walk otherwise. */
const ref = (page: Page, query: FindQuery) =>
  page
    .find({ scope: "document", ...query })
    .pipe(
      Effect.flatMap((found) =>
        found.length === 1 && found[0] !== undefined
          ? Effect.succeed(found[0].ref)
          : Effect.die(`expected one ${JSON.stringify(query)}, found ${found.length}`),
      ),
    );

type Walk = "buy" | "read" | "search" | "game";

const walks: Record<
  Walk,
  (page: Page, url: (path: string) => string) => Effect.Effect<void, BrowserError>
> = {
  buy: (page, url) =>
    Effect.gen(function* () {
      yield* page.goto(url("/"));
      yield* page.click(yield* ref(page, { role: "link", name: "Markets" }));
      yield* page.click(yield* ref(page, { role: "tab", name: "Futures" }));
      yield* page.click(yield* ref(page, { role: "link", name: "Buy", near: "ETH" }));
    }),
  read: (page, url) =>
    Effect.gen(function* () {
      yield* page.goto(url("/"));
      yield* page.click(yield* ref(page, { role: "link", name: "News" }));
      yield* page.hover(
        yield* ref(page, { role: "link", name: "Read more", near: "Fed holds rates" }),
      );
      yield* page.click(
        yield* ref(page, { role: "link", name: "Read more", near: "Fed holds rates" }),
      );
    }),
  search: (page, url) =>
    Effect.gen(function* () {
      yield* page.goto(url("/"));
      yield* page.type("bitcoin", {
        into: yield* ref(page, { role: "textbox", name: "Search" }),
        submit: true,
      });
      yield* page.click(yield* ref(page, { role: "link", name: "Bitcoin price today" }));
    }),
  game: (page, url) =>
    Effect.gen(function* () {
      yield* page.goto(url("/game"));
      const [canvas] = yield* page.find({ role: "canvas" });

      // The SPIN button, by point, as a model playing from a screenshot would press it.
      yield* page.click({ x: (canvas?.box.x ?? 0) + 300, y: (canvas?.box.y ?? 0) + 320 });
    }),
};

// What each replay should do under each operator: replay, or fail with this reason.
const expected = (operator: Operator, walk: Walk): string => {
  // A press the overlay covers fails, by ref or by point.
  if (operator === "overlay") return "NotActionable";
  if (operator === "rename" && (walk === "buy" || walk === "read")) return "Missing";
  if (operator === "duplicate" && walk === "buy") return "Ambiguous";

  return "replayed";
};

const truthOf = (page: Page) =>
  Effect.promise(() => page.playwright.evaluate(() => document.body.dataset["truth"] ?? ""));

layer(Layer.mergeAll(Chromium.layer(), DriftSiteLayer), {
  excludeTestServices: true,
  timeout: Duration.minutes(5),
})("Plan.replay", (it) => {
  const fresh = Effect.gen(function* () {
    const browser = yield* Browser;

    return yield* Effect.acquireRelease(browser.newPage(), (page) => Effect.ignore(page.close));
  });

  it.effect("says a walk that ends on another site drifted", () =>
    Effect.gen(function* () {
      const site = yield* DriftSite;
      const page = yield* fresh;

      yield* site.drift({ operator: "none", seed: 1 });
      // The recording reached the same path on another host.
      const elsewhere = site.url("/news").replace("127.0.0.1", "localhost");

      const plan = new Plan.Plan({
        version: 1,
        steps: [new Plan.Step({ action: "navigate", target: site.url("/news"), url: elsewhere })],
      });

      const error = yield* Effect.flip(Plan.replay(page, plan));

      assert.deepStrictEqual([error.step, error.reason._tag], [0, "Drifted"]);
    }),
  );

  it.effect("asks for every input's text before it takes a step", () =>
    Effect.gen(function* () {
      const page = yield* fresh;
      const error = yield* Effect.flip(Plan.replay(page, Plan.fromEvents(walk("bitcoin"))));

      assert.deepStrictEqual(
        [error.step, error.reason._tag === "BrowserError" ? error.reason.reason._tag : ""],
        [1, "InvalidRequest"],
      );
      assert.strictEqual(yield* page.url, "about:blank");
    }),
  );

  it.effect(
    "replays recorded walks under drift, and never in the wrong place",
    () =>
      Effect.gen(function* () {
        const browser = yield* Browser;
        const site = yield* DriftSite;
        const seeds = Number(process.env["DRIFT_SEEDS"] ?? 1);
        const fresh = Effect.acquireRelease(browser.newPage(), (page) => Effect.ignore(page.close));
        const outcomes: Record<string, string> = {};
        const wanted: Record<string, string> = {};
        const timings: Record<string, number> = {};

        for (const walk of Object.keys(walks) as Array<Walk>) {
          yield* site.drift({ operator: "none", seed: 1 });
          const recording = yield* fresh;

          yield* walks[walk](recording, site.url);
          const plan = Plan.fromEvents(yield* recording.recentEvents);
          const truth = yield* truthOf(recording);

          for (const operator of operators)
            for (let seed = 1; seed <= seeds; seed++) {
              yield* site.drift({ operator, seed });
              const page = yield* fresh;
              const key = `${walk} ${operator} ${seed}`;

              const started = performance.now();

              outcomes[key] = yield* Plan.replay(page, plan, {
                inputs: { search: "bitcoin" },
              }).pipe(
                Effect.andThen(truthOf(page)),
                Effect.map((reached) =>
                  reached === truth ? "replayed" : `wrong place: ${reached}`,
                ),
                Effect.catchTag("ReplayError", (error) =>
                  Effect.succeed(
                    error.reason._tag === "BrowserError"
                      ? error.reason.reason._tag
                      : error.reason._tag,
                  ),
                ),
              );
              wanted[key] = expected(operator, walk);
              timings[key] = Math.round(performance.now() - started);
            }
        }
        if (process.env["DRIFT_OUT"] !== undefined)
          writeFileSync(process.env["DRIFT_OUT"], JSON.stringify({ outcomes, timings }, null, 2));
        assert.deepStrictEqual(outcomes, wanted);
      }),
    { timeout: 600_000 },
  );
});
