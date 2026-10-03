import { createServer } from "node:http";

import { Effect, Schema } from "effect";

export const operators = [
  "reorder",
  "shift",
  "slow",
  "overlay",
  "rename",
  "duplicate",
  "offscreen",
  "redirect",
  "variant",
] as const;

export type DriftOperator = (typeof operators)[number];

/** Seeds for fixed layouts are fresh-page repetitions, not distinct fixture conditions. */
export const driftCondition = (operator: DriftOperator, seed: number) =>
  operator === "reorder"
    ? `${operator}:permutation-${Math.abs(seed - 1) % 5}`
    : operator === "slow"
      ? `${operator}:delay-${1000 + (Math.abs(seed * 389) % 2001)}`
      : operator;

export interface DriftTruth {
  readonly page: string;
  readonly tab: string;
  readonly item: string;
  readonly query: string;
}

export interface DriftVisit {
  readonly run: string;
  readonly truth: DriftTruth;
}

export class DriftError extends Schema.TaggedError<DriftError>()("DriftError", {
  operation: Schema.String,
}) {}

const Visit = Schema.Struct({
  run: Schema.String,
  truth: Schema.Struct({
    page: Schema.String,
    tab: Schema.String,
    item: Schema.String,
    query: Schema.String,
  }),
});

export const driftMarkup = (operator: DriftOperator | "none", seed: number, run: string) => {
  const permutations = [
    ["Beta", "Gamma", "Alpha"],
    ["Gamma", "Beta", "Alpha"],
    ["Gamma", "Alpha", "Beta"],
    ["Alpha", "Gamma", "Beta"],
    ["Beta", "Alpha", "Gamma"],
  ];

  const items =
    operator === "reorder"
      ? (permutations[Math.abs(seed - 1) % permutations.length] ?? permutations[0])
      : ["Alpha", "Beta", "Gamma"];

  const label = operator === "rename" ? "Market data" : "Markets";
  const market = `<a href="/markets" data-page="markets">${label}</a>`;
  const decoy = '<a href="/decoy" data-page="decoy">Archived markets</a>';
  const nav = `<nav>${operator === "reorder" || operator === "variant" ? decoy : ""}${market}${operator === "duplicate" ? '<a href="/decoy" data-page="decoy">Markets</a>' : ""}<a href="/directory" data-page="directory">Directory</a><a href="/articles" data-page="articles">Articles</a></nav>`;
  const config = JSON.stringify({ operator, seed, run, items });

  return `<!doctype html><meta charset="utf-8"><title>Replay portal</title>
<style>body{font:18px sans-serif;margin:20px}a,button,input{margin:10px;padding:8px}nav{display:flex;gap:16px}#banner{height:150px;background:#eef}#overlay{position:fixed;inset:0;z-index:99;background:#ddd;padding:80px}table{border-spacing:12px}#spacer{height:1200px}.variant{display:grid;grid-template-columns:1fr 1fr}main{min-height:450px}</style>
${operator === "shift" ? `<div id="banner">New announcement${decoy}</div>` : ""}
${operator === "offscreen" ? '<div id="spacer"></div>' : ""}${nav}
<main ${operator === "variant" ? 'class="variant"' : ""}></main>
${operator === "overlay" ? '<section id="overlay"><h2>Newsletter</h2><button id="dismiss">Dismiss newsletter</button></section>' : ""}
<script>const config=${config};const truth={page:'portal',tab:'Overview',item:'',query:''};
const report=()=>fetch('/truth',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({run:config.run,truth})});
const main=document.querySelector('main');
const render=()=>{main.innerHTML='<h1>'+truth.page+'</h1><div role="tablist">'+['Overview','Prices','Research'].map(tab=>'<button role="tab" data-tab="'+tab+'">'+tab+'</button>').join('')+'</div><ul>'+config.items.map(item=>'<li><a href="/article/'+item.toLowerCase()+'" data-item="'+item+'">'+item+' article</a></li>').join('')+'</ul><table><tbody>'+config.items.map(item=>'<tr><td>'+item+'</td><td><button data-item="'+item+'">Open '+item+'</button></td></tr>').join('')+'</tbody></table><form><input aria-label="Search query"><button type="submit">Search</button></form><button data-next="true">Next page</button><button data-ready="true">Ready</button>';};
render();void report();
document.addEventListener('click',event=>{const target=event.target.closest('a,button');if(!target)return;if(target.id==='dismiss'){document.querySelector('#overlay').remove();void report();return;}if(target.dataset.page){event.preventDefault();truth.page=target.dataset.page;truth.item='';history.pushState({},'',target.href);render();void report();}else if(target.dataset.tab){truth.tab=target.dataset.tab;void report();}else if(target.dataset.item){event.preventDefault();truth.page='article';truth.item=target.dataset.item;history.pushState({},'', '/article/'+truth.item.toLowerCase());render();void report();}else if(target.dataset.next){truth.page='directory-2';render();void report();}});
document.addEventListener('submit',event=>{event.preventDefault();truth.query=event.target.querySelector('input').value;truth.page='search';render();void report();});
</script>`;
};

export interface DriftSite {
  readonly url: string;
  readonly configure: (operator: DriftOperator | "none", seed: number, run: string) => void;
  readonly truth: (run: string) => DriftTruth | undefined;
  readonly events: () => ReadonlyArray<DriftVisit>;
  readonly lost: () => number;
  readonly close: () => Promise<void>;
}

/** Only controlled fixture events update the independent host ledger; replay receipts cannot. */
export const driftSite = Effect.acquireRelease(
  Effect.tryPromise({
    try: async (): Promise<DriftSite> => {
      let active: { operator: DriftOperator | "none"; seed: number; run: string } = {
        operator: "none",
        seed: 0,
        run: "initial",
      };

      const events: DriftVisit[] = [];
      const latest = new Map<string, DriftTruth>();
      let lost = 0;
      const timers = new Set<ReturnType<typeof setTimeout>>();

      const server = createServer((request, response) => {
        const url = new URL(request.url ?? "/", "http://drift.test");

        if (url.pathname === "/truth" && request.method === "POST") {
          const chunks: Buffer[] = [];
          let size = 0;

          request.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size <= 4096) chunks.push(chunk);
            else request.destroy();
          });
          request.on("end", () => {
            const decoded = Schema.decodeExit(Schema.fromJsonString(Visit))(
              Buffer.concat(chunks).toString("utf8"),
            );

            if (decoded._tag === "Failure") {
              response.writeHead(400);
              response.end();

              return;
            }
            if (events.length < 20000) {
              events.push(decoded.value);
              latest.set(decoded.value.run, decoded.value.truth);
            } else lost++;
            response.writeHead(204);
            response.end();
          });

          return;
        }
        const selected = { ...active };

        if (selected.operator === "redirect" && url.pathname === "/portal") {
          response.writeHead(301, { location: "/new-portal", "cache-control": "no-store" });
          response.end();

          return;
        }

        const send = () => {
          response.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          });
          response.end(driftMarkup(selected.operator, selected.seed, selected.run));
        };

        if (selected.operator === "slow") {
          const timer = setTimeout(
            () => {
              timers.delete(timer);
              if (!response.destroyed) send();
            },
            1000 + (Math.abs(selected.seed * 389) % 2001),
          );

          timers.add(timer);
        } else send();
      });

      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();

      if (address === null || typeof address === "string") throw new Error("Drift port missing");

      return {
        url: `http://127.0.0.1:${address.port}`,
        configure: (operator, seed, run) => {
          active = { operator, seed, run };
        },
        truth: (run) => latest.get(run),
        events: () => [...events],
        lost: () => lost,
        close: async () => {
          for (const timer of timers) clearTimeout(timer);
          server.closeAllConnections();
          await new Promise<void>((resolve) => {
            server.close(() => resolve());
          });
        },
      };
    },
    catch: () => new DriftError({ operation: "start" }),
  }),
  (site) => Effect.promise(site.close),
);
