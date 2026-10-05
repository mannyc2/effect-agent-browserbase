// The bench's pages, served at https://bench.test by request interception, so a local Chromium
// and a hosted browser load them the same way, with no tunnel or public server. Each page keeps
// its ground truth in `window.__bench` for grading; models never see it.
import { Effect, Schema } from "effect";
import type * as Browser from "effect-browser/Browser";
import type { Page } from "effect-browser/Page";

export const origin = "https://bench.test";

export const routes = {
  quotes: "/markets/quotes",
  denseQuotes: "/markets/quotes/dense",
  tumble: "/casino/tumble",
  order: "/markets/btc",
  navigation: "/casino",
  navigationDestination: "/casino/reels",
} as const;

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
  $("play").onclick = () => {
    if (!__bench.adult) return;
    sessionStorage.setItem("bench-navigation-trigger", "Play");
    location.href = "/casino/reels";
  };
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
  let seed = 7 + window.__benchSeed, grid = [[0, 1, 2], [3, 4, 5], [6, 0, 1], [2, 3, 4], [5, 6, 0]].map((c) => c.map((i) => symbols[i]));
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
  function paint(now) {
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
  }
  function draw(now) {
    paint(now);
    if (state.spinning && now >= stops[4]) {
      state.spinning = false;
      const result = state.results.at(-1);
      state.credits += result.pay; state.lastWin = result.pay;
      draw(now);
    } else if (state.spinning) requestAnimationFrame(draw);
    else __benchSettled(() => paint(performance.now()));
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
  let seed = 3 + window.__benchSeed;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  // Half the seeds drift up and half down, so no constant trend answer passes.
  const drift = window.__benchSeed % 2 === 0 ? 0.42 : 0.58;
  const candles = [];
  let price = 64000;
  const next = (jump) => {
    const open = price, close = jump ? open * 1.035 : open * (1 + (random() - drift) * 0.004);
    const high = Math.max(open, close) * (1 + random() * 0.0015), low = Math.min(open, close) * (1 - random() * 0.0015);
    price = close; candles.push({ open, high, low, close });
  };
  for (let i = 0; i < 60; i++) next(false);
  window.__bench = { last: price, first: candles[0].open, trend: "up", spikeAt: null, candles: 60, orders: [] };
  const state = window.__bench;
  const g = document.getElementById("chart").getContext("2d");
  function paint() {
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
  }
  function draw() {
    paint();
    const shown = candles.slice(-60), last = shown.at(-1).close;
    state.last = Math.round(last * 100) / 100; state.first = shown[0].open; state.trend = last >= shown[0].open ? "up" : "down";
    __benchSettled(paint);
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
    __benchSettled(paint);
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

// Every displayed value has one table, asset and period. Distinct magnitudes let the grader
// distinguish those binding mistakes even when the same ticker appears in three panels.
const quotes = (
  dense: boolean,
) => `<!doctype html><html><head><title>Market overview</title><style>${style}
body{background:#10151e;color:#d6dfed;padding:16px;font-size:13px}
header{display:flex;justify-content:space-between;border-bottom:1px solid #344152;padding-bottom:10px}
h1{font-size:24px;margin:14px 0 4px}p{color:#899bb4;margin:5px 0 12px}
.tape{padding:8px;background:#1a2330;white-space:nowrap;overflow:hidden;font-size:12px}
.panels{display:grid;grid-template-columns:${dense ? "repeat(3,minmax(0,1fr))" : "minmax(0,900px)"};gap:12px}
.panel{background:#17202d;border:1px solid #344152;border-radius:6px;padding:10px;min-width:0}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;font-size:${dense ? 11 : 15}px}
caption{text-align:left;font-size:16px;font-weight:650;padding:2px 0 12px;color:#eef4ff}
th{color:#91a4c0;font-weight:500;font-size:${dense ? 10 : 12}px;text-align:right;white-space:nowrap}
td,th{padding:${dense ? "7px 3px" : "9px 8px"};border-bottom:1px solid #283548}td{text-align:right;white-space:nowrap}
th:first-child,td:first-child{text-align:left}.focus{background:#223349}.up{color:#48c3a2}.down{color:#f3878a}
footer{margin-top:16px;background:#251f16;padding:12px;border-left:3px solid #e6ad48;color:#e6c891}
canvas{width:100%;height:95px;margin:10px 0}
</style></head><body>
<header><strong>HARBOR MARKETS</strong><span>Overview · Markets · Watchlists</span></header>
<h1 id="focus"></h1><p>USD quotes · Market overview · Prices shown in US dollars</p>
<div class="tape" id="tape"></div><canvas id="spark" width="1200" height="95"></canvas>
<div class="panels" id="panels"></div><footer id="trending"></footer>
<script>
  const trial = window.__benchSeed;
  let randomState = (trial ^ 0x5a17c9e3) >>> 0;
  const random = () => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState / 4294967296; };
  const shuffle = (values) => {
    const result = [...values];
    for (let index = result.length - 1; index > 0; index--) {
      const other = Math.floor(random() * (index + 1));
      [result[index], result[other]] = [result[other], result[index]];
    }
    return result;
  };
  const assets = [
    ["BTC-USD", 64325.17], ["ETH-USD", 3124.86], ["SOL-USD", 146.28], ["XRP-USD", 0.5284],
    ["DOGE-USD", 0.1148], ["ADA-USD", 0.3852], ["ETC-USD", 23.51], ["AVAX-USD", 28.63],
    ["LINK-USD", 14.74], ["DOT-USD", 4.29]
  ].slice(0, ${dense ? 10 : 6});
  const focus = assets[trial % assets.length][0];
  const labels = ${dense ? '["Spot markets", "Perpetual futures", "Evening watchlist"]' : '["Spot markets"]'};
  const rows = labels.flatMap((table, tableIndex) => assets.map(([ticker, base], assetIndex) => {
    const change = (period) => {
      const magnitude = 31 + (trial % 97) * 3 + tableIndex * 401 + assetIndex * 29 + period * 7;
      return magnitude * ((trial + tableIndex + assetIndex + period) % 3 === 0 ? -1 : 1) / 100;
    };
    const precision = base < 1 ? 10000 : 100;
    const price = Math.round(base * (1 + ((trial % 43) - 21) / 1000 + tableIndex / 80) * precision) / precision;
    return { ticker, table, price, c1h: change(0), c24h: change(1), c7d: change(2) };
  }));
  const money = (value) => "$" + value.toLocaleString("en-US", { minimumFractionDigits: value < 1 ? 4 : 2, maximumFractionDigits: value < 1 ? 4 : 2 });
  const percent = (value) => (value >= 0 ? "+" : "") + value.toFixed(2) + "%";
  const panels = document.getElementById("panels");
  for (const table of shuffle(labels)) {
    const columns = shuffle([["1h %", "c1h"], ["24h %", "c24h"], ["7d %", "c7d"]]);
    const data = shuffle(rows.filter((row) => row.table === table));
    const headers = columns.map(([label]) => "<th scope='col'>" + label + "</th>").join("");
    const body = data.map((row, index) => "<tr" + (row.ticker === focus ? " class='focus'" : "") + "><td>" + row.ticker + "</td><td>" + money(row.price) + "</td>" +
      columns.map(([, key]) => "<td class='" + (row[key] >= 0 ? "up" : "down") + "'>" + percent(row[key]) + "</td>").join("") +
      (${dense} ? "<td>$" + (8.4 + index * 3.7 + labels.indexOf(table)).toFixed(1) + "M</td>" : "") + "</tr>").join("");
    panels.insertAdjacentHTML("beforeend", "<section class='panel'><table aria-label='" + table + "'><caption>" + table + "</caption><thead><tr><th scope='col'>Asset</th><th scope='col'>Price</th>" + headers + (${dense} ? "<th scope='col'>24h volume</th>" : "") + "</tr></thead><tbody>" + body + "</tbody></table></section>");
  }
  document.getElementById("focus").textContent = focus;
  document.title = focus + " | Harbor Markets";
  document.getElementById("tape").textContent = "PEPE-USD +18.42%     NEAR-USD -3.19%     APT-USD +5.28%     TRX-USD +0.82%     SHIB-USD -1.74%";
  document.getElementById("trending").textContent = "Trending now: PEPE-USD +18.42% · Futures turnover $284M · Figures refer to their labelled market and period.";
  const plot = document.getElementById("spark").getContext("2d");
  const spark = [];
  let y = 48;
  for (let x = 0; x <= 1200; x += 8) { y = Math.max(8, Math.min(87, y + (random() - 0.5) * 13)); spark.push([x, y]); }
  const paint = () => {
    plot.clearRect(0, 0, 1200, 95); plot.strokeStyle = "#42bba0"; plot.lineWidth = 2; plot.beginPath();
    for (const [x, y] of spark) plot.lineTo(x, y);
    plot.stroke();
  };
  paint();
  const current = rows.find((row) => row.table === "Spot markets" && row.ticker === focus);
  window.__bench = { focus, price: current.price, c1h: current.c1h, c24h: current.c24h, c7d: current.c7d, header: "24h %", table: "Spot markets", rows };
  __benchSettled(paint);
</script></body></html>`;

// The animation is derived from elapsed time rather than a timer chain. A delayed render still
// applies every completed cascade exactly once, while the retained frames show its visual phases.
const tumble = `<!doctype html><html><head><title>Olympus Cascade</title><style>${style}
body{background:#150e26}canvas{display:block}
</style></head><body><canvas id="game" width="1000" height="680"></canvas><script>
  const trial = window.__benchSeed;
  let randomState = (trial ^ 0x2c93157b) >>> 0;
  const random = () => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState / 4294967296; };
  const tumbles = 1 + trial % 4, multiplier = [1, 2, 5, 10][Math.floor(trial / 4) % 4];
  const cents = Array.from({ length: tumbles }, () => 100 + Math.floor(random() * 1100));
  const durationMillis = 600 + tumbles * 1800 + 1200;
  const state = { tumbles, multiplier, totalWin: 0, balance: 1000, done: false, phase: "ready", completedTumbles: 0, durationMillis, pays: cents.map((value) => value / 100) };
  window.__bench = state;
  const symbols = ["G", "A", "P", "B", "H", "D", "C"], colours = ["#9261d0", "#39a88d", "#e38fc5", "#d8b443", "#d96075", "#438fd3", "#db9552"];
  const grid = Array.from({ length: 30 }, () => Math.floor(random() * symbols.length));
  const canvas = document.getElementById("game"), paint = canvas.getContext("2d");
  const cash = (value) => value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  let started = 0;
  function draw(now) {
    const elapsed = state.phase === "ready" ? 0 : Math.max(0, now - started);
    const totalAt = 600 + tumbles * 1800;
    const completed = state.phase === "ready" ? 0 : Math.min(tumbles, Math.max(0, Math.floor((elapsed - 1800) / 1800) + 1));
    state.completedTumbles = completed;
    const earned = cents.slice(0, completed).reduce((sum, value) => sum + value, 0) / 100;
    state.totalWin = elapsed >= totalAt ? Math.round(earned * multiplier * 100) / 100 : earned;
    const settles = elapsed >= durationMillis && state.phase === "spinning";
    if (settles) {
      state.done = true; state.phase = "complete"; state.balance = Math.round((998 + state.totalWin) * 100) / 100;
    }
    paint.fillStyle = "#291b46"; paint.fillRect(0, 0, 1000, 680);
    paint.fillStyle = "#f6ecd9"; paint.font = "bold 25px sans-serif";
    paint.fillText("BALANCE " + cash(state.balance), 32, 43);
    paint.fillText("BET 2.00", 416, 43); paint.fillText("WIN " + cash(state.totalWin), 640, 43);
    const cycle = Math.min(tumbles - 1, Math.max(0, Math.floor((elapsed - 600) / 1800)));
    const progress = elapsed - 600 - cycle * 1800;
    for (let column = 0; column < 6; column++) for (let row = 0; row < 5; row++) {
      const index = column * 5 + row, marked = (index + trial % 30 + cycle * 7) % 30 < 8;
      const active = state.phase === "spinning" && elapsed >= 600 && elapsed < totalAt;
      let scale = 1, offset = 0;
      if (state.phase === "spinning" && elapsed < 600) offset = -450 * (1 - elapsed / 600);
      if (active && marked && progress >= 350 && progress < 700) scale = 1 - (progress - 350) / 350;
      if (active && marked && progress >= 700 && progress < 1200) offset = -250 * (1 - (progress - 700) / 500);
      const symbol = marked && active && progress < 700 ? cycle % symbols.length : (grid[index] + cycle + (progress >= 700 ? 1 : 0)) % symbols.length;
      const x = 125 + column * 125 + 60, y = 94 + row * 104 + 50 + offset;
      paint.beginPath(); paint.arc(x, y, 42 * scale, 0, Math.PI * 2); paint.fillStyle = colours[symbol]; paint.fill();
      if (active && marked && progress < 350) { paint.lineWidth = 5; paint.strokeStyle = Math.floor(progress / 70) % 2 === 0 ? "#fff6be" : "#d8b443"; paint.stroke(); }
      if (scale > 0.25) { paint.fillStyle = "#fff"; paint.font = "bold " + Math.round(35 * scale) + "px sans-serif"; paint.textAlign = "center"; paint.fillText(symbols[symbol], x, y + 12 * scale); paint.textAlign = "start"; }
    }
    if (multiplier > 1 && completed === tumbles) {
      paint.beginPath(); paint.arc(916, 135, 40, 0, Math.PI * 2); paint.fillStyle = "#f5cc50"; paint.fill();
      paint.fillStyle = "#38204d"; paint.font = "bold 28px sans-serif"; paint.textAlign = "center"; paint.fillText("×" + multiplier, 916, 145); paint.textAlign = "start";
    }
    if (state.phase === "spinning" && elapsed >= totalAt) {
      paint.fillStyle = "#130920e8"; paint.fillRect(180, 260, 650, 150); paint.fillStyle = "#f5cc50"; paint.font = "bold 46px sans-serif";
      paint.textAlign = "center"; paint.fillText("TOTAL WIN " + cash(state.totalWin), 505, 350); paint.textAlign = "start";
    }
    paint.fillStyle = state.phase === "ready" ? "#b63557" : "#51455e"; paint.fillRect(430, 625, 140, 46);
    paint.fillStyle = "#fff"; paint.font = "bold 26px sans-serif"; paint.fillText("SPIN", 466, 657);
    if (settles) __benchSettled(() => draw(performance.now()));
    if (state.phase === "spinning") requestAnimationFrame(draw);
  }
  canvas.addEventListener("click", (event) => {
    const box = canvas.getBoundingClientRect(), x = event.clientX - box.left, y = event.clientY - box.top;
    if (state.phase !== "ready" || x < 430 || x > 570 || y < 625 || y > 671) return;
    state.phase = "spinning"; state.balance = 998; started = performance.now(); requestAnimationFrame(draw);
  });
  draw(0);
</script></body></html>`;

const pages: Readonly<Record<string, string>> = {
  "/casino": lobby,
  "/casino/reels": reels,
  "/markets/btc": markets,
  "/shop/checkout": checkout,
  [routes.quotes]: quotes(false),
  [routes.denseQuotes]: quotes(true),
  [routes.tumble]: tumble,
};

// A screencast can drop an animation's final paint for good once the page goes still. A settled
// fixture records its last change for the capture barrier, then paints the same state once more.
const settled = `window.__benchSettled = (repaint) => { window.__bench.frameAfter = performance.timeOrigin + performance.now(); setTimeout(() => requestAnimationFrame(repaint), 150); };`;

/** Serve the bench pages to every page of `browser` while the scope is open. */
export const serve = (browser: Browser.Service, seed = 0) =>
  Effect.acquireRelease(
    Effect.promise(() =>
      browser.context.route(`${origin}/**`, (route) => {
        const page = pages[new URL(route.request().url()).pathname];

        return route.fulfill(
          page === undefined
            ? { status: 404, contentType: "text/plain", body: "not found" }
            : {
                status: 200,
                contentType: "text/html; charset=utf-8",
                // Seed every document at this boundary so redirects retain the trial's identity.
                body: page
                  .replace(
                    "<head>",
                    `<head><script>window.__benchSeed = ${seed};${settled}</script>`,
                  )
                  .replace(
                    "</body>",
                    `<script>Object.assign(window.__bench, { frameAfter: performance.timeOrigin + performance.now(), url: location.href, title: document.title, trigger: sessionStorage.getItem("bench-navigation-trigger") ?? "direct" });</script></body>`,
                  ),
              },
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

export const OrderTruth = Schema.Struct({
  id: Schema.String,
  side: Schema.String,
  qty: Schema.Finite,
  type: Schema.String,
  price: Schema.Finite,
  status: Schema.String,
});

export const MarketTruth = Schema.Struct({
  last: Schema.Finite,
  first: Schema.Finite,
  trend: Schema.Literals(["up", "down"]),
  spikeAt: Schema.NullOr(Schema.Finite),
  candles: Schema.Finite,
  orders: Schema.Array(OrderTruth),
});

export const CheckoutTruth = Schema.Struct({
  submitted: Schema.NullOr(Schema.Record(Schema.String, Schema.String)),
  confirmation: Schema.NullOr(Schema.String),
});

const QuoteRow = Schema.Struct({
  ticker: Schema.String,
  table: Schema.String,
  price: Schema.Finite,
  c1h: Schema.Finite,
  c24h: Schema.Finite,
  c7d: Schema.Finite,
});

export const QuoteTruth = Schema.Struct({
  focus: Schema.String,
  price: Schema.Finite,
  c1h: Schema.Finite,
  c24h: Schema.Finite,
  c7d: Schema.Finite,
  header: Schema.String,
  table: Schema.String,
  rows: Schema.Array(QuoteRow),
});

export const TumbleTruth = Schema.Struct({
  tumbles: Schema.Int,
  multiplier: Schema.Int,
  totalWin: Schema.Finite,
  balance: Schema.Finite,
  done: Schema.Boolean,
  phase: Schema.Literals(["ready", "spinning", "complete"]),
  completedTumbles: Schema.Int,
  durationMillis: Schema.Finite,
  pays: Schema.Array(Schema.Finite),
});

export const NavigationTruth = Schema.Struct({
  url: Schema.String,
  title: Schema.String,
  trigger: Schema.String,
});

/** Browser-epoch boundary after the fixture's last required DOM or canvas change. */
export const FrameTruth = Schema.Struct({ frameAfter: Schema.Finite });
