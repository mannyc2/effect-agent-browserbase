// Marlowe Casino and Larkspur Gaming's game server, served to the browser by request
// interception at their own HTTPS origins, so the pages and the game load as a real casino's do:
// the lobby and the game page from the casino, and the game in an iframe from its studio. The
// studio's server decides every spin, and its record of them is the take's ground truth: the
// canvas is the only place the agent can read them.
import { Effect, FileSystem, Path, Schema } from "effect";
import type { RequestDecision } from "effect-browser/Browser";

import * as Routes from "../../../bench/FixtureRoutes.ts";
import * as Slot from "./slot.ts";

export const casino = "https://www.marlowecasino.com";

export const studio = "https://launch.larkspurgaming.net";

/** A fresh seed for the game server's draws, an unsigned 32-bit integer. */
export const freshSeed = (): number => crypto.getRandomValues(new Uint32Array(1))[0]!;

/** One spin as the game server decided and paid it. */
export interface Spin {
  /** The game session, one per launch of the game. */
  readonly session: string;
  /** 1 for a session's first spin. */
  readonly round: number;
  readonly roundId: string;
  /** Cents. */
  readonly bet: number;
  readonly grid: Slot.Grid;
  readonly wins: ReadonlyArray<Slot.LineWin>;
  /** Cents. */
  readonly win: number;
  /** The balance after the spin was paid, in cents. */
  readonly balance: number;
}

interface Session {
  readonly id: string;
  readonly draw: () => number;
  balance: number;
  rounds: number;
}

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  headers: { "access-control-allow-origin": casino, "cache-control": "no-store" },
  body: JSON.stringify(body),
});

const html = (body: string) => ({
  status: 200,
  contentType: "text/html; charset=utf-8",
  headers: { "cache-control": "no-store" },
  body,
});

const notFound = {
  status: 404,
  contentType: "text/html; charset=utf-8",
  body: "<!doctype html><title>404 Not Found</title><h1>Not Found</h1><p>The requested URL was not found on this server.</p>",
};

/** What the game asks for when it loads: the session's balance, the bets and the paytable. */
const configuration = (session: Session) => ({
  sessionId: session.id,
  currency: "USD",
  balance: session.balance,
  betLevels: Slot.betLevels,
  defaultBet: Slot.defaultBet,
  lines: Slot.lines,
  pays: Slot.pays,
  strips: Slot.strips,
});

/**
 * Serve the casino and its game to every page of `browser` while the scope is open, with the game
 * server drawing its spins from `seed`, a fresh one unless given. Returns the seed, so a session
 * can be dealt again, and the spins the game server has decided, oldest first.
 */
export const serve = Effect.fn("Casino.serve")(function* (seed: number = freshSeed()) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const read = (file: string) => fs.readFileString(path.join(import.meta.dirname, file));

  const site = yield* read("casino.html");
  const slot = yield* read("slot.html");

  const spins: Array<Spin> = [];
  const sessions = new Map<string, Session>();
  let opened = 0;
  let nextRound = 4_183_207;

  const open = (): Session => {
    // The first session draws from the seed itself; each later one from a seed of its own.
    const session: Session = {
      id: `ls-${(0x5f3a91c + opened * 7919).toString(36)}-${(seed * 31 + opened).toString(36)}`,
      draw: Slot.random(seed + opened * 0x9e3779b9),
      balance: Slot.startingBalance,
      rounds: 0,
    };

    opened++;
    sessions.set(session.id, session);

    return session;
  };

  const spin = (session: Session, bet: number) => {
    session.balance -= bet;
    session.rounds++;
    const grid = Slot.stop(session.draw);
    const wins = Slot.evaluate(grid, bet);
    const win = wins.reduce((total, line) => total + line.pay, 0);

    session.balance += win;

    return {
      session: session.id,
      round: session.rounds,
      roundId: String(nextRound++),
      bet,
      grid,
      wins,
      win,
      balance: session.balance,
    } satisfies Spin;
  };

  // The casino's pages are one application, which draws the lobby or a game's page from the path.
  const casinoPage = (pathname: string) =>
    pathname === "/" || /^\/games\/[a-z0-9-]+\/?$/.test(pathname) ? html(site) : notFound;

  const fulfilled = (
    response: Omit<Extract<RequestDecision, { readonly _tag: "Fulfilled" }>, "_tag">,
  ) => ({ _tag: "Fulfilled" as const, ...response });

  yield* Routes.serve(`${casino}/`, (url) =>
    fulfilled(
      url.pathname === "/favicon.ico"
        ? { status: 204, contentType: "text/plain", body: "" }
        : casinoPage(url.pathname),
    ),
  );
  yield* Routes.serve(`${studio}/`, (url, request) => {
    if (request.method === "OPTIONS")
      return fulfilled({
        status: 204,
        contentType: "text/plain",
        body: "",
        headers: {
          "access-control-allow-origin": casino,
          "access-control-allow-methods": "POST, GET",
          "access-control-allow-headers": "content-type",
        },
      });
    if (url.pathname === "/opal-crown/" || url.pathname === "/opal-crown/index.html")
      return fulfilled(html(slot));
    if (url.pathname === "/api/v2/session" && request.method === "POST")
      return fulfilled(json(configuration(open())));
    if (url.pathname === "/api/v2/spin" && request.method === "POST") {
      const body = Schema.decodeOption(
        Schema.fromJsonString(
          Schema.Struct({
            sessionId: Schema.optional(Schema.String),
            bet: Schema.optional(Schema.Finite),
          }),
        ),
      )(request.body ?? "{}");

      const session =
        body._tag === "Some" && body.value.sessionId !== undefined
          ? sessions.get(body.value.sessionId)
          : undefined;

      const bet = body._tag === "Some" ? Number(body.value.bet) : Number.NaN;

      if (session === undefined) return fulfilled(json({ error: "SESSION_EXPIRED" }, 401));
      if (!(Slot.betLevels as ReadonlyArray<number>).includes(bet))
        return fulfilled(json({ error: "INVALID_BET" }, 400));
      if (session.balance < bet) return fulfilled(json({ error: "INSUFFICIENT_FUNDS" }, 402));
      const played = spin(session, bet);

      spins.push(played);

      return fulfilled(json(played));
    }

    return fulfilled(notFound);
  });

  return { seed, spins: Effect.sync((): ReadonlyArray<Spin> => [...spins]) };
});
