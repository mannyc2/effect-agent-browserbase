// The demo: an agent explores Polymarket and talks viewers through it as it goes. When it reports
// the markets it found, each one is checked against Polymarket's public API, not taken on its word.
import { Effect, Schedule, Schema } from "effect";
import { Browser } from "effect-browser/Browser";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as Show from "./show.ts";

export const task = {
  name: "polymarket",
  kind: "operate",
  summary: "Explore Polymarket and report three markets worth a look, with their odds",
  start: "https://polymarket.com",
  prompt: [
    "You are on Polymarket, a prediction market: each market asks a question, and an outcome's",
    "price, shown as a percent chance or in cents, is the market's odds for it.",
    "Stay on polymarket.com: if it offers a view-only mode, browse that way.",
    "Explore it the way a curious visitor would, one thing at a time: look at what is trending,",
    "switch to a topic tab that interests you, and search for something you are curious about. Open at least three markets, and on each market's",
    "page scroll down to its chart to see how the odds have moved.",
    "Then report three markets you found interesting: each one's title exactly as its page shows",
    "it; the outcome you are quoting, which for a market with several options, such as dates or",
    "ranges, is one option's name as the page shows it, and otherwise Yes or No; that outcome's",
    "chance in percent as the page shows it; and in one sentence why it caught your eye.",
    "You have plenty of steps: if something does not work, such as a search with no results,",
    "try another way rather than giving up.",
    "Do not sign up, log in, connect a wallet or trade.",
  ].join(" "),
} as const satisfies Show.Task;

export const Answer = Schema.Struct({
  markets: Schema.Array(
    Schema.Struct({
      title: Schema.String,
      outcome: Schema.String,
      chance: Schema.Finite,
      why: Schema.String,
    }),
  ),
});

export type Answer = typeof Answer.Type;

/** One take: the agent explores and talks, and its answer is checked. */
export const explore = (options: Show.ExploreOptions) =>
  Effect.gen(function* () {
    const page = yield* (yield* Browser).firstPage;

    yield* page.goto(task.start);

    return yield* Show.perform(page, { task, answer: Answer, check }, options);
  }).pipe(Effect.scoped);

const ApiMarket = Schema.Struct({
  question: Schema.String,
  groupItemTitle: Schema.optional(Schema.String),
  outcomes: Schema.optional(Schema.String),
  outcomePrices: Schema.optional(Schema.String),
  closed: Schema.optional(Schema.Boolean),
});

const ApiEvent = Schema.Struct({
  title: Schema.String,
  markets: Schema.optional(Schema.Array(ApiMarket)),
});

export type ApiEvent = typeof ApiEvent.Type;

const Search = Schema.Struct({ events: Schema.optional(Schema.NullOr(Schema.Array(ApiEvent))) });

/** How far a reported chance may sit from the API's, in points: the odds move while it browses. */
export const tolerance = 4;

const normal = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const same = (left: string, right: string) => normal(left) === normal(right);

const strings = (json: string | undefined): ReadonlyArray<string> => {
  if (json === undefined) return [];
  const value: unknown = JSON.parse(json);

  return Array.isArray(value) ? value.map(String) : [];
};

/**
 * The API's chance, in percent, for a reported market's outcome, or why it has none: the event
 * whose title the agent quoted, then the option it named, or the binary market's own outcome.
 */
export const apiChance = (
  reported: Answer["markets"][number],
  events: ReadonlyArray<ApiEvent>,
): { readonly chance: number } | { readonly missing: string } => {
  const markets = events.flatMap((event) =>
    same(event.title, reported.title)
      ? (event.markets ?? [])
      : (event.markets ?? []).filter((market) => same(market.question, reported.title)),
  );

  const open = markets.filter((market) => market.closed !== true);

  if (open.length === 0) return { missing: "no open market with that title" };

  for (const market of open) {
    const outcomes = strings(market.outcomes);
    const prices = strings(market.outcomePrices).map(Number);

    const yes = outcomes.findIndex((outcome) => same(outcome, "Yes"));
    const named = outcomes.findIndex((outcome) => same(outcome, reported.outcome));

    // An option of a multi-market event is that market's Yes; so is a binary market quoted by
    // the words of its own question, such as a range.
    const index =
      open.length > 1 && market.groupItemTitle !== undefined
        ? same(market.groupItemTitle, reported.outcome)
          ? yes
          : -1
        : named === -1 && yes !== -1 && normal(market.question).includes(normal(reported.outcome))
          ? yes
          : named;

    const price = prices[index];

    if (price !== undefined && Number.isFinite(price)) return { chance: price * 100 };
  }

  const options = open.flatMap((market) => market.groupItemTitle ?? []);

  return {
    missing:
      open.length > 1 && options.length > 0
        ? `"${reported.outcome}" is none of its options, ${options.slice(0, 6).join(", ")}`
        : `no outcome named "${reported.outcome}"`,
  };
};

/** Every reported market must be on Polymarket, open, at about the chance the agent read. */
export const check = (answer: Answer): Effect.Effect<Show.Checked, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;

    const lines = yield* Effect.forEach(answer.markets, (reported) => {
      const label = `${reported.title} (${reported.outcome})`;

      // Plain words: the API's firewall refuses a query with quotation marks in it.
      return client
        .get("https://gamma-api.polymarket.com/public-search", {
          urlParams: { q: normal(reported.title), limit_per_type: "5", events_status: "active" },
        })
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(Search)),
          Effect.retry({ times: 2, schedule: Schedule.spaced("1 second") }),
          Effect.map(({ events }) => {
            const found = apiChance(reported, events ?? []);

            if ("missing" in found) return { ok: false, line: `${label}: ${found.missing}` };
            const off = Math.abs(found.chance - reported.chance);

            return {
              ok: off <= tolerance,
              line: `${label}: reported ${reported.chance}%, Polymarket's API ${found.chance.toFixed(1)}%`,
            };
          }),
          // A market the API would not answer for is unchecked, which fails the take's check.
          Effect.catch((error) =>
            Effect.succeed({ ok: false, line: `${label}: not checked (${error._tag})` }),
          ),
        );
    });

    const matched = lines.filter((line) => line.ok).length;

    return {
      pass: answer.markets.length >= 3 && matched === answer.markets.length,
      matched,
      detail: `${matched} of ${answer.markets.length} reported markets match Polymarket's API, within ${tolerance} points. ${lines.map((line) => line.line).join("; ")}.`,
    };
  });
