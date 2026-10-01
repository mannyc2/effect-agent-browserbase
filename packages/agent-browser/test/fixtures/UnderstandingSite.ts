import { createServer } from "node:http";

import { Effect, Schema } from "effect";

class UnderstandingSiteError extends Schema.TaggedError<UnderstandingSiteError>()(
  "UnderstandingSiteError",
  { operation: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
) {}

/** Source values belong to the fixture; the grader never trusts an agent's account of them. */
export const chartFacts = Object.freeze({
  unit: "kWh",
  axisMinimum: 40,
  axisMaximum: 80,
  rows: Object.freeze([
    Object.freeze({ month: "January", Harbor: 54, Marsh: 48 }),
    Object.freeze({ month: "February", Harbor: 60, Marsh: 72 }),
    Object.freeze({ month: "March", Harbor: 66, Marsh: 56 }),
  ]),
});

/** Independently authored expected facts, never rendered into the page. */
export const chartExpected = Object.freeze({
  peakSeries: "Marsh",
  peakMonth: "February",
  peakValue: 72,
  greatestIncreaseSeries: "Marsh",
  greatestIncrease: 24,
  axisMinimum: 40,
  unit: "kWh",
});

/** The claim fields are host truth only; a post renders its ID, author and ordinary prose. */
export const feedPosts = Object.freeze([
  Object.freeze({
    id: "p01",
    author: "Harbor transport",
    text: "Harbor ferry departures remain hourly throughout Saturday.",
    claim: Object.freeze({
      topic: "ferry departures",
      value: "hourly on Saturday",
      corrects: null,
    }),
  }),
  Object.freeze({
    id: "p02",
    author: "Parks desk",
    text: "The River trail reopens at 09:00 on Saturday.",
    claim: Object.freeze({
      topic: "River trail reopening",
      value: "09:00 Saturday",
      corrects: null,
    }),
  }),
  Object.freeze({
    id: "p03",
    author: "Marsh watch",
    text: "Today's survey counted 18 herons beside the south hide.",
    claim: Object.freeze({ topic: "south hide herons", value: "18", corrects: null }),
  }),
  Object.freeze({
    id: "p04",
    author: "Cedar cafe",
    text: "Cedar cafe opens at 09:00 on Saturday for the breakfast menu.",
    claim: Object.freeze({ topic: "Cedar cafe opening", value: "09:00 Saturday", corrects: null }),
  }),
  Object.freeze({
    id: "p05",
    author: "Parks desk",
    text: "Correction to p02: the River trail reopens at 11:00 on Saturday, not 09:00.",
    claim: Object.freeze({
      topic: "River trail reopening",
      value: "11:00 Saturday",
      corrects: "p02",
    }),
  }),
  Object.freeze({
    id: "p06",
    author: "Library desk",
    text: "Library roof repairs finish on Monday; the reading room stays open.",
    claim: Object.freeze({ topic: "library roof repairs", value: "finish Monday", corrects: null }),
  }),
]);

const series = ["Harbor", "Marsh"] as const;
const baseline = 240;
const scale = 4.5;

const chartPage = `<!doctype html><meta charset="utf-8"><title>Observatory energy readings</title>
<style>
body { margin:24px; max-width:720px; font:18px/1.4 sans-serif; color:#17212d }
h1 { font-size:24px } svg { display:block; width:100%; max-width:560px; height:auto }
table { border-collapse:collapse } th,td { padding:8px 16px; border:1px solid #8995a2; text-align:left }
.harbor { color:#235fa8 } .marsh { color:#158059 }
</style>
<h1>Monthly observatory energy</h1>
<p>Energy consumed by two survey stations, in ${chartFacts.unit}.</p>
<p><span class="harbor">Blue: Harbor</span>. <span class="marsh">Green: Marsh</span>.</p>
<svg viewBox="0 0 560 300" role="img" aria-labelledby="chart-title chart-description">
  <title id="chart-title">Monthly energy consumed by Harbor and Marsh</title>
  <desc id="chart-description">Grouped bars show January, February and March readings. Source values are in the table below.</desc>
  ${[40, 50, 60, 70, 80]
    .map(
      (
        tick,
      ) => `<line x1="60" y1="${baseline - (tick - chartFacts.axisMinimum) * scale}" x2="540" y2="${baseline - (tick - chartFacts.axisMinimum) * scale}" stroke="#c4cbd3"/>
      <text x="48" y="${baseline - (tick - chartFacts.axisMinimum) * scale + 5}" text-anchor="end" font-size="14">${tick}</text>`,
    )
    .join("")}
  ${chartFacts.rows
    .map(
      (row, index) => `${series
        .map((name, column) => {
          const height = (row[name] - chartFacts.axisMinimum) * scale;

          return `<rect x="${95 + index * 150 + column * 42}" y="${baseline - height}" width="34" height="${height}" fill="${name === "Harbor" ? "#235fa8" : "#158059"}"/>`;
        })
        .join("")}
      <text x="${130 + index * 150}" y="270" text-anchor="middle" font-size="16">${row.month}</text>`,
    )
    .join("")}
</svg>
<p>Vertical axis: ${chartFacts.axisMinimum} to ${chartFacts.axisMaximum} ${chartFacts.unit}.</p>
<table><caption>Source readings (${chartFacts.unit})</caption>
  <thead><tr><th scope="col">Month</th><th scope="col">Harbor</th><th scope="col">Marsh</th></tr></thead>
  <tbody>${chartFacts.rows
    .map(
      (row) =>
        `<tr><th scope="row">${row.month}</th><td>${row.Harbor}</td><td>${row.Marsh}</td></tr>`,
    )
    .join("")}</tbody>
</table>`;

const feedPage = `<!doctype html><meta charset="utf-8"><title>Estuary community feed</title>
<style>
* { box-sizing:border-box } html { scroll-behavior:auto } body { margin:0; font:20px/1.4 sans-serif; color:#17212d }
header { position:absolute; top:16px; left:40px; z-index:1 } header h1 { margin:0; font-size:24px }
article { position:relative; height:1000px; margin:0; border-bottom:1px solid #8995a2; background:#f4f7fa }
article:nth-child(even) { background:#e8eef4 } .post { position:absolute; top:180px; left:40px; right:40px; max-width:560px }
.post h2 { margin:0 0 12px; font-size:18px } .post p { margin:0 }
</style>
<header><h1>Estuary community feed</h1></header>
<main>${feedPosts
  .map(
    (post) =>
      `<article id="${post.id}"><div class="post"><h2>Post ${post.id} · ${post.author}</h2><p>${post.text}</p></div></article>`,
  )
  .join("")}</main>`;

/** A fresh loopback fixture per scope; no timers, streaming replies or external resources. */
export const understandingSite = Effect.acquireRelease(
  Effect.tryPromise({
    try: async () => {
      const requests: string[] = [];
      let writes = 0;

      const server = createServer((request, response) => {
        const path = request.url ?? "/";

        if (requests.length < 128) requests.push(path.slice(0, 256));
        if (request.method === "POST") writes++;
        if (request.method !== "GET" && request.method !== "HEAD") {
          response.writeHead(405, { allow: "GET, HEAD" });
          response.end();

          return;
        }
        const body = path === "/chart" ? chartPage : path === "/feed" ? feedPage : undefined;

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
        throw new Error("No understanding site port");
      }

      return {
        url: `http://127.0.0.1:${address.port}/`,
        requests,
        get writes() {
          return writes;
        },
        close: async () => {
          server.closeAllConnections();
          await new Promise<void>((resolve) => {
            server.close(() => resolve());
          });
        },
      };
    },
    catch: (cause) => UnderstandingSiteError.make({ operation: "start understanding site", cause }),
  }),
  (site) => Effect.promise(site.close),
);
