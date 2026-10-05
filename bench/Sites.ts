// The bench's pages, served at https://bench.test by request interception, so a local Chromium
// and a hosted browser load them the same way, with no tunnel or public server. Each page keeps
// its ground truth in `window.__bench` for grading; models never see it.
import { Effect, Schema } from "effect";
import type * as Browser from "effect-browser/Browser";
import type { Page } from "effect-browser/Page";

export const origin = "https://bench.test";

const style = `body{margin:0;font-family:system-ui,sans-serif}button{font:inherit;cursor:pointer}`;

// A lobby behind a cookie wall and an age check, as real casino sites are.
const lobby = `<!doctype html><html><head><title>Lucky Harbor Casino</title><style>${style}
body{background:#0d1b2a;color:#eee}
header{display:flex;justify-content:space-between;padding:16px 24px;background:#1b263b}
.games{display:grid;grid-template-columns:repeat(3,260px);gap:24px;padding:0 24px}
.card{background:#24344d;border-radius:12px;padding:16px}
.art{height:120px;border-radius:8px}
.card button{padding:10px 18px;border:0;border-radius:8px;background:#e0a526;color:#111}
.card button[disabled]{background:#555;color:#999}
.wall{position:fixed;inset:0;background:#000a;display:flex}
#cookies{align-items:flex-end}#gate{display:none;align-items:center;justify-content:center}
.box{background:#fff;color:#111;padding:24px;border-radius:12px;margin:24px}
</style></head><body>
<header><strong>Lucky Harbor</strong><span>Demo credits only</span></header>
<main><h1 style="padding:0 24px">Games</h1><div class="games">
  <div class="card"><div class="art" style="background:linear-gradient(135deg,#e0a526,#8a2be2)"></div>
    <h2>Temple Reels</h2><p>5 reels, 3 rows</p><button id="play">Play</button></div>
  <div class="card"><div class="art" style="background:linear-gradient(135deg,#2a9d8f,#264653)"></div>
    <h2>Dragon Wheel</h2><p>Coming soon</p><button disabled>Play</button></div>
  <div class="card"><div class="art" style="background:linear-gradient(135deg,#e76f51,#f4a261)"></div>
    <h2>High Card</h2><p>Coming soon</p><button disabled>Play</button></div>
</div></main>
<div id="cookies" class="wall" role="dialog" aria-label="Cookies"><div class="box" style="width:100%">
  <p>We use cookies to run this demo.</p><button id="reject">Reject all</button> <button id="accept">Accept all</button>
</div></div>
<div id="gate" class="wall" role="dialog" aria-label="Age check"><div class="box">
  <h2>Are you 18 or older?</h2><p>You must be of legal age to play.</p>
  <button id="adult">Yes, I am 18 or older</button> <button id="minor">No</button>
</div></div>
<script>
  window.__bench = { cookies: null, adult: null };
  const $ = (id) => document.getElementById(id);
  const decide = (choice) => { __bench.cookies = choice; $("cookies").remove(); $("gate").style.display = "flex"; };
  $("accept").onclick = () => decide("accepted");
  $("reject").onclick = () => decide("rejected");
  $("adult").onclick = () => { __bench.adult = true; $("gate").remove(); };
  $("minor").onclick = () => { __bench.adult = false; $("gate").querySelector("h2").textContent = "Sorry, you cannot play."; };
  $("play").onclick = () => { if (__bench.adult) location.href = "/casino/reels"; };
</script></body></html>`;

// Five reels drawn on a canvas with no DOM controls, so only pictures and points can play it.
// Wins are scheduled (spin 2 pays 20x on three 7s, spin 4 pays 8x on four Ks) so truth is known.
const reels = `<!doctype html><html><head><title>Temple Reels</title><style>${style}body{background:#120c1f}</style></head>
<body><canvas id="game" width="960" height="600"></canvas><script>
  const g = document.getElementById("game").getContext("2d");
  const symbols = ["A", "K", "Q", "J", "10", "7", "\\u2605"];
  const colours = { A: "#e63946", K: "#457b9d", Q: "#2a9d8f", J: "#e9c46a", "10": "#f4a261", "7": "#d00000", "\\u2605": "#ffb703" };
  const wins = { 2: ["7", 3, 20], 4: ["K", 4, 8] };
  const bets = [1, 2, 5, 10, 20, 50];
  let seed = 7, grid = [[0, 1, 2], [3, 4, 5], [6, 0, 1], [2, 3, 4], [5, 6, 0]].map((c) => c.map((i) => symbols[i]));
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  window.__bench = { credits: 1000, bet: 10, spins: 0, spinning: false, lastWin: 0, results: [] };
  const state = window.__bench;
  let started = 0, stops = [];
  const money = (n) => n.toLocaleString("en-US");
  function outcome(spin) {
    const columns = Array.from({ length: 5 }, () => Array.from({ length: 3 }, () => symbols[Math.floor(random() * 6)]));
    const win = wins[spin], other = (s) => (s === "A" ? "K" : "A");
    if (win) {
      for (let c = 0; c < win[1]; c++) columns[c][1] = win[0];
      if (win[1] < 5) columns[win[1]][1] = other(win[0]);
    } else if (columns[1][1] === columns[0][1]) columns[1][1] = other(columns[0][1]);
    return { columns, pay: win ? state.bet * win[2] : 0, line: win ? win[1] : 0 };
  }
  function draw(now) {
    g.fillStyle = "#1d1233"; g.fillRect(0, 0, 960, 600);
    g.fillStyle = "#f1e3c8"; g.font = "bold 26px sans-serif";
    g.fillText("TEMPLE REELS", 30, 44);
    g.font = "22px sans-serif";
    g.fillText("CREDITS " + money(state.credits), 340, 44);
    g.fillText("BET " + state.bet, 600, 44);
    g.fillText("WIN " + money(state.lastWin), 760, 44);
    for (let c = 0; c < 5; c++) {
      const moving = state.spinning && now < stops[c];
      for (let r = 0; r < 3; r++) {
        const x = 40 + c * 180, y = 80 + r * 150;
        const symbol = moving ? symbols[Math.floor(now / 60 + c * 2 + r) % symbols.length] : grid[c][r];
        const lit = !state.spinning && r === 1 && c < (state.results.at(-1)?.line ?? 0);
        g.fillStyle = lit ? "#fff3b0" : "#f8f1e4"; g.fillRect(x, y, 160, 135);
        g.fillStyle = colours[symbol]; g.font = "bold 64px sans-serif";
        g.fillText(symbol, x + 80 - g.measureText(symbol).width / 2, y + 90);
      }
    }
    g.fillStyle = state.spinning ? "#555" : "#c1121f"; g.fillRect(400, 535, 160, 52);
    g.fillStyle = "#fff"; g.font = "bold 28px sans-serif"; g.fillText("SPIN", 446, 572);
    g.fillStyle = "#333"; g.fillRect(250, 535, 52, 52); g.fillRect(320, 535, 52, 52);
    g.fillStyle = "#fff"; g.fillText("-", 268, 570); g.fillText("+", 336, 572);
    if (state.spinning && now >= stops[4]) {
      state.spinning = false;
      const result = state.results.at(-1);
      state.credits += result.pay; state.lastWin = result.pay;
      draw(now);
    } else if (state.spinning) requestAnimationFrame(draw);
  }
  function spin() {
    if (state.spinning || state.credits < state.bet) return;
    state.spins += 1; state.credits -= state.bet; state.lastWin = 0; state.spinning = true;
    const result = outcome(state.spins);
    grid = result.columns;
    state.results.push({ spin: state.spins, middle: result.columns.map((c) => c[1]), pay: result.pay, line: result.line });
    started = performance.now(); stops = [0, 1, 2, 3, 4].map((c) => started + 900 + c * 150);
    requestAnimationFrame(draw);
  }
  function bet(step) {
    if (state.spinning) return;
    const index = Math.min(bets.length - 1, Math.max(0, bets.indexOf(state.bet) + step));
    state.bet = bets[index]; draw(performance.now());
  }
  document.getElementById("game").addEventListener("click", (event) => {
    const box = event.target.getBoundingClientRect(), x = event.clientX - box.left, y = event.clientY - box.top;
    if (y >= 535 && y <= 587 && x >= 400 && x <= 560) spin();
    if (y >= 535 && y <= 587 && x >= 250 && x <= 302) bet(-1);
    if (y >= 535 && y <= 587 && x >= 320 && x <= 372) bet(1);
  });
  document.addEventListener("keydown", (event) => { if (event.code === "Space") { event.preventDefault(); spin(); } });
  draw(0);
</script></body></html>`;

// A live candlestick chart drawn on a canvas, with prices shown only in the picture, beside a DOM
// order ticket. With ?live=1 a candle closes every second and the price jumps 3.5% at candle 66.
const markets = `<!doctype html><html><head><title>BTC-USD | Harbor Markets</title><style>${style}
body{background:#0b0e14;color:#d6dbe4;display:grid;grid-template-columns:960px 280px;gap:16px;padding:16px}
form{background:#151a23;padding:16px;border-radius:8px;display:grid;gap:10px}
input,select{font:inherit;padding:6px}table{width:100%;border-collapse:collapse;font-size:14px}
td,th{border-bottom:1px solid #2a3140;padding:4px;text-align:left}
</style></head><body>
<section><h1 style="margin:0 0 8px">BTC-USD <small style="color:#8a93a6">Bitcoin / US Dollar</small></h1>
<canvas id="chart" width="960" height="420"></canvas></section>
<aside><form id="ticket" onsubmit="return false"><h2 style="margin:0">Order</h2>
  <label><input type="radio" name="side" value="buy" checked> Buy</label>
  <label><input type="radio" name="side" value="sell"> Sell</label>
  <label>Quantity (BTC) <input id="qty" name="qty" inputmode="decimal" value=""></label>
  <label>Type <select id="type"><option value="market">Market</option><option value="limit">Limit</option></select></label>
  <button id="place" type="button">Place order</button><p id="note" role="status"></p></form>
  <h2>Orders</h2><table><thead><tr><th>Id</th><th>Side</th><th>Qty</th><th>Price</th><th>Status</th></tr></thead><tbody id="orders"></tbody></table>
</aside><script>
  const params = new URLSearchParams(location.search), live = params.get("live") === "1";
  let seed = 3;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const candles = [];
  let price = 64000;
  const next = (jump) => {
    const open = price, close = jump ? open * 1.035 : open * (1 + (random() - 0.42) * 0.004);
    const high = Math.max(open, close) * (1 + random() * 0.0015), low = Math.min(open, close) * (1 - random() * 0.0015);
    price = close; candles.push({ open, high, low, close });
  };
  for (let i = 0; i < 60; i++) next(false);
  window.__bench = { last: price, first: candles[0].open, trend: "up", spikeAt: null, candles: 60, orders: [] };
  const state = window.__bench;
  const g = document.getElementById("chart").getContext("2d");
  function draw() {
    const shown = candles.slice(-60), hi = Math.max(...shown.map((c) => c.high)), lo = Math.min(...shown.map((c) => c.low));
    const y = (v) => 20 + (hi - v) / (hi - lo) * 360;
    g.fillStyle = "#0b0e14"; g.fillRect(0, 0, 960, 420);
    g.strokeStyle = "#1f2633"; g.fillStyle = "#8a93a6"; g.font = "12px sans-serif";
    for (let i = 0; i <= 4; i++) { const v = lo + (hi - lo) * i / 4; g.beginPath(); g.moveTo(0, y(v)); g.lineTo(850, y(v)); g.stroke(); g.fillText(Math.round(v).toLocaleString("en-US"), 860, y(v) + 4); }
    shown.forEach((c, i) => {
      const x = 10 + i * 14, up = c.close >= c.open;
      g.strokeStyle = g.fillStyle = up ? "#26a69a" : "#ef5350";
      g.beginPath(); g.moveTo(x + 4, y(c.high)); g.lineTo(x + 4, y(c.low)); g.stroke();
      g.fillRect(x, Math.min(y(c.open), y(c.close)), 9, Math.max(1, Math.abs(y(c.open) - y(c.close))));
    });
    const last = shown.at(-1).close;
    g.fillStyle = "#f0b90b"; g.fillRect(850, y(last) - 11, 110, 22);
    g.fillStyle = "#111"; g.font = "bold 13px sans-serif"; g.fillText(last.toFixed(2), 856, y(last) + 5);
    state.last = Math.round(last * 100) / 100; state.first = shown[0].open; state.trend = last >= shown[0].open ? "up" : "down";
  }
  draw();
  if (live) setInterval(() => {
    const jump = candles.length === 65;
    next(jump); state.candles = candles.length;
    if (jump) state.spikeAt = Date.now();
    draw();
  }, 1000);
  document.getElementById("place").onclick = () => {
    const qty = Number(document.getElementById("qty").value), side = document.querySelector("input[name=side]:checked").value;
    const note = document.getElementById("note");
    if (!(qty > 0)) { note.textContent = "Enter a quantity."; return; }
    const order = { id: "ORD-" + (1001 + state.orders.length), side, qty, type: document.getElementById("type").value, price: state.last, status: "Filled" };
    state.orders.push(order);
    document.getElementById("orders").insertAdjacentHTML("beforeend", "<tr><td>" + order.id + "</td><td>" + side + "</td><td>" + qty + "</td><td>" + order.price.toFixed(2) + "</td><td>Filled</td></tr>");
    note.textContent = "Order " + order.id + " filled.";
  };
</script></body></html>`;

const checkout = `<!doctype html><html><head><title>Checkout | Harbor Goods</title><style>${style}
body{background:#fafafa;color:#222;padding:24px}form{display:grid;gap:12px;max-width:520px}
input,select{font:inherit;padding:8px}fieldset{border:1px solid #ccc;border-radius:8px}
</style></head><body><h1>Checkout</h1><p>1 x Harbor Lantern, $49.00</p>
<form id="form" onsubmit="return false">
  <label>Full name <input id="name" autocomplete="name" required></label>
  <label>Email <input id="email" type="email" required></label>
  <label>Street address <input id="street" required></label>
  <label>City <input id="city" required></label>
  <label>Postal code <input id="postal" required></label>
  <label>Country <select id="country"><option value="">Choose a country</option><option value="US">United States</option><option value="CA">Canada</option><option value="DE">Germany</option><option value="JP">Japan</option></select></label>
  <fieldset><legend>Shipping</legend>
    <label><input type="radio" name="ship" value="standard" checked> Standard (5-7 days)</label>
    <label><input type="radio" name="ship" value="express"> Express (1-2 days, +$15)</label></fieldset>
  <button id="submit" type="button">Place order</button><p id="message" role="status"></p>
</form><script>
  window.__bench = { submitted: null, confirmation: null };
  document.getElementById("submit").onclick = () => {
    const value = (id) => document.getElementById(id).value.trim();
    const fields = { name: value("name"), email: value("email"), street: value("street"), city: value("city"), postal: value("postal"), country: value("country"), shipping: document.querySelector("input[name=ship]:checked").value };
    const missing = Object.entries(fields).filter(([, v]) => v === "").map(([k]) => k);
    const message = document.getElementById("message");
    if (missing.length > 0) { message.textContent = "Please fill in: " + missing.join(", "); return; }
    __bench.submitted = fields; __bench.confirmation = "CONF-48213";
    document.getElementById("form").innerHTML = "<h2>Thank you!</h2><p>Your confirmation number is <strong>CONF-48213</strong>.</p>";
  };
</script></body></html>`;

const pages: Readonly<Record<string, string>> = {
  "/casino": lobby,
  "/casino/reels": reels,
  "/markets/btc": markets,
  "/shop/checkout": checkout,
};

/** Serve the bench pages to every page of `browser` while the scope is open. */
export const serve = (browser: Browser.Service) =>
  Effect.acquireRelease(
    Effect.promise(() =>
      browser.context.route(`${origin}/**`, (route) => {
        const page = pages[new URL(route.request().url()).pathname];

        return route.fulfill(
          page === undefined
            ? { status: 404, contentType: "text/plain", body: "not found" }
            : { status: 200, contentType: "text/html; charset=utf-8", body: page },
        );
      }),
    ),
    () => Effect.promise(() => browser.context.unrouteAll({ behavior: "ignoreErrors" })),
  );

/** A page's ground truth, decoded with `schema`. */
export const truth = <A, I>(page: Page, schema: Schema.Codec<A, I>) =>
  Effect.promise(() =>
    page.playwright.evaluate(() => (window as unknown as { __bench: unknown }).__bench),
  ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(schema)), Effect.orDie);

export const ReelsTruth = Schema.Struct({
  credits: Schema.Finite,
  bet: Schema.Finite,
  spins: Schema.Finite,
  spinning: Schema.Boolean,
  lastWin: Schema.Finite,
});

export const MarketTruth = Schema.Struct({
  last: Schema.Finite,
  first: Schema.Finite,
  trend: Schema.Literals(["up", "down"]),
  spikeAt: Schema.NullOr(Schema.Finite),
  candles: Schema.Finite,
  orders: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      side: Schema.String,
      qty: Schema.Finite,
      type: Schema.String,
      price: Schema.Finite,
    }),
  ),
});

export const CheckoutTruth = Schema.Struct({
  submitted: Schema.NullOr(Schema.Record(Schema.String, Schema.String)),
  confirmation: Schema.NullOr(Schema.String),
});
