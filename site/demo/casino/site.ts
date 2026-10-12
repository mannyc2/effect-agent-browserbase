// Marlowe Casino and Larkspur Gaming's game server, served to the browser by request
// interception at their own HTTPS origins, so the pages and the game load as a real casino's do:
// the lobby and the game page from the casino, and the game in an iframe from its studio. The
// studio's server decides every spin, and its record of them is the take's ground truth: the
// canvas is the only place the agent can read them.
import { Effect, FileSystem, Path } from "effect";
import type * as Browser from "effect-browser/Browser";

import * as Slot from "./slot.ts";

export const casino = "https://www.marlowecasino.com";

export const studio = "https://launch.larkspurgaming.net";

/** The seed whose first spins make a good six-spin session: four wins, the last a big one. */
export const defaultSeed = 828;

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
 * Serve the casino and its game to every page of `browser` while the scope is open, and return
 * the spins the game server has decided, oldest first.
 */
export const serve = Effect.fn("Casino.serve")(function* (
  browser: Browser.Service,
  seed = defaultSeed,
) {
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
    // The first session draws from the seed itself, so its spins are the ones chosen for it.
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

  yield* Effect.acquireRelease(
    Effect.promise(() =>
      Promise.all([
        browser.context.route(`${casino}/**`, (route) => {
          const url = new URL(route.request().url());

          if (url.pathname === "/favicon.ico") return route.fulfill({ status: 204 });

          return route.fulfill(casinoPage(url.pathname));
        }),
        browser.context.route(`${studio}/**`, (route) => {
          const request = route.request();
          const url = new URL(request.url());

          if (request.method() === "OPTIONS")
            return route.fulfill({
              status: 204,
              headers: {
                "access-control-allow-origin": casino,
                "access-control-allow-methods": "POST, GET",
                "access-control-allow-headers": "content-type",
              },
            });
          if (url.pathname === "/opal-crown/" || url.pathname === "/opal-crown/index.html")
            return route.fulfill(html(slot));
          if (url.pathname === "/api/v2/session" && request.method() === "POST")
            return route.fulfill(json(configuration(open())));
          if (url.pathname === "/api/v2/spin" && request.method() === "POST") {
            const body = (request.postDataJSON() ?? {}) as {
              readonly sessionId?: unknown;
              readonly bet?: unknown;
            };

            const session =
              typeof body.sessionId === "string" ? sessions.get(body.sessionId) : undefined;

            const bet = Number(body.bet);

            if (session === undefined)
              return route.fulfill(json({ error: "SESSION_EXPIRED" }, 401));
            if (!(Slot.betLevels as ReadonlyArray<number>).includes(bet))
              return route.fulfill(json({ error: "INVALID_BET" }, 400));
            if (session.balance < bet)
              return route.fulfill(json({ error: "INSUFFICIENT_FUNDS" }, 402));
            const played = spin(session, bet);

            spins.push(played);

            return route.fulfill(json(played));
          }

          return route.fulfill(notFound);
        }),
      ]),
    ),
    () =>
      Effect.promise(() =>
        Promise.all([
          browser.context.unroute(`${casino}/**`),
          browser.context.unroute(`${studio}/**`),
        ]),
      ).pipe(Effect.ignore),
  );

  return { spins: Effect.sync((): ReadonlyArray<Spin> => [...spins]) };
});
