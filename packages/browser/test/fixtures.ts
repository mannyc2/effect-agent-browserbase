// Pages for the tests, served from loopback: an order form, a canvas slot machine, a canvas
// price chart, a price table, a long page with pinned parts, an account form, and a red page that
// keeps painting beside a blue one the server answers late. The slot machine has no DOM controls
// at all, so only point input can play it.
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

// The third row's first cell spans two columns, so its button is still under "Trade".
const ticker = `<!doctype html><title>Ticker</title>
<body style="margin:0;font-family:sans-serif">
<h1>Prices</h1>
<table>
  <thead><tr><th>Coin</th><th>Price</th><th>1h</th><th>24h</th><th>Trade</th></tr></thead>
  <tbody>
    <tr><td>BTC</td><td>$64,210</td><td>+0.4%</td><td>-1.2%</td><td><button onclick="bought.textContent = 'Bought BTC'"><span>Buy</span></button></td></tr>
    <tr><td>ETH</td><td>$3,105</td><td>-0.8%</td><td>+2.5%</td><td><button onclick="bought.textContent = 'Bought ETH'">Buy</button></td></tr>
    <tr><td colspan="2">SOL, paused</td><td>+1.1%</td><td>+0.3%</td><td><button disabled>Buy</button></td></tr>
  </tbody>
</table>
<p id="bought">Nothing bought</p>
<div>Ordered <b>25</b> eth</div>`;

// Pinned parts whose containers lie outside the viewport once it scrolls to the middle: a bar in
// a header, a banner in a footer, a dialog in an empty wrapper at the end, and a popover in the
// top layer, away from every point the walk tests.
const pinned = `<!doctype html><title>Pinned</title>
<body style="margin:0;font-family:sans-serif">
<header style="height:64px"><nav style="position:fixed;top:0;left:0;right:0;height:48px;background:#fff"><a href="/next">Sign in</a></nav></header>
<main>
  <h1>A long read</h1>
  <p>The top of the story</p>
  <div style="height:3000px"></div>
  <p id="middle">The middle of the story</p>
  <div style="height:3000px"></div>
  <p>Notes <span popover id="saved" style="inset:auto;top:300px;left:100px;margin:0">Saved</span></p>
  <script>saved.showPopover()</script>
  <button>At the bottom</button>
</main>
<footer><div style="position:fixed;bottom:0;left:0;right:0;height:40px;background:#eee">Cookies help <button>Accept</button></div></footer>
<div><div role="dialog" aria-label="Offer" style="position:fixed;top:200px;left:300px;width:300px;height:100px;background:#fff">Half price today</div></div>`;

const account = `<!doctype html><title>Account</title>
<body style="margin:0;font-family:sans-serif">
<h1>Account</h1>
<form onsubmit="return false">
  <label>Email <input id="email" value="ada@example.com"></label>
  <label>Password <input id="password" type="password"></label>
  <label>Code <input id="code" autocomplete="one-time-code" value="424242"></label>
  <label>Note <textarea id="note">Ring twice</textarea></label>
  <label>Country <select id="country"><option>Norway</option><option selected>Chile</option></select></label>
  <div id="bio" contenteditable="true">Likes chess</div>
  <button type="button" onclick="password.type = password.type === 'password' ? 'text' : 'password'">Show password</button>
  <input type="submit" value="Save">
</form>
<table><tr><th>Plan</th><th>Price</th></tr><tr><td>Pro</td><td>$9</td></tr></table>
<section role="region" aria-label="Story"><p>First part</p><div style="height:2000px"></div><p>Last part</p></section>`;

// Going from the first to the second, the first keeps painting until the second's document
// commits, 300 ms on, so its own frames are the newest when the navigation returns.
const spinning = `<!doctype html><title>Spinning</title>
<body style="margin:0;height:100vh;background:rgb(255,0,0)">
<div id="square" style="width:40px;height:40px;background:#000"></div>
<script>let turn = 0; (function spin() { square.style.rotate = turn++ * 6 + "deg"; requestAnimationFrame(spin); })();</script>`;

const late = `<!doctype html><title>Late</title><body style="margin:0;height:100vh;background:rgb(0,0,255)">`;

const pages: Record<string, string> = {
  "/spinning": spinning,
  "/late": late,
  "/ticker": ticker,
  "/pinned": pinned,
  "/account": account,
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

          const answer = () => {
            response.writeHead(page === undefined ? 404 : 200, {
              "content-type": "text/html; charset=utf-8",
            });
            response.end(page ?? "<title>Not found</title>");
          };

          if (request.url === "/late") setTimeout(answer, 300);
          else answer();
        });

        server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
      }),
      (server) => Effect.callback<void>((resume) => void server.close(() => resume(Effect.void))),
    );

    const { port } = server.address() as AddressInfo;

    return Site.of({ url: (path) => `http://127.0.0.1:${port}${path}` });
  }),
);
