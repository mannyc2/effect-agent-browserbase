// The casino demo: an agent finds a slot machine in an online casino's lobby, reads its paytable
// and plays six spins, while a host talks viewers through it. The game is drawn on a canvas, so
// the reels, the balance and every win are pictures with no text behind them. What the agent
// reports is checked against the game server's own record of each spin.
//
// The casino, its studio and the game are this demo's own, served at their own HTTPS origins by
// request interception (see casino/site.ts); nothing in them says so to the agent.
import { Effect, Schema } from "effect";
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
    "You are on Marlowe Casino, an online casino. Find the slot game Opal Crown and open it in",
    "demo mode, which plays with free demo credits and needs no account.",
    `When the game has loaded, set its total bet to ${dollars(bet)}. Then open the game's`,
    "paytable, read what five Crowns on a line pay at that bet, and close it.",
    `Then play exactly ${spins} spins, one at a time: after each spin, wait until the reels have`,
    "stopped and any win has been shown, and note what the spin won, 0 if nothing.",
    "Do not use autoplay or change the bet again.",
    "Then report, with every amount in dollars: what five Crowns pay; the total bet you played",
    "at; each spin's win, in order; the balance the game shows after the last spin; and for the",
    "spin that won the most, the symbol its winning line paid for and how many in a row it paid",
    "for, counting wilds.",
    "People are watching you play, so before each action say in one short sentence what you are",
    "about to do and why, for them to read.",
    "Do not log in, sign up or play for real money.",
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
  biggest: Schema.Struct({
    symbol: Schema.String,
    count: Schema.Finite,
  }).annotate({
    description:
      "The spin that won the most: the symbol its winning line paid for, and how many in a row, counting wilds",
  }),
});

export type Answer = typeof Answer.Type;

const opening = [
  "This is the very start of the video, before the agent has done anything; the picture is the",
  "online casino's lobby it starts on. Open the way a presenter opens a demo: greet the viewers,",
  "and say that the agent is going to play a slot machine drawn entirely on a canvas, with no",
  "text behind it, so it has to read the reels, the balance and every win from the picture.",
  "Then say what it will do, in order, and hand over to it, as in let's watch. Three or four",
  "short sentences, at most 55 words.",
].join(" ");

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

  const biggest = played.reduce<Site.Spin | undefined>(
    (best, spin) => (best === undefined || spin.win > best.win ? spin : best),
    undefined,
  );

  const line = biggest?.wins.reduce<Slot.LineWin | undefined>(
    (best, win) => (best === undefined || win.pay > best.pay ? win : best),
    undefined,
  );

  const crowns = Math.round((bet * Slot.pays.CROWN[2]) / 10);
  const reported = answer.wins.map(cents);
  const won = played.map((spin) => spin.win);

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
      ok: last !== undefined && cents(answer.balance) === last.balance,
      line: `balance: reported ${dollars(cents(answer.balance))}, the server's ${last === undefined ? "none" : dollars(last.balance)}`,
    },
    {
      ok:
        line === undefined
          ? answer.biggest.count === 0
          : symbolOf(answer.biggest.symbol) === line.symbol && answer.biggest.count === line.count,
      line: `biggest win: reported ${answer.biggest.count} ${answer.biggest.symbol}, the server paid ${line === undefined ? "nothing" : `${line.count} ${Slot.names[line.symbol]} on line ${line.line}, ${dollars(line.pay)}`}`,
    },
  ];

  const matched = facts.filter((fact) => fact.ok).length;

  return {
    pass: matched === facts.length,
    matched,
    detail: `${matched} of ${facts.length} facts match the game server's record. ${facts.map((fact) => `${fact.ok ? "" : "MISS "}${fact.line}`).join("; ")}.`,
  };
};

const closing = (answer: Answer, checked: Show.Checked) =>
  [
    "The agent has finished. It reported that five Crowns pay",
    `${dollars(cents(answer.fiveCrowns))} at its bet of ${dollars(cents(answer.bet))}; that its`,
    `spins won ${answer.wins.map((win) => dollars(cents(win))).join(", ")}; that the balance after`,
    `the last spin was ${dollars(cents(answer.balance))}; and that its biggest win was`,
    `${answer.biggest.count} ${answer.biggest.symbol}.`,
    `Its report was then compared with the game server's own record of every spin: ${checked.detail}`,
    "Close the video the way a presenter wraps up a demo: say the run is over, sum up the session",
    "briefly with its biggest win and the final balance, say how the check came out, and thank",
    "the viewers for watching. Four or five short sentences, at most 70 words.",
  ].join(" ");

/** One take: the agent plays, the narrator speaks over it, and the report is checked. */
export const explore = (options: Show.ExploreOptions) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const served = yield* Site.serve(browser);
    const page = yield* browser.firstPage;

    yield* page.goto(task.start);

    return yield* Show.perform(
      page,
      {
        task,
        answer: Answer,
        opening,
        check: (answer) => served.spins.pipe(Effect.map((record) => grade(answer, record))),
        closing,
      },
      options,
    );
  }).pipe(Effect.scoped);
