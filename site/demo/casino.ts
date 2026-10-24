// The casino demo: an agent is given a goal, six spins of a slot machine in an online casino, and
// finds its own way there, talking viewers through it as it plays. The game is drawn on a canvas,
// so the reels, the balance and every win are pictures with no text behind them, and it behaves as
// a real slot does: it asks about sound, animates while idle, counts wins up and celebrates a big
// one until skipped. Each take draws fresh spins, and what the agent reports is checked against
// the game server's own record of them.
//
// The casino, its studio and the game are this demo's own, served at their own HTTPS origins by
// request interception (see casino/site.ts); nothing in them says so to the agent.
import { Console, Effect, Schema } from "effect";
import { Browser } from "effect-browser/Browser";

import * as Site from "./casino/site.ts";
import * as Slot from "./casino/slot.ts";
import * as Show from "./show.ts";

/** The bet the agent is asked to play at, in cents, and how many spins. */
const bet = 200;

const spins = 6;

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export const task = {
  name: "casino",
  kind: "operate",
  summary: "Open a canvas slot machine, read its paytable and report six spins' wins",
  start: Site.casino,
  prompt: [
    `You're on Marlowe Casino, an online casino. Play ${spins} spins of Opal Crown at a`,
    `${dollars(bet)} total bet in demo mode, and report how it went.`,
    "Don't log in, sign up or play for real money.",
  ].join(" "),
} as const satisfies Show.Task;

export const Answer = Schema.Struct({
  fiveCrowns: Schema.Finite.annotate({
    description: "What five Crowns on a line pay at your bet, in dollars, as the paytable shows",
  }),
  bet: Schema.Finite.annotate({ description: "The total bet you played at, in dollars" }),
  wins: Schema.Array(Schema.Finite).annotate({
    description: "Each spin's win in dollars, in the order you played them, 0 for no win",
  }),
  balance: Schema.Finite.annotate({
    description: "The balance the game shows after the last spin, in dollars",
  }),
  lowest: Schema.Finite.annotate({
    description: "The lowest balance the game showed after any of your spins, in dollars",
  }),
  biggest: Schema.Struct({
    symbol: Schema.String,
    count: Schema.Finite,
  }).annotate({
    description:
      "The spin that won the most: the symbol its winning line paid for, and how many in a row, counting wilds",
  }),
});

export type Answer = typeof Answer.Type;

const cents = (amount: number) => Math.round(amount * 100);

const aliases: { readonly [S in Slot.Symbol]: ReadonlyArray<string> } = {
  TEN: ["10", "ten", "tens"],
  JACK: ["j", "jack", "jacks"],
  QUEEN: ["q", "queen", "queens"],
  KING: ["k", "king", "kings"],
  ACE: ["a", "ace", "aces"],
  EMERALD: ["emerald", "emeralds"],
  SAPPHIRE: ["sapphire", "sapphires"],
  RUBY: ["ruby", "rubies"],
  CROWN: ["crown", "crowns"],
  WILD: ["wild", "wilds", "opalwild", "opalwilds", "opal"],
};

/** The symbol a reported name stands for, such as Emeralds or K. */
export const symbolOf = (name: string): Slot.Symbol | undefined => {
  const plain = name.toLowerCase().replace(/[^a-z0-9]/g, "");

  return Slot.symbols.find((symbol) => aliases[symbol].includes(plain));
};

/**
 * The agent's report against the spins the game server decided: those of the last game session
 * it played, so a reload starts the count again as the game's balance does.
 */
export const grade = (answer: Answer, record: ReadonlyArray<Site.Spin>): Show.Checked => {
  const last = record.at(-1);
  const played = last === undefined ? [] : record.filter((spin) => spin.session === last.session);

  const biggest = Math.max(0, ...played.map((spin) => spin.win));

  const lines = played
    .filter((spin) => spin.win === biggest)
    .flatMap((spin) => {
      const highest = Math.max(0, ...spin.wins.map((win) => win.pay));

      return spin.wins.filter((win) => win.pay === highest);
    });

  const crowns = Math.round((bet * Slot.pays.CROWN[2]) / 10);
  const reported = answer.wins.map(cents);
  const won = played.map((spin) => spin.win);
  const lowest = played.length === 0 ? undefined : Math.min(...played.map((spin) => spin.balance));

  const facts = [
    {
      ok: cents(answer.fiveCrowns) === crowns,
      line: `five Crowns: reported ${dollars(cents(answer.fiveCrowns))}, the paytable pays ${dollars(crowns)} at a ${dollars(bet)} bet`,
    },
    {
      ok:
        cents(answer.bet) === bet && played.length > 0 && played.every((spin) => spin.bet === bet),
      line: `bet: reported ${dollars(cents(answer.bet))}, the server took ${[...new Set(played.map((spin) => dollars(spin.bet)))].join(" and ") || "no spins"}`,
    },
    {
      ok: played.length === spins,
      line: `spins: ${played.length} played, ${spins} asked for`,
    },
    {
      ok: reported.length === won.length && reported.every((win, index) => win === won[index]),
      line: `wins: reported ${reported.map(dollars).join(", ") || "none"}, the server paid ${won.map(dollars).join(", ") || "none"}`,
    },
    {
      ok: lowest !== undefined && cents(answer.lowest) === lowest,
      line: `lowest balance: reported ${dollars(cents(answer.lowest))}, the server's ${lowest === undefined ? "none" : dollars(lowest)}`,
    },
    {
      ok: last !== undefined && cents(answer.balance) === last.balance,
      line: `balance: reported ${dollars(cents(answer.balance))}, the server's ${last === undefined ? "none" : dollars(last.balance)}`,
    },
    {
      ok:
        lines.length === 0
          ? answer.biggest.count === 0
          : lines.some(
              (line) =>
                symbolOf(answer.biggest.symbol) === line.symbol &&
                answer.biggest.count === line.count,
            ),
      line: `biggest win: reported ${answer.biggest.count} ${answer.biggest.symbol}, the server paid ${lines.map((line) => `${line.count} ${Slot.names[line.symbol]} on line ${line.line}, ${dollars(line.pay)}`).join(" or ") || "nothing"}`,
    },
  ];

  const matched = facts.filter((fact) => fact.ok).length;

  return {
    pass: matched === facts.length,
    matched,
    detail: `${matched} of ${facts.length} facts match the game server's record. ${facts.map((fact) => `${fact.ok ? "" : "MISS "}${fact.line}`).join("; ")}.`,
  };
};

/** One take: the agent plays and talks, and its report is checked. The take logs its seed. */
export const explore = (options: Show.ExploreOptions, seed = Site.freshSeed()) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const served = yield* Site.serve(seed);
    const page = yield* browser.firstPage;

    yield* Console.log(`Opal Crown seed: ${served.seed}`);

    yield* page.goto(task.start);

    const result = yield* Show.perform(
      page,
      {
        task,
        answer: Answer,
        check: (answer) => served.spins.pipe(Effect.map((record) => grade(answer, record))),
      },
      options,
    );

    return { ...result, seed: served.seed };
  }).pipe(Effect.scoped);
