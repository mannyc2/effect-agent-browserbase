// Plan 016's drift site: a small portal with a nav, a markets table with tabs, news, search and a
// canvas game, and the phase 1 review's pages: a shop, a team list and a sign-in form.
// Each page is served under one drift operator at a time, seeded, and says in `data-truth` where
// a visit ended, so a replay that succeeds in the wrong place is caught. `remove` takes away what
// a walk acted on and leaves something like it, and `insert` puts a new one before it.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { Context, Effect, Layer } from "effect";

export const operators = [
  "none",
  "reorder",
  "shift",
  "slow",
  "overlay",
  "rename",
  "duplicate",
  "offscreen",
  "redirect",
  "variant",
  "remove",
  "insert",
] as const;

export type Operator = (typeof operators)[number];

export interface Drift {
  readonly operator: Operator;
  readonly seed: number;
}

const coins = [
  ["BTC", "$64,210"],
  ["ETH", "$3,105"],
  ["SOL", "$148"],
  ["ADA", "$0.45"],
] as const;

const stories = [
  ["fed", "Fed holds rates", "The central bank kept rates where they were."],
  ["etf", "ETF inflows rise", "Funds saw new money for a third week."],
  ["mine", "Miners expand", "Hash rate climbed to a new high."],
] as const;

const results = [
  ["bitcoin-price", "Bitcoin price today"],
  ["bitcoin-news", "Bitcoin news"],
  ["bitcoin-wallets", "Bitcoin wallets compared"],
] as const;

// A seeded shuffle, so a drifted visit can be told again exactly.
const shuffled = <A>(items: ReadonlyArray<A>, seed: number): Array<A> => {
  let state = seed * 2654435761;
  const next = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
  const out = [...items];

  for (let index = out.length - 1; index > 0; index--) {
    const other = Math.floor(next() * (index + 1));

    [out[index], out[other]] = [out[other] as A, out[index] as A];
  }

  // A reorder that changed nothing would test nothing.
  return out.every((item, index) => item === items[index]) ? out.reverse() : out;
};

const layout = (drift: Drift, truth: string, title: string, main: string) => {
  const { operator, seed } = drift;
  const renamed = operator === "rename";

  const nav = `<nav><a href="/markets">${renamed ? "Market data" : "Markets"}</a>
    <a href="/news">${renamed ? "Latest news" : "News"}</a></nav>`;

  const banner =
    operator === "shift"
      ? `<div style="height:${100 + (seed % 3) * 100}px">Breaking: a banner</div>`
      : "";

  // What a walk acts on moves below the fold, under the nav and a tall empty band.
  const spacer = operator === "offscreen" ? `<div style="height:1500px"></div>` : "";

  const overlay =
    operator === "overlay"
      ? `<div role="dialog" aria-label="Cookies" style="position:fixed;inset:0;background:rgba(0,0,0,0.5)"><button>Accept all</button></div>`
      : "";

  const footer =
    operator === "duplicate" ? `<footer><p>More</p><a href="/markets">Markets</a></footer>` : "";

  // The first paint shows nothing for one to three seconds.
  const slow = operator === "slow";

  const reveal = slow
    ? `<script>setTimeout(() => (document.body.style.visibility = "visible"), ${1000 + (seed % 3) * 1000})</script>`
    : "";

  const body =
    operator === "variant"
      ? `<main>${main}</main><aside>${nav}</aside>`
      : `${nav}${spacer}<main>${main}</main>`;

  return `<!doctype html><title>${title}</title>
<body data-truth="${truth}"${slow ? ` style="visibility:hidden"` : ""}>${reveal}${banner}${body}${footer}${overlay}</body>`;
};

// What `remove` and `insert` do to a list: the item a walk acted on goes, or another takes its
// place, or a new one comes first.
const edited = <A>(
  drift: Drift,
  items: ReadonlyArray<A>,
  removed: (item: A) => A | undefined,
  added: A,
): ReadonlyArray<A> =>
  drift.operator === "remove"
    ? items.map(removed).filter((item) => item !== undefined)
    : drift.operator === "insert"
      ? [added, ...items]
      : drift.operator === "reorder"
        ? shuffled(items, drift.seed)
        : items;

const markets = (drift: Drift) => {
  // ETH is delisted, and a wrapped token whose name holds its own stays.
  const rows = edited<readonly [string, string]>(
    drift,
    coins,
    (coin) => (coin[0] === "ETH" ? ["Wrapped ETH", "$3,090"] : coin),
    ["USDT", "$1.00"],
  );

  const promo =
    drift.operator === "duplicate" ? `<p>New here? <a href="/buy?coin=BTC">Buy</a></p>` : "";

  const listing =
    drift.operator === "variant"
      ? `<ul>${rows.map(([coin, price]) => `<li><strong>${coin}</strong> <span>${price}</span> <a href="/buy?coin=${coin}">Buy</a></li>`).join("")}</ul>`
      : `<table><thead><tr><th>#</th><th>Coin</th><th>Price</th><th>Trade</th></tr></thead><tbody>
${rows.map(([coin, price], rank) => `<tr><td>${rank + 1}</td><td>${coin}</td><td>${price}</td><td><a href="/buy?coin=${coin}">Buy</a></td></tr>`).join("")}
</tbody></table>`;

  return `<h1>Markets</h1>${promo}
<div role="tablist"><button role="tab" aria-selected="true">Spot</button>
<button role="tab" aria-selected="false" onclick="document.body.dataset.truth = 'markets:futures'">Futures</button></div>
${listing}`;
};

const news = (drift: Drift) => {
  // Only one story stays, and it is not the one a walk read.
  const items = edited<readonly [string, string, string]>(
    drift,
    stories,
    (story) => (story[0] === "mine" ? story : undefined),
    ["new", "Exchange opens", "A new venue started trading."],
  );

  const box = drift.operator === "variant" ? ["div", "h3"] : ["article", "h2"];

  return `<h1>News</h1>${items
    .map(
      ([id, title, summary]) =>
        `<${box[0]}><${box[1]}>${title}</${box[1]}><p>${summary}</p><a href="/article/${id}">Read more</a></${box[0]}>`,
    )
    .join("")}`;
};

const search = (drift: Drift) => {
  const items = edited<readonly [string, string]>(
    drift,
    results,
    (result) => (result[0] === "bitcoin-price" ? undefined : result),
    ["bitcoin-guide", "Bitcoin guide"],
  );

  return `<h1>Results</h1><ul>${items.map(([id, title]) => `<li><a href="/result/${id}">${title}</a></li>`).join("")}</ul>`;
};

// A canvas game: only a press inside its SPIN button, at 225–375 × 290–350 on the canvas, spins.
const game = `<h1>Game</h1><canvas width="600" height="400"></canvas>
<script>
  const canvas = document.querySelector("canvas"), g = canvas.getContext("2d");
  let spins = 0;
  g.fillStyle = "#222"; g.fillRect(0, 0, 600, 400);
  g.fillStyle = "#c33"; g.fillRect(225, 290, 150, 60);
  canvas.addEventListener("click", (event) => {
    const box = canvas.getBoundingClientRect(), x = event.clientX - box.left, y = event.clientY - box.top;
    if (x >= 225 && x <= 375 && y >= 290 && y <= 350) document.body.dataset.truth = "spins:" + ++spins;
  });
</script>`;

const home = `<h1>Portal</h1>
<form action="/search"><label>Search <input name="q"></label> <button>Go</button></form>`;

const truly = (truth: string) => `onclick="document.body.dataset.truth = '${truth}'"`;

// A product sold out: the one "Add to cart" left is a recommendation's.
const shop = (drift: Drift) => {
  const product = (name: string, price: string, sold = false) =>
    `<h2>${name}</h2><p>${sold ? "Out of stock" : price}</p>${sold ? "" : `<button ${truly(`cart:${name}`)}>Add to cart</button>`}`;

  const removed = drift.operator === "remove";

  return `${drift.operator === "insert" ? product("Green cap", "$15") : ""}${product("Blue T-shirt", "$20", removed)}
<h2>Recommended</h2><h3>Red mug</h3><p>$9</p>${removed ? `<button ${truly("cart:Red mug")}>Add to cart</button>` : ""}`;
};

// A list, not a table, where only the words beside each button say whose it is. Once Bob has
// gone, Alice's is the one "Remove" left.
const team = (drift: Drift) =>
  `<h1>Team</h1><ul>${edited(
    drift,
    ["Alice", "Bob"],
    (name) => (name === "Bob" ? undefined : name),
    "Carol",
  )
    .map((name) => `<li>${name} <button ${truly(`removed:${name}`)}>Remove</button></li>`)
    .join("")}</ul>`;

// A sign-in form that gains a field between the two a walk fills, or, in its variant, shows the
// password as it is typed. Its truth is what each field holds.
const signin = (drift: Drift) => {
  const field = (label: string, id: string, type = "text") =>
    `<label>${label} <input id=${id} type=${type} oninput="document.body.dataset.truth = 'signin:' + u.value + ':' + p.value.length + ':' + (window.c?.value.length ?? 0)"></label>`;

  const company = drift.operator === "insert" ? field("Company", "c") : "";
  const password = field("Password", "p", drift.operator === "variant" ? "text" : "password");

  return `<h1>Sign in</h1><form onsubmit="return false">${field("Username", "u")}${company}${password}<button>Sign in</button></form>`;
};

/** The page for a path under a drift, or a redirect, or nothing. */
const route = (
  url: URL,
  drift: Drift,
): { readonly html: string } | { readonly to: string } | undefined => {
  const moved = drift.operator === "redirect";
  const path = url.pathname;

  if (moved && (path === "/markets" || path === "/news"))
    return { to: `${path}-moved${url.search}` };
  if (path === "/") return { html: layout(drift, "home", "Portal", home) };
  if (path === "/game") return { html: layout(drift, "spins:0", "Game", game) };
  if (path === "/shop") return { html: layout(drift, "shop", "Shop", shop(drift)) };
  if (path === "/team") return { html: layout(drift, "team", "Team", team(drift)) };
  if (path === "/signin") return { html: layout(drift, "signin", "Sign in", signin(drift)) };
  if (path === "/markets" || path === "/markets-moved")
    return { html: layout(drift, "markets:spot", "Markets", markets(drift)) };
  if (path === "/news" || path === "/news-moved")
    return { html: layout(drift, "news", "News", news(drift)) };
  if (path === "/search")
    return {
      html: layout(drift, `search:${url.searchParams.get("q") ?? ""}`, "Search", search(drift)),
    };
  const [, kind, id] = /^\/(article|result)\/([\w-]+)$/.exec(path) ?? [];

  if (kind !== undefined && id !== undefined)
    return { html: layout(drift, `${kind}:${id}`, id, `<h1>${id}</h1>`) };
  if (path === "/buy") {
    const coin = url.searchParams.get("coin") ?? "";

    return { html: layout(drift, `buy:${coin}`, `Buy ${coin}`, `<h1>Buy ${coin}</h1>`) };
  }

  return undefined;
};

export class DriftSite extends Context.Service<
  DriftSite,
  {
    readonly url: (path: string) => string;
    readonly drift: (next: Drift) => Effect.Effect<void>;
  }
>()("test/DriftSite") {}

export const DriftSiteLayer = Layer.effect(
  DriftSite,
  Effect.gen(function* () {
    let current: Drift = { operator: "none", seed: 1 };

    const server = yield* Effect.acquireRelease(
      Effect.callback<ReturnType<typeof createServer>>((resume) => {
        const server = createServer((request, response) => {
          const page = route(new URL(request.url ?? "/", "http://drift"), current);

          if (page === undefined) {
            response.writeHead(404, { "content-type": "text/html" });
            response.end("<title>Not found</title>");
          } else if ("to" in page) {
            response.writeHead(301, { location: page.to });
            response.end();
          } else {
            response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            response.end(page.html);
          }
        });

        server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
      }),
      (server) => Effect.callback<void>((resume) => void server.close(() => resume(Effect.void))),
    );

    const { port } = server.address() as AddressInfo;

    return DriftSite.of({
      url: (path) => `http://127.0.0.1:${port}${path}`,
      drift: (next) =>
        Effect.sync(() => {
          current = next;
        }),
    });
  }),
);
