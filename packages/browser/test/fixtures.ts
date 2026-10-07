// Pages for the tests, served from loopback: an order form, a canvas slot machine and a canvas
// price chart. The slot machine has no DOM controls at all, so only point input can play it.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { Context, Effect, Layer } from "effect";

const form = `<!doctype html><title>Order</title>
<body style="margin:0;font-family:sans-serif">
<nav aria-label="Main"><a href="/next">Next page</a> <a href="/next" target="_blank">Open in a new tab</a></nav>
<main>
  <h1>Place an order</h1>
  <label>Amount <input id="amount" value="10"></label>
  <label>Coin <select id="coin"><option value="btc">Bitcoin</option><option value="eth">Ethereum</option></select></label>
  <label><input type="checkbox" id="agree"> I agree</label>
  <button id="submit" onclick="outcome.textContent = 'Ordered ' + amount.value + ' ' + coin.value + (agree.checked ? ' (agreed)' : '')">Submit</button>
  <p id="outcome">Not ordered</p>
  <input type="range" id="slider" min="0" max="100" value="0" aria-label="Level" style="display:block;width:400px;margin:0">
  <output id="level">0</output>
  <script>slider.oninput = () => (level.textContent = slider.value)</script>
  <div style="height:3000px"></div>
  <p>Bottom of the page</p>
</main>`;

const next = `<!doctype html><title>Next</title><body><h1>The next page</h1><button>Continue</button></body>`;

// The SPIN button is painted at x 225 to 375, y 290 to 350. A spin animates for 1.2 seconds.
const slots = `<!doctype html><title>Reels</title>
<body style="margin:0;background:#111">
<canvas id="game" width="600" height="400"></canvas>
<script>
  const g = game.getContext("2d");
  const symbols = ["7", "BAR", "*", "$"];
  let spinning = false, start = 0;
  window.state = { spins: 0, spinning: false, result: ["7", "7", "7"] };
  function draw(now) {
    g.fillStyle = "#222"; g.fillRect(0, 0, 600, 400);
    for (let i = 0; i < 3; i++) {
      g.fillStyle = "#eee"; g.fillRect(50 + i * 170, 60, 150, 180);
      g.fillStyle = "#111"; g.font = "48px sans-serif";
      g.fillText(spinning ? symbols[Math.floor(now / 50 + i) % 4] : state.result[i], 90 + i * 170, 170);
    }
    g.fillStyle = spinning ? "#555" : "#c33"; g.fillRect(225, 290, 150, 60);
    g.fillStyle = "#fff"; g.font = "28px sans-serif"; g.fillText("SPIN", 265, 330);
    if (spinning && now - start > 1200) {
      spinning = false;
      const spins = state.spins + 1;
      state = { spins, spinning: false, result: [0, 1, 2].map((i) => symbols[(spins + i) % 4]) };
      draw(now);
    } else if (spinning) requestAnimationFrame(draw);
  }
  game.addEventListener("click", (event) => {
    const box = game.getBoundingClientRect();
    const x = event.clientX - box.left, y = event.clientY - box.top;
    if (spinning || x < 225 || x > 375 || y < 290 || y > 350) return;
    spinning = true; start = performance.now(); state = { ...state, spinning: true };
    requestAnimationFrame(draw);
  });
  draw(0);
</script>`;

const chart = `<!doctype html><title>BTC/USD</title>
<body style="margin:0;font-family:sans-serif">
<h1>BTC/USD, 1 hour</h1>
<p>Last price: <b>64,210</b></p>
<canvas id="chart" width="800" height="300"></canvas>
<script>
  const g = chart.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, 800, 300);
  g.strokeStyle = "#0a0"; g.lineWidth = 3; g.beginPath();
  [260, 240, 250, 200, 210, 150, 160, 90, 110, 60].forEach((y, i) => (i === 0 ? g.moveTo(0, y) : g.lineTo(i * 88, y)));
  g.stroke();
</script>`;

// A tab whose first script keeps the renderer busy for longer than a clock probe may wait.
const busy = `<!doctype html><title>Busy</title><h1>Busy</h1>
<script>const started = Date.now(); while (Date.now() - started < 5000) {}</script>`;

const opensBusy = `<!doctype html><title>Opener</title><a href="/busy" target="_blank">Open a busy tab</a>`;

// A quote whose Refresh button changes its price and 24h change, the first by replacing the
// span's text node and the second by editing it, with a table, a feed and a hidden notice that
// tests change from the page's own script.
const quote = `<!doctype html><title>Quote</title>
<body style="margin:0;font-family:sans-serif">
<h1>Bitcoin</h1>
<p>Price <span id="price">$61,240</span></p>
<p>24h <span id="change">-1.4%</span></p>
<button id="refresh" onclick="price.textContent = '$62,010'; change.firstChild.nodeValue = '+0.3%'">Refresh</button>
<table><thead><tr><th>Coin</th><th>1h</th><th>24h</th></tr></thead>
<tbody><tr><td>Ether</td><td id="eth1h">0.2%</td><td id="eth24h">1.1%</td></tr></tbody></table>
<ul id="feed"><li>First post</li></ul>
<p id="notice" hidden>Saved</p>
<label>Search <input id="search"></label>
<div style="height:3000px"></div>
<p id="below">Below the fold</p>
</body>`;

const pages: Record<string, string> = {
  "/quote": quote,
  "/busy": busy,
  "/opens-busy": opensBusy,
  "/form": form,
  "/next": next,
  "/slots": slots,
  "/chart": chart,
};

export class Site extends Context.Service<Site, { readonly url: (path: string) => string }>()(
  "test/Site",
) {}

export const SiteLayer = Layer.effect(
  Site,
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.callback<ReturnType<typeof createServer>>((resume) => {
        const server = createServer((request, response) => {
          const page = pages[request.url ?? ""];

          response.writeHead(page === undefined ? 404 : 200, {
            "content-type": "text/html; charset=utf-8",
          });
          response.end(page ?? "<title>Not found</title>");
        });

        server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
      }),
      (server) => Effect.callback<void>((resume) => void server.close(() => resume(Effect.void))),
    );

    const { port } = server.address() as AddressInfo;

    return Site.of({ url: (path) => `http://127.0.0.1:${port}${path}` });
  }),
);
