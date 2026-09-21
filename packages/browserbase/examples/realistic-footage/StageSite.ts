import { createServer } from "node:http";

import { NodeHttpServer } from "@effect/platform-node";
import { Context, Effect, Layer } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";

/**
 * A small fictional product to film: a sleeper-train finder with a live
 * search, a second document behind a link, a long page and a booking button.
 *
 * It is served from loopback so the example needs no network and films the
 * same pixels every run. A hosted browser cannot reach loopback; point the
 * storyboard at a public origin there instead.
 */

interface Route {
  readonly slug: string;
  readonly from: string;
  readonly to: string;
  readonly departs: string;
  readonly arrives: string;
  readonly hours: string;
  readonly fare: number;
  readonly stops: ReadonlyArray<readonly [time: string, station: string, note: string]>;
}

const routes: ReadonlyArray<Route> = [
  {
    slug: "vienna-venice",
    from: "Vienna",
    to: "Venice",
    departs: "21:27",
    arrives: "08:24",
    hours: "10 h 57",
    fare: 59,
    stops: [
      ["21:27", "Wien Hauptbahnhof", "Boarding from 21:00, platform 8"],
      ["22:02", "Wiener Neustadt", "Last stop before the Semmering pass"],
      ["23:41", "Bruck an der Mur", "Berths are made up after this stop"],
      ["00:58", "Klagenfurt", "Crew change, eleven minutes"],
      ["01:36", "Villach", "Carriages from Munich join the train"],
      ["03:10", "Tarvisio Boscoverde", "Border. No passport check on board"],
      ["04:42", "Udine", "First light in summer"],
      ["06:50", "Treviso Centrale", "Breakfast is served from here"],
      ["07:56", "Venezia Mestre", "Change here for the mainland"],
      ["08:24", "Venezia Santa Lucia", "The station opens onto the Grand Canal"],
    ],
  },
  ...(
    [
      ["munich-venice", "Munich", "Venice", "23:20", "08:24", "9 h 04", 64],
      ["zurich-prague", "Zurich", "Prague", "19:59", "09:27", "13 h 28", 72],
      ["brussels-berlin", "Brussels", "Berlin", "19:22", "06:48", "11 h 26", 79],
      ["paris-vienna", "Paris", "Vienna", "19:58", "10:12", "14 h 14", 89],
      ["hamburg-stockholm", "Hamburg", "Stockholm", "21:55", "09:55", "12 h 00", 69],
      ["budapest-krakow", "Budapest", "Kraków", "20:40", "07:03", "10 h 23", 45],
      ["milan-palermo", "Milan", "Palermo", "20:10", "16:35", "20 h 25", 95],
    ] as const
  ).map(([slug, from, to, departs, arrives, hours, fare]) => ({
    slug,
    from,
    to,
    departs,
    arrives,
    hours,
    fare,
    stops: [],
  })),
];

const styles = `
:root{--ink:#11140f;--paper:#f7f7f4;--night:#14213d;--signal:#ff5a1f;--rule:#d9d9d2;--quiet:#6b6f66}
*{box-sizing:border-box}
html{scroll-padding-top:80px}
body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 Inter,"Helvetica Neue","Liberation Sans",Arial,sans-serif}
.mono{font-family:"JetBrains Mono","DejaVu Sans Mono",monospace;font-variant-numeric:tabular-nums}
a{color:inherit}
header{position:sticky;top:0;z-index:5;background:var(--night);color:#fff}
header div{display:flex;align-items:center;gap:32px;max-width:980px;margin:0 auto;padding:16px 48px}
header strong{font-size:15px;letter-spacing:.18em}
header strong i{color:var(--signal);font-style:normal}
header nav{display:flex;gap:24px;margin-left:auto;font-size:14px}
header nav a{opacity:.72;text-decoration:none}
.hero{background:var(--night);color:#fff}
.hero div{max-width:980px;margin:0 auto;padding:56px 48px 64px}
.hero h1{margin:0 0 8px;font-size:64px;line-height:1;letter-spacing:-.035em}
.hero p{margin:0 0 32px;max-width:520px;color:#b9c0d4;font-size:18px}
.search{display:flex;align-items:center;gap:12px;max-width:620px;padding:6px 6px 6px 20px;background:#fff;border-radius:6px}
.search input{flex:1;padding:14px 0;border:0;outline:0;background:none;color:var(--ink);font:inherit;font-size:19px}
.search span{padding:10px 14px;border-radius:4px;background:var(--paper);color:var(--quiet);font-size:13px}
main{max-width:980px;margin:0 auto;padding:40px 48px 96px}
.count{margin:0 0 12px;color:var(--quiet);font-size:13px;letter-spacing:.08em;text-transform:uppercase}
.route{display:grid;grid-template-columns:1.6fr 1fr 1fr auto;align-items:center;gap:24px;padding:22px 8px;border-top:1px solid var(--rule);text-decoration:none;cursor:pointer;transition:background .15s,opacity .25s,transform .25s}
.route:hover{background:#fff}
.route[hidden]{display:none}
.route h2{margin:0;font-size:24px;letter-spacing:-.02em}
.route h2 b{color:var(--signal);font-weight:inherit}
.route small{display:block;color:var(--quiet);font-size:13px}
.route .fare{font-size:20px;font-weight:600}
.crumb{display:inline-block;margin-bottom:24px;color:var(--quiet);font-size:14px}
.title{margin:0;font-size:56px;line-height:1.02;letter-spacing:-.035em}
.facts{display:flex;gap:40px;margin:24px 0 56px;padding:20px 0;border-block:1px solid var(--rule)}
.facts div small{display:block;color:var(--quiet);font-size:12px;letter-spacing:.08em;text-transform:uppercase}
.facts div span{font-size:22px}
h3{margin:0 0 20px;font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:var(--quiet)}
.stops{margin:0 0 64px;padding:0;list-style:none}
.stops li{display:grid;grid-template-columns:84px 28px 1fr;padding:0 0 34px}
.stops li i{position:relative;justify-self:center;width:12px;height:12px;margin-top:6px;border:3px solid var(--night);border-radius:50%;background:var(--paper)}
.stops li:not(:last-child) i::after{content:"";position:absolute;left:3px;top:12px;width:0;height:58px;border-left:2px solid var(--night)}
.stops li:last-child i{background:var(--signal);border-color:var(--signal)}
.stops li b{display:block;font-size:19px}
.stops li small{color:var(--quiet)}
.berths{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:32px}
.berth{padding:20px;border:1.5px solid var(--rule);border-radius:6px;background:#fff;color:inherit;font:inherit;text-align:left;cursor:pointer;transition:border-color .15s,box-shadow .15s}
.berth b{display:block;font-size:18px}
.berth small{color:var(--quiet)}
.berth[aria-pressed=true]{border-color:var(--ink);box-shadow:inset 0 0 0 1.5px var(--ink)}
.berth .mono{display:block;margin-top:14px;font-size:20px}
#hold{padding:16px 28px;border:0;border-radius:6px;background:var(--signal);color:#fff;font:inherit;font-size:17px;font-weight:600;cursor:pointer;transition:filter .15s,transform .08s}
#hold:active{transform:scale(.98)}
#hold[disabled]{filter:grayscale(1);opacity:.6}
#held{display:flex;gap:16px;align-items:center;max-height:0;margin-top:0;padding:0 22px;overflow:hidden;border-radius:6px;background:var(--night);color:#fff;opacity:0;transition:max-height .35s ease,opacity .35s ease,margin-top .35s ease,padding .35s ease}
#held[data-shown]{max-height:120px;margin-top:24px;padding:20px 22px;opacity:1}
#held b{font-size:18px}
#held small{display:block;color:#b9c0d4}
`;

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title} · Night Rail Atlas</title><style>${styles}</style>
<header><div><strong>NIGHT RAIL <i>ATLAS</i></strong><nav><a href="/">Routes</a><a href="/">Rolling stock</a><a href="/">Journal</a></nav></div></header>${body}</html>`;

const index = page(
  "Routes",
  `<section class="hero"><div><h1>Sleep through<br>the border.</h1><p>Eight sleeper routes, one timetable. Board after dinner, wake up somewhere else.</p>
<label class="search"><input id="destination" autocomplete="off" spellcheck="false" placeholder="Where do you want to wake up?"><span>Arrival city</span></label></div></section>
<main><p class="count" id="count"></p>${routes
    .map(
      (route) =>
        `<a class="route" href="/routes/${route.slug}" data-to="${route.to.toLowerCase()}"><h2>${route.from} <b>→</b> ${route.to}</h2><div class="mono">${route.departs} – ${route.arrives}<small>${route.hours}</small></div><small>Nightly</small><div class="fare mono">from €${String(route.fare)}</div></a>`,
    )
    .join("")}</main>
<script>
const cards = [...document.querySelectorAll(".route")];
const show = () => {
  const wanted = destination.value.trim().toLowerCase();
  let shown = 0;
  for (const card of cards) shown += Number(!(card.hidden = !card.dataset.to.startsWith(wanted)));
  count.textContent = shown + (shown === 1 ? " route" : " routes") + (wanted ? " arriving in “" + destination.value.trim() + "”" : "");
};
destination.addEventListener("input", show);
show();
</script>`,
);

const detail = (route: Route) =>
  page(
    `${route.from} to ${route.to}`,
    `<main><a class="crumb" href="/">← All routes</a><h1 class="title">${route.from} → ${route.to}</h1>
<div class="facts"><div><small>Departs</small><span class="mono">${route.departs}</span></div><div><small>Arrives</small><span class="mono">${route.arrives}</span></div><div><small>On board</small><span class="mono">${route.hours}</span></div><div><small>Runs</small><span>Nightly</span></div></div>
<h3>Stops</h3><ol class="stops" id="stops">${route.stops
      .map(
        ([time, station, note]) =>
          `<li><span class="mono">${time}</span><i></i><div><b>${station}</b><small>${note}</small></div></li>`,
      )
      .join("")}</ol>
<h3>Choose a berth</h3><div class="berths">${(
      [
        ["seat", "Reclining seat", "Six to a compartment", 0],
        ["couchette", "Couchette", "Four bunks, bedding included", 40],
        ["sleeper", "Private sleeper", "Your own cabin and washbasin", 110],
      ] as const
    )
      .map(
        ([kind, name, blurb, extra]) =>
          `<button class="berth" data-kind="${kind}" aria-pressed="false"><b>${name}</b><small>${blurb}</small><span class="mono">€${String(route.fare + extra)}</span></button>`,
      )
      .join("")}</div>
<button id="hold" disabled>Hold this berth</button>
<div id="held" role="status"><div><b>Held for twenty minutes.</b><small>Reference <span class="mono">NRA-4821</span>. Nothing is charged until you confirm.</small></div></div></main>
<script>
for (const berth of document.querySelectorAll(".berth")) berth.addEventListener("click", () => {
  for (const other of document.querySelectorAll(".berth")) other.setAttribute("aria-pressed", String(other === berth));
  hold.disabled = false;
});
hold.addEventListener("click", () => { hold.disabled = true; hold.textContent = "Held"; held.toggleAttribute("data-shown", true); });
</script>`,
  );

const Routes = Layer.mergeAll(
  HttpRouter.add("GET", "/", HttpServerResponse.html(index)),
  ...routes.map((route) =>
    HttpRouter.add("GET", `/routes/${route.slug}`, HttpServerResponse.html(detail(route))),
  ),
);

export class StageSite extends Context.Service<
  StageSite,
  {
    /** The exact origin to film, and to allow the stagehand on. */
    readonly origin: string;
  }
>()("effect-browserbase/examples/realistic-footage/StageSite") {
  static readonly layer = Layer.effect(
    StageSite,
    Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer;

      return StageSite.of({ origin: HttpServer.formatAddress(server.address) });
    }),
  ).pipe(
    // Layers are shared by identity: without `fresh`, a second server in the same program
    // would be handed this router and its routes.
    Layer.provideMerge(
      Layer.fresh(HttpRouter.serve(Routes, { disableLogger: true, disableListenLog: true })),
    ),
    Layer.provide(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
  );
}
