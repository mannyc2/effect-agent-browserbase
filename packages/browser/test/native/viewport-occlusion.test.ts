import { createServer } from "node:http";

import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { BrowserPolicy, type Observation } from "effect-browser/browser-data";
import { Chromium } from "effect-browser/chromium";

import { externalChromium } from "../fixtures/StandaloneBrowser.ts";

// Issue #79: something that takes no pointer events hides nothing by being there. Only a box
// that paints over the text does, including one the page cannot see inside a closed shadow root.

const head = (style = "") =>
  `<!doctype html><meta charset=utf-8><title>occlusion</title><style>body{margin:0;font:16px/20px monospace}.at{position:absolute;left:0;margin:0;white-space:nowrap}${style}</style>`;

const shadow = (mode: "open" | "closed", css: string) =>
  `<script>document.getElementById("host").attachShadow({mode:"${mode}"}).innerHTML='<div style="${css}"></div>'</script>`;

interface Case {
  readonly html: string;
  readonly read: ReadonlyArray<string>;
  readonly hidden: ReadonlyArray<string>;
  readonly controls?: ReadonlyArray<string>;
  readonly hiddenControls?: ReadonlyArray<string>;
  /** Hidden text the browser proved painted over, as opposed to merely unconfirmed. */
  readonly covered?: number;
}

const cases: Record<string, Case> = {
  // CoinGecko's shape: an empty, transparent, full-screen fixed container.
  "transparent-shell": {
    html: `${head()}
<p class=at style="top:0">market text under shell</p>
<a class=at style="top:40px" href="/coin">Shell link</a>
<button class=at style="top:80px">Shell button</button>
<div style="position:fixed;inset:0;width:100vw;height:100dvh;pointer-events:none;background-color:rgba(0,0,0,0);z-index:20000"></div>`,
    read: ["market text under shell"],
    hidden: [],
    controls: ["Shell link", "Shell button"],
  },
  "opaque-overlay": {
    html: `${head()}
<p class=at style="top:10px">slab hidden words</p>
<button class=at style="top:40px">Slab button</button>
<p class=at style="top:200px">clear words two</p>
<button class=at style="top:240px">Clear button</button>
<div style="position:fixed;top:0;left:0;width:640px;height:100px;background:#333;pointer-events:none;z-index:10"></div>`,
    read: ["clear words two"],
    hidden: ["slab hidden words"],
    covered: 1,
    controls: ["Clear button"],
    hiddenControls: ["Slab button"],
  },
  // A painted child, a pseudo-element on a zero-size host, a canvas and an SVG shape inside a
  // transparent shell: each hides what is under it, and nothing else.
  "painted-children": {
    html: `${head("#ph{position:absolute;top:100px;left:0;width:0;height:0}#ph::before{content:'';position:absolute;top:0;left:0;width:300px;height:30px;background:#444}")}
<p class=at style="top:5px">child hidden words</p>
<p class=at style="top:5px;left:400px">beside child words</p>
<p class=at style="top:105px">pseudo hidden words</p>
<p class=at style="top:205px">canvas hidden words</p>
<p class=at style="top:305px">svg hidden words</p>
<p class=at style="top:405px">clear shell words</p>
<button class=at style="top:440px">Shell three button</button>
<div style="position:fixed;inset:0;pointer-events:none;z-index:20000">
<div style="position:absolute;top:0;left:0;width:300px;height:30px;background:#222"></div>
<div id=ph></div>
<canvas id=cv width=300 height=30 style="position:absolute;top:200px;left:0"></canvas>
<svg style="position:absolute;top:300px;left:0" width=300 height=30><rect width=300 height=30 fill="#111"/></svg>
</div>
<script>{const c=document.getElementById("cv").getContext("2d");c.fillStyle="#000";c.fillRect(0,0,300,30)}</script>`,
    read: ["beside child words", "clear shell words"],
    hidden: [
      "child hidden words",
      "pseudo hidden words",
      "canvas hidden words",
      "svg hidden words",
    ],
    covered: 4,
    controls: ["Shell three button"],
  },
  // An opaque closed shadow root inside an empty transparent div: page script sees no root.
  "closed-shadow": {
    html: `${head()}
<p class=at style="top:5px">closed hidden words</p>
<p class=at style="top:205px">clear words four</p>
<div id=host style="position:absolute;top:0;left:0;width:300px;height:30px;pointer-events:none"></div>
${shadow("closed", "width:100%;height:100%;background:#555")}`,
    read: ["clear words four"],
    hidden: ["closed hidden words"],
    covered: 1,
  },
  "open-shadow-overlay": {
    html: `${head()}
<p class=at style="top:5px">zero host open words</p>
<p class=at style="top:205px">clear words six</p>
<div id=host></div>
${shadow("open", "position:fixed;top:0;left:0;width:300px;height:30px;background:#555;pointer-events:none;z-index:5")}`,
    read: ["clear words six"],
    hidden: ["zero host open words"],
    covered: 1,
  },
  "backdrop-blur": {
    html: `${head()}
<p class=at style="top:5px">blurred words</p>
<p class=at style="top:205px">clear words nine</p>
<div style="position:fixed;top:0;left:0;width:300px;height:30px;pointer-events:none;backdrop-filter:blur(6px);z-index:5"></div>`,
    read: ["clear words nine"],
    hidden: ["blurred words"],
    covered: 1,
  },
  "decoration-behind": {
    html: `${head()}
<div style="position:absolute;top:0;left:0;width:640px;height:200px;background:#eef;pointer-events:none;z-index:-1"></div>
<p class=at style="top:5px">hero words over decoration</p>
<button class=at style="top:60px">Hero button</button>`,
    read: ["hero words over decoration"],
    hidden: [],
    controls: ["Hero button"],
  },
  // The browser's hit test takes document coordinates: a scrolled page must still resolve.
  "scrolled-shell": {
    html: `${head()}
<div style="height:3000px"></div>
<p class=at style="top:520px">scrolled words</p>
<p class=at style="top:700px">scrolled slab words</p>
<div style="position:absolute;top:690px;left:0;width:300px;height:40px;background:#333;pointer-events:none;z-index:5"></div>
<div style="position:fixed;inset:0;pointer-events:none;z-index:20000"></div>
<script>scrollTo(0,500)</script>`,
    read: ["scrolled words"],
    hidden: ["scrolled slab words"],
  },
};

const site = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{ readonly origin: string; readonly close: () => void }>((resolve) => {
        const server = createServer((request, response) => {
          const name = new URL(request.url ?? "/", "http://127.0.0.1").pathname.slice(1);

          response.writeHead(200, { "content-type": "text/html" });
          // A shell over thousands of rows: the scan runs out of budget before the text does.
          response.end(
            name === "large"
              ? `${head()}${"<div><span>row</span></div>".repeat(12_000)}<p class=at style="top:0">first large words</p><div style="position:fixed;inset:0;pointer-events:none"></div>`
              : (cases[name]?.html ?? head()),
          );
        });

        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          const port = typeof address === "object" && address !== null ? address.port : 0;

          resolve({ origin: `http://127.0.0.1:${String(port)}`, close: () => server.close() });
        });
      }),
  ),
  (server) => Effect.sync(server.close),
);

const layer = Chromium.layer({}).pipe(Layer.provide(NodeCrypto.layer));

const labels = (observation: Observation) => observation.controls.map((control) => control.label);

it.live(
  "real CDP: a viewport reading keeps what a pass-through box leaves visible and drops what it paints over",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { origin } = yield* site;
        const host = yield* externalChromium;

        const session = yield* Chromium.attach(host.endpoint, {
          policy: BrowserPolicy.unrestricted({ maxActions: 100, maxElapsedMillis: 120_000 }),
        });

        // An attached browser keeps its own window; the fixtures are laid out for 640 x 480.
        yield* session.resizeViewport({ width: 640, height: 480 });

        for (const [name, expected] of Object.entries(cases)) {
          yield* session.navigate({ url: `${origin}/${name}` });
          const viewport = yield* session.observe({ scope: "viewport", maxControls: 32 });

          for (const phrase of expected.read)
            expect(viewport.text, `${name}: ${phrase}`).toContain(phrase);
          for (const phrase of expected.hidden)
            expect(viewport.text, `${name}: ${phrase}`).not.toContain(phrase);
          for (const label of expected.controls ?? [])
            expect(labels(viewport), `${name}: ${label}`).toContain(label);
          for (const label of expected.hiddenControls ?? [])
            expect(labels(viewport), `${name}: ${label}`).not.toContain(label);
          // Text a box really paints over is covered, not merely uncertain.
          expect(viewport.viewport.coveredText, name).toBeGreaterThanOrEqual(expected.covered ?? 0);
        }

        // A checkpoint reads the viewport the same way.
        yield* session.navigate({ url: `${origin}/transparent-shell` });
        expect((yield* session.checkpoint()).text).toContain("market text under shell");

        // An exhausted scan leaves every point to the browser rather than every point unread.
        yield* session.navigate({ url: `${origin}/large` });
        const large = yield* session.observe({ scope: "viewport" });

        expect(large.text).toContain("first large words");
        expect(large.viewport.exhausted).toBe(true);
      }).pipe(Effect.provide(layer)),
    ),
);
