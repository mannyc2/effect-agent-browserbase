// Pages for the tests, served from loopback, and a model that answers from a script: an order form
// with a confirm dialog, a link to a new tab and an outcome that changes late, a next page, and a
// canvas slot machine with no DOM controls at all, so only point input can play it.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { Context, Effect, Layer, Stream } from "effect";
import { LanguageModel, Model, type Prompt, type Response } from "effect/ai";

const form = `<!doctype html><title>Order</title>
<body style="margin:0;font-family:sans-serif">
<nav aria-label="Main"><a href="/next">Next page</a> <a href="/next" target="_blank">Open in a new tab</a></nav>
<main>
  <h1>Place an order</h1>
  <label>Amount <input id="amount" value="10"></label>
  <label>Coin <select id="coin"><option value="btc">Bitcoin</option><option value="eth">Ethereum</option><option value="sol">Solana</option></select></label>
  <button id="submit" onclick="outcome.textContent = 'Ordered ' + amount.value + ' ' + coin.value">Submit</button>
  <button id="cancel" onclick="outcome.textContent = confirm('Cancel the order?') ? 'Cancelled' : 'Kept'">Cancel</button>
  <button id="later" onclick="setTimeout(() => (outcome.textContent = 'Shipped'), 300)">Ship later</button>
  <p id="outcome">Not ordered</p>
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

const pages: Record<string, string> = { "/form": form, "/next": next, "/slots": slots };

export class Site extends Context.Service<Site, { readonly url: (path: string) => string }>()(
  "effect-agent-browser/test/Site",
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

/** One model response, from the prompt it was given. */
export type Turn = (prompt: Prompt.Prompt) => ReadonlyArray<Response.StreamPartEncoded>;

let calls = 0;

/** A tool call in a scripted response. */
export const call = (name: string, params: unknown): Response.StreamPartEncoded => {
  calls += 1;

  return { type: "tool-call", id: `call-${calls}`, name, params };
};

/** A final answer: the text, and the response's end. */
export const answer = (text: string): ReadonlyArray<Response.StreamPartEncoded> => [
  { type: "text-start", id: "answer" },
  { type: "text-delta", id: "answer", delta: text },
  { type: "text-end", id: "answer" },
  finish("stop"),
];

export const finish = (reason: "stop" | "tool-calls"): Response.StreamPartEncoded => ({
  type: "finish",
  reason,
  usage: { inputTokens: { total: 900 }, outputTokens: { total: 40 } },
});

/** Tool calls, then the response's end. */
export const calling = (
  ...calls: ReadonlyArray<Response.StreamPartEncoded>
): ReadonlyArray<Response.StreamPartEncoded> => [...calls, finish("tool-calls")];

/**
 * A model that answers each request with the next turn of its script, and keeps the prompts it was
 * given. Its provider and model names are the runtime's model services.
 */
export const scripted = (turns: ReadonlyArray<Turn>) => {
  const prompts: Array<Prompt.Prompt> = [];

  const model = LanguageModel.make({
    generateText: () => Effect.die("the runtime streams"),
    streamText: (options) =>
      Stream.suspend(() => {
        const turn = turns[prompts.length];

        prompts.push(options.prompt);

        return turn === undefined
          ? Stream.die(`no turn ${prompts.length} in the script`)
          : Stream.fromIterable(turn(options.prompt));
      }),
  });

  return {
    layer: Model.make("scripted", "test-model", Layer.effect(LanguageModel.LanguageModel, model)),
    prompts,
  };
};

/** The text of a prompt's messages, tool results included, as JSON where they are not text. */
export const textOf = (prompt: Prompt.Prompt) =>
  prompt.content
    .flatMap((message) =>
      message.role === "system"
        ? [message.content]
        : message.content.map((part) =>
            part.type === "text"
              ? part.text
              : part.type === "tool-result"
                ? JSON.stringify(part.result)
                : `[${part.type}]`,
          ),
    )
    .join("\n");

/** The newest ref for this role and name in the prompt's observations. */
export const refIn = (prompt: Prompt.Prompt, role: string, name: string): string =>
  [
    ...textOf(prompt).matchAll(
      new RegExp(`${role} \\\\"${name}\\\\"[^\\n]*?\\[ref=(e\\d+)\\]`, "g"),
    ),
  ].at(-1)?.[1] ?? "missing";
