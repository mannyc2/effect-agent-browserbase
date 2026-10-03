import { createServer } from "node:http";

import { Effect, Schema } from "effect";

export class StageError extends Schema.TaggedError<StageError>()("StageError", {
  operation: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

export const animationMarkup = `<style>body{margin:0;background:#14243b;color:#fff;font:24px sans-serif}#ticker{position:absolute;top:30px;animation:slide 2s linear infinite alternate}@keyframes slide{from{left:30px}to{left:900px}}canvas{width:1280px;height:620px}</style><canvas id="stage" width="1280" height="620"></canvas><div id="ticker">Watched browsing</div>`;
export const animationScript = `const canvas=document.querySelector('#stage'); const ctx=canvas.getContext('2d'); let ticks=0; let last=0; const paint=t=>{ ticks++; ctx.fillStyle='#14243b';ctx.fillRect(0,0,1280,620);ctx.fillStyle='#4fc1ff';ctx.fillRect((t/4)%1100,130,180,180);ctx.fillStyle='#fff';ctx.font='32px sans-serif';ctx.fillText('Animation '+ticks,40,520);if(t-last>200){last=t;report({kind:'animation',ticks,changing:true,visibility:document.visibilityState});}requestAnimationFrame(paint);};requestAnimationFrame(paint);document.addEventListener('visibilitychange',()=>report({kind:'visibility',visibility:document.visibilityState}));`;

export const TruthEvent = Schema.Struct({
  kind: Schema.NonEmptyString,
  route: Schema.String,
  at: Schema.Finite,
  data: Schema.Json,
});

export type TruthEvent = typeof TruthEvent.Type;

const content = (markup: string, script: string) => ({ markup, script });

const html = (body: string, script: string) =>
  `<!doctype html><meta charset=utf-8><title>Watched browsing stage</title>${body}<script>const report=data=>{void fetch('/truth',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({route:location.pathname,data})});};${script}</script>`;

export const stageContent = (route: string, delayMillis = 500) => {
  if (route === "/animation" || route === "/smoke")
    return { markup: animationMarkup, script: animationScript };
  if (route === "/heavy")
    return content(
      `<h1>Reading room</h1><button id="next">Next</button><input id="search" aria-label="Search"><button id="finish">Finish</button><main id="entries"></main>`,
      `document.querySelector('#entries').innerHTML=Array.from({length:19900},(_,i)=>'<p>Entry '+i+': independent background reading.</p>').join('');document.querySelector('#next').onclick=()=>report({kind:'next'});document.querySelector('#finish').onclick=()=>report({kind:'finish'});`,
    );
  if (route === "/typing")
    return content(
      '<h1>Search</h1><input id="search" aria-label="Search">',
      `for(const kind of ['keydown','keyup','input'])document.addEventListener(kind,event=>report({kind,key:event.key??'',value:document.querySelector('#search').value,pageAt:performance.now()}));`,
    );
  if (route === "/slow")
    return content(
      '<style>body{margin:0}</style><main id="content" hidden><h1>Page ready</h1></main>',
      `report({kind:'blank',shown:true});setTimeout(()=>{document.querySelector('#content').hidden=false;report({kind:'blank',shown:false});},${delayMillis});`,
    );
  if (route === "/blocked")
    return content(
      "<h1>Access unavailable</h1><p>Fixture access wall</p>",
      "report({kind:'blocked',shown:true});",
    );
  if (route === "/cookies" || route === "/newsletter" || route === "/age") {
    const label =
      route === "/cookies"
        ? "Accept cookies"
        : route === "/age"
          ? "I am 18 or older"
          : "Dismiss newsletter";

    return content(
      `<h1>Page content</h1><section id="overlay" style="position:fixed;inset:0;background:#ddd;padding:80px"><h2>${label}</h2><button id="dismiss">${label}</button></section>`,
      `report({kind:'overlay',shown:true});document.querySelector('#dismiss').onclick=()=>{document.querySelector('#overlay').remove();report({kind:'overlay',shown:false});};`,
    );
  }

  return content("<h1>Stage</h1>", "");
};

export const stagePage = (route: string, delayMillis = 500) => {
  const page = stageContent(route, delayMillis);

  return html(page.markup, page.script);
};

/** Loopback truth is host-owned and bounded; pages report only synthetic fixture events. */
export const stageSite = Effect.acquireRelease(
  Effect.tryPromise({
    try: async () => {
      const events: TruthEvent[] = [];
      let lost = 0;
      const started = performance.now();

      const server = createServer((request, response) => {
        const url = new URL(request.url ?? "/", "http://stage.test");

        if (url.pathname === "/truth" && request.method === "POST") {
          const chunks: Buffer[] = [];
          let size = 0;

          request.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size <= 16384) chunks.push(chunk);
            else request.destroy();
          });
          request.on("end", () => {
            const decoded = Schema.decodeExit(
              Schema.fromJsonString(Schema.Struct({ route: Schema.String, data: Schema.Json })),
            )(Buffer.concat(chunks).toString("utf8"));

            if (decoded._tag === "Success") {
              if (events.length < 20000)
                events.push({
                  kind: "page",
                  route: decoded.value.route,
                  at: performance.now() - started,
                  data: decoded.value.data,
                });
              else lost++;
              response.writeHead(204);
              response.end();
            } else {
              response.writeHead(400);
              response.end();
            }
          });

          return;
        }
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(stagePage(url.pathname, Number(url.searchParams.get("delay") ?? 500)));
      });

      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();

      if (address === null || typeof address === "string") throw new Error("Stage port missing");

      return {
        url: `http://127.0.0.1:${address.port}`,
        events: () => [...events],
        lost: () => lost,
        elapsedMillis: () => performance.now() - started,
        close: async () => {
          server.closeAllConnections();
          await new Promise<void>((resolve) => {
            server.close(() => resolve());
          });
        },
      };
    },
    catch: (cause) => new StageError({ operation: "start", cause }),
  }),
  (site) => Effect.promise(site.close),
);
