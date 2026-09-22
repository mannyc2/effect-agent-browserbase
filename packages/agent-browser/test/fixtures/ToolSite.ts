import { createServer, type ServerResponse } from "node:http";

import { Effect, Schema } from "effect";

class ToolSiteError extends Schema.TaggedError<ToolSiteError>()("ToolSiteError", {
  operation: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

const page = `<!doctype html><meta charset="utf-8"><title>Tool composition</title>
<style>
body { margin:0; min-height:1600px; font:16px sans-serif }
p { margin:0 }
#visible { position:absolute; left:20px; top:10px }
#covered { position:absolute; left:20px; top:50px }
#cover { position:absolute; left:10px; top:45px; width:220px; height:30px; background:#333 }
#increment { position:absolute; left:20px; top:100px; width:150px; height:40px }
#name { position:absolute; left:20px; top:155px; width:180px }
#secret { position:absolute; left:20px; top:200px; width:180px }
#route { position:absolute; left:20px; top:250px }
#nested { position:absolute; left:350px; top:100px; width:220px; height:180px; overflow:auto }
#nested div { height:1000px; background:linear-gradient(#ccc,#777) }
#below { position:absolute; left:20px; top:1000px }
#log { position:absolute; top:1400px }
</style>
<p id="visible">VISIBLE WORDS</p><p id="covered">COVERED WORDS</p><div id="cover"></div>
<button id="increment">Increment</button>
<input id="name" aria-label="Name" autocomplete="username">
<input id="secret" aria-label="Secret" type="password" autocomplete="current-password">
<a id="route" href="/destination?token=PRIVATE-DESTINATION">Route</a>
<div id="nested"><div>Nested scroll target</div></div><p id="below">BELOW WORDS</p>
<pre id="log"></pre>
<script>
const state = { ready:false, mutation:0, clicks:0, fills:0, name:'', keys:[], moves:[], hovers:[], wheels:[], nested:0, page:0 };
const paint = () => document.querySelector('#log').textContent = JSON.stringify(state);
const button = document.querySelector('#increment');
button.addEventListener('click', () => { state.clicks++; paint(); });
button.addEventListener('pointerenter', event => { state.hovers.push(event.isTrusted); paint(); });
document.addEventListener('pointermove', event => { state.moves.push({ x:event.clientX, y:event.clientY, trusted:event.isTrusted }); paint(); });
document.addEventListener('input', event => { state.fills++; state.name = document.querySelector('#name').value; paint(); });
document.addEventListener('keydown', event => { state.keys.push({ key:event.key, trusted:event.isTrusted }); paint(); });
document.addEventListener('wheel', event => { state.wheels.push({ trusted:event.isTrusted, nested:document.querySelector('#nested').contains(event.target) }); paint(); });
document.querySelector('#nested').addEventListener('scroll', event => { state.nested=event.target.scrollTop; paint(); });
window.addEventListener('scroll', () => { state.page=scrollY; paint(); });
const events = new EventSource('/events');
events.addEventListener('open', () => { state.ready=true; paint(); });
events.addEventListener('message', event => {
  if (event.data === 'type') document.querySelector('#name').type = 'password';
  if (event.data === 'replace') button.replaceWith(button.cloneNode(true));
  if (event.data === 'destination') document.querySelector('#route').href = '/changed';
  state.mutation++; paint();
});
paint();
</script>`;

/** A controllable website, independent of the fixture's scripted provider and native owner. */
export const toolSite = Effect.acquireRelease(
  Effect.tryPromise({
    try: async () => {
      const events = new Set<ServerResponse>();
      const slow = new Set<ServerResponse>();
      const requests: string[] = [];

      const server = createServer((request, response) => {
        const path = request.url ?? "/";

        requests.push(path);
        if (path === "/events") {
          response.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
          });
          response.write(": ready\n\n");
          events.add(response);
          response.once("close", () => events.delete(response));
        } else if (path === "/slow") {
          response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          response.write(`<!doctype html><meta charset=utf-8><title>Still loading</title>
            <p>PARTIAL DOCUMENT</p><button id="act" onclick="this.textContent='clicked'">Act</button>`);
          slow.add(response);
          response.once("close", () => slow.delete(response));
        } else {
          response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          response.end(page);
        }
      });

      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();

      if (address === null || typeof address === "string") throw new Error("No tool site port");

      return {
        url: `http://127.0.0.1:${address.port}/`,
        requests,
        change: (change: "type" | "replace" | "destination") => {
          for (const response of events) response.write(`data: ${change}\n\n`);
        },
        complete: () => {
          for (const response of slow) response.end("<p>COMPLETE DOCUMENT</p>");
        },
        close: async () => {
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        },
      };
    },
    catch: (cause) => ToolSiteError.make({ operation: "start tool site", cause }),
  }),
  (site) => Effect.promise(site.close),
);

/** Wait for a native event/paint without assuming a wheel acknowledgement settled scrolling. */
export const settle = Effect.fnUntraced(function* <A, E, R>(
  read: Effect.Effect<A, E, R>,
  ready: (value: A) => boolean,
) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = yield* read;

    if (ready(value)) return value;
    yield* Effect.sleep(25);
  }

  return yield* ToolSiteError.make({ operation: "tool site did not settle" });
});
