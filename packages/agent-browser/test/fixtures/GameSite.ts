import { createServer } from "node:http";

import { Effect, Schema } from "effect";

import { gameClient } from "./GameClient.ts";
import { createGameEngine, GameKind, type GameState, reelOutcome, TruthEvent } from "./GameCore.ts";

export class GameSiteError extends Schema.TaggedError<GameSiteError>()("GameSiteError", {
  operation: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

const SiteOptions = Schema.Struct({
  seed: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 0xffffffff })),
  credits: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 1000000 })),
  publicOrigins: Schema.optionalKey(Schema.Struct({ top: Schema.String, frame: Schema.String })),
});

const TruthReceipt = Schema.Struct({
  kind: GameKind,
  sequence: Schema.Int.check(Schema.isGreaterThan(0)),
  event: TruthEvent,
});

export type TruthReceipt = typeof TruthReceipt.Type & { readonly receivedAtMillis: number };

export interface HostGameState extends GameState {
  readonly ready: boolean;
  readonly focused: boolean;
}

export interface GameSite {
  readonly url: string;
  readonly localUrl: string;
  readonly localFrameOrigin: string;
  readonly frameOrigin: string;
  readonly seed: number;
  readonly credits: number;
  readonly playUrl: (kind: GameKind) => string;
  readonly events: () => ReadonlyArray<TruthReceipt>;
  /** Syntactically decoded arrivals, including rejected transitions; never grading truth. */
  readonly receivedEvents: () => ReadonlyArray<TruthReceipt>;
  readonly failures: () => ReadonlyArray<string>;
  readonly state: (kind: GameKind) => HostGameState;
  readonly elapsedMillis: () => number;
  /** Host preparation only, before browser navigation. Distinct hostnames do not prove PSL sites. */
  readonly setPublicOrigins: (origins: PublicOrigins) => Effect.Effect<void, GameSiteError>;
  readonly originQualification:
    | "loopback-distinct-sites"
    | "configured-cross-origin-operator-site-prepared";
}

export interface PublicOrigins {
  readonly top: string;
  readonly frame: string;
}

const checkedOrigins = (origins: PublicOrigins) => {
  const top = new URL(origins.top);
  const frame = new URL(origins.frame);

  if (
    ![top, frame].every(
      (origin) =>
        origin.protocol === "https:" &&
        origin.username === "" &&
        origin.password === "" &&
        origin.pathname === "/" &&
        origin.search === "" &&
        origin.hash === "",
    ) ||
    top.hostname === frame.hostname
  )
    throw new Error("Public fixture origins require two distinct HTTPS hostnames");

  return { top: top.origin, frame: frame.origin };
};

const style = `<style>body{margin:0;background:#0f172a;color:#e5e7eb;font:20px sans-serif}
main{max-width:960px;margin:24px auto}button{padding:16px 24px;margin:10px;font:inherit;cursor:pointer}
iframe{display:block;border:0;width:960px;height:650px}form{display:inline}section{padding:24px;background:#253047}
canvas{display:block;width:960px;height:540px;outline:none}#controls{display:flex;align-items:center;gap:10px}
output{font-size:18px}#controls button{padding:12px;margin:4px}</style>`;

const lobby = (cookies: boolean, adult: boolean) => `<!doctype html><meta charset="utf-8">
<title>Estuary games</title>${style}<main><h1>Estuary demo games</h1>
${
  !cookies
    ? `<section aria-label="Cookie choices"><h2>Cookie choices</h2><p>Choose how this demo stores your preferences.</p>
<form method="post" action="/cookies"><button id="accept-cookies" name="choice" value="accept">Accept</button>
<button id="reject-cookies" name="choice" value="reject">Reject</button></form></section>`
    : !adult
      ? `<section aria-label="Age confirmation"><h2>Age confirmation</h2><p>Please confirm that you are 18 or older.</p>
<form method="post" action="/age"><button id="confirm-age">I am 18 or older</button></form>
<form action="/leave"><button id="leave">Leave</button></form></section>`
      : `<p>Try these games with demo credits. No account required.</p>
<section><h2>Canvas reels</h2><form action="/play/reels"><button id="play-reels">Play demo</button></form></section>
<section><h2>HTML reels</h2><form action="/play/reels-dom"><button id="play-reels-dom">Play demo</button></form></section>`
}
</main>`;

const frameMarkup = (
  kind: GameKind,
  seed: number,
  credits: number,
) => `<!doctype html><meta charset="utf-8">
<title>Estuary reels demo</title>${style}<canvas id="game-canvas" width="960" height="540" tabindex="0"></canvas>
<output id="result-status" style="position:absolute;left:400px;top:60px;color:#e5e7eb"></output>
${
  kind === "reels-dom"
    ? `<div id="controls"><output id="balance"></output><button id="bet-down">Decrease bet</button>
<output id="bet"></output><button id="bet-up">Increase bet</button><button id="spin">SPIN</button>
<output id="last-win"></output><output id="phase"></output></div>`
    : ""
}
<script>const engine=(${createGameEngine.toString()})(${seed},${credits},(${reelOutcome.toString()}));
(${gameClient.toString()})(engine,${JSON.stringify(kind)});</script>`;

/** A separate scoped loopback site with a genuinely cross-site localhost child frame. */
export const gameSite = Effect.fn("gameSite")(function* (
  options: {
    readonly seed?: number;
    readonly credits?: number;
    readonly publicOrigins?: { readonly top: string; readonly frame: string };
  } = {},
) {
  const config = yield* Schema.decodeEffect(SiteOptions)({
    seed: options.seed ?? 0,
    credits: options.credits ?? 1000,
    ...(options.publicOrigins === undefined ? {} : { publicOrigins: options.publicOrigins }),
  }).pipe(
    Effect.mapError((cause) => GameSiteError.make({ operation: "game site options", cause })),
  );

  return yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const started = performance.now();
        const elapsedMillis = () => performance.now() - started;

        const publicOrigins =
          config.publicOrigins === undefined ? undefined : checkedOrigins(config.publicOrigins);

        const ledger: TruthReceipt[] = [];
        const received: TruthReceipt[] = [];
        const failures: string[] = [];
        const states = new Map<GameKind, HostGameState>();
        const sequences = new Map<GameKind, number>();

        for (const kind of ["reels", "reels-dom"] as const) {
          states.set(kind, {
            ...createGameEngine(config.seed, config.credits, reelOutcome).state(),
            ready: false,
            focused: false,
          });
          sequences.set(kind, 0);
        }
        let frameOrigin = "";

        const server = createServer((request, response) => {
          const url = new URL(request.url ?? "/", "http://fixture.test");
          const cookies = request.headers.cookie?.includes("fixtureConsent=yes") === true;
          const adult = request.headers.cookie?.includes("fixtureAdult=yes") === true;

          if (url.pathname === "/truth" && request.method === "POST") {
            const chunks: Buffer[] = [];
            let size = 0;

            request.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size <= 16384) chunks.push(chunk);
            });
            request.on("end", () => {
              try {
                if (size > 16384 || received.length >= 4096)
                  throw new Error("Truth ledger bound exceeded");

                const receipt = Schema.decodeUnknownSync(TruthReceipt)(
                  JSON.parse(Buffer.concat(chunks).toString("utf8")),
                );

                const arrival = { ...receipt, receivedAtMillis: elapsedMillis() };

                received.push(arrival);

                if (receipt.sequence !== (sequences.get(receipt.kind) ?? 0) + 1)
                  throw new Error("Truth sequence mismatch");
                const current = states.get(receipt.kind);

                if (current === undefined) throw new Error("No game state");
                const event = receipt.event;
                let state = current;

                switch (event.tag) {
                  case "ready":
                    state = { ...current, ready: true };
                    break;
                  case "focus":
                    state = { ...current, focused: event.focused };
                    break;
                  case "betChange":
                    state = { ...current, bet: event.bet };
                    break;
                  case "spinStart":
                    if (
                      current.phase !== "idle" ||
                      event.spin !== current.spin + 1 ||
                      event.balanceAfter !== current.balance - current.bet
                    )
                      throw new Error("Invalid spin start");
                    state = {
                      ...current,
                      phase: "spinning",
                      spin: event.spin,
                      balance: event.balanceAfter,
                      lastWin: 0,
                      stoppedReels: 0,
                      notable: null,
                    };
                    break;
                  case "reelStop":
                    if (current.phase !== "spinning" || event.reel !== current.stoppedReels)
                      throw new Error("Invalid reel stop");
                    state = { ...current, stoppedReels: current.stoppedReels + 1 };
                    break;
                  case "result": {
                    const expected = reelOutcome(config.seed, current.spin, current.bet);

                    if (
                      current.phase !== "spinning" ||
                      current.stoppedReels !== 5 ||
                      event.win !== expected.win ||
                      event.moment !== expected.moment ||
                      JSON.stringify(event.grid) !== JSON.stringify(expected.grid) ||
                      event.balanceAfter !== current.balance + expected.win
                    )
                      throw new Error("Result disagrees with seeded truth");
                    state = {
                      ...current,
                      phase: "result",
                      grid: event.grid,
                      lastWin: event.win,
                      balance: event.balanceAfter,
                      notable: event.moment,
                    };
                    break;
                  }
                  case "bannerShown":
                    state = { ...current, banner: event.moment };
                    break;
                  case "bannerHidden":
                    state = { ...current, banner: null };
                    break;
                  case "idle":
                    state = { ...current, phase: "idle", banner: null };
                    break;
                }
                sequences.set(receipt.kind, receipt.sequence);
                states.set(receipt.kind, state);
                ledger.push(arrival);
                response.writeHead(204);
                response.end();
              } catch (cause) {
                if (failures.length < 32) failures.push(String(cause));
                response.writeHead(409);
                response.end("Truth rejected");
              }
            });

            return;
          }
          if (
            (url.pathname === "/cookies" || url.pathname === "/age") &&
            request.method === "POST"
          ) {
            response.writeHead(303, {
              location: "/",
              "set-cookie": `${url.pathname === "/cookies" ? "fixtureConsent" : "fixtureAdult"}=yes; Path=/; SameSite=Lax`,
            });
            request.resume();
            response.end();

            return;
          }
          if (request.method !== "GET" && request.method !== "HEAD") {
            response.writeHead(405);
            response.end();

            return;
          }
          const kind = url.pathname.endsWith("/reels-dom") ? "reels-dom" : "reels";
          let body: string | undefined;

          if (url.pathname === "/") body = lobby(cookies, adult);
          else if (url.pathname === "/leave")
            body = "<!doctype html><title>Demo closed</title><h1>Demo closed</h1>";
          else if (url.pathname === "/play/reels" || url.pathname === "/play/reels-dom") {
            if (!cookies || !adult) {
              response.writeHead(302, { location: "/" });
              response.end();

              return;
            }
            body = `<!doctype html><meta charset="utf-8"><title>Estuary game room</title>${style}
<main><h1>Estuary game room</h1><iframe id="game" title="Reels game" src="${frameOrigin}/frame/${kind}?seed=${config.seed}&credits=${config.credits}"></iframe></main>`;
          } else if (url.pathname === "/frame/reels" || url.pathname === "/frame/reels-dom")
            body = frameMarkup(kind, config.seed, config.credits);
          response.writeHead(body === undefined ? 404 : 200, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          });
          response.end(request.method === "HEAD" ? undefined : (body ?? "Page not found"));
        });

        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();

        if (address === null || typeof address === "string") {
          server.closeAllConnections();
          server.close();
          throw new Error("No game site port");
        }
        const localUrl = `http://127.0.0.1:${address.port}/`;

        const localFrameOrigin = `http://localhost:${address.port}`;
        let url = publicOrigins === undefined ? localUrl : `${publicOrigins.top}/`;

        frameOrigin = publicOrigins === undefined ? localFrameOrigin : publicOrigins.frame;

        return {
          get url() {
            return url;
          },
          localUrl,
          localFrameOrigin,
          get frameOrigin() {
            return frameOrigin;
          },
          get originQualification(): GameSite["originQualification"] {
            return url === localUrl
              ? "loopback-distinct-sites"
              : "configured-cross-origin-operator-site-prepared";
          },
          seed: config.seed,
          credits: config.credits,
          elapsedMillis,
          setPublicOrigins: (origins: PublicOrigins) =>
            Effect.try({
              try: () => {
                if (received.length > 0)
                  throw new Error("Fixture origins must be prepared before game navigation");
                const checked = checkedOrigins(origins);

                url = `${checked.top}/`;
                frameOrigin = checked.frame;
              },
              catch: (cause) =>
                GameSiteError.make({ operation: "prepare public fixture origins", cause }),
            }),
          playUrl: (kind: GameKind) => `${url}play/${kind}`,
          events: () => structuredClone(ledger),
          receivedEvents: () => structuredClone(received),
          failures: () => [...failures],
          state: (kind: GameKind) => {
            const state = states.get(kind);

            if (state === undefined) throw new Error("No game state");

            return structuredClone(state);
          },
          close: async () => {
            server.closeAllConnections();
            await new Promise<void>((resolve) => {
              server.close(() => resolve());
            });
          },
        };
      },
      catch: (cause) => GameSiteError.make({ operation: "start game site", cause }),
    }),
    (site) => Effect.promise(site.close),
  );
});
