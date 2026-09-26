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
      const submissions: Array<{ email: string; plan: string; terms: boolean }> = [];

      const server = createServer((request, response) => {
        const path = request.url ?? "/";

        requests.push(path);
        if (path.startsWith("/signup/commit?") && request.method !== "POST") {
          response.writeHead(405);
          response.end();
        } else if (path.startsWith("/signup/commit?")) {
          const values = new URL(path, "http://fixture.test").searchParams;

          submissions.push({
            email: values.get("email") ?? "",
            plan: values.get("plan") ?? "",
            terms: values.get("terms") === "true",
          });
          response.writeHead(204);
          response.end();
        } else if (path === "/events") {
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
        } else if (path === "/wait" || path === "/wait-enabled") {
          response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          response.end(`<!doctype html><meta charset=utf-8><title>Wait and observe</title>
            <p>Recorder remains active</p><p id="ready">Connecting</p>
            <button id="continue" aria-label="Continue" ${path === "/wait" ? "disabled" : ""}>Continue</button>
            <p id="count">Clicks: 0</p><script>
              const button = document.querySelector('#continue');
              let clicks = 0;
              button.addEventListener('click', () => document.querySelector('#count').textContent = 'Clicks: ' + ++clicks);
              const source = new EventSource('/events');
              source.addEventListener('open', () => { const ready = document.querySelector('#ready'); ready.textContent = 'Ready'; ready.dataset.connected = 'yes'; });
              source.addEventListener('message', event => {
                if (event.data === 'enable') button.disabled = false;
                if (event.data === 'hide') button.hidden = true;
                if (event.data === 'remove') button.remove();
              });
            </script>`);
        } else if (path === "/signup") {
          response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          response.end(`<!doctype html><meta charset=utf-8><title>Sign up</title>
            <nav>${Array.from({ length: 24 }, (_, i) => `<a href="/section-${i}">Section ${i}</a>`).join(" ")}</nav>
            <h1>Create your account</h1>
            <form id="signup">
              <input id="email" name="email" type="email" aria-label="Email">
              <input id="password" name="password" type="password" aria-label="Password">
              <input id="terms" name="terms" type="checkbox" aria-label="I accept the terms">
              <select id="plan" name="plan" aria-label="Plan">
                <option value="free">Free</option><option value="pro">Pro</option>
              </select>
              <button id="create" type="submit">Create account</button>
            </form>
            <p id="result">Not created</p>
            <article>${Array.from({ length: 40 }, (_, i) => `<p>Paragraph ${i} of the terms. ${"Words ".repeat(20)}</p>`).join("")}<p>END OF TERMS</p></article>
            <script>
              document.querySelector('#signup').addEventListener('submit', event => {
                event.preventDefault();
                const form = new FormData(event.target);
                // The server ledger is the oracle; a rendered success message alone proves no write.
                const values = new URLSearchParams({ email: form.get('email'), plan: form.get('plan'), terms: String(form.has('terms')) });
                const commit = new XMLHttpRequest();
                commit.open('POST', '/signup/commit?' + values, false);
                commit.send();
                document.querySelector('#result').textContent =
                  'Created ' + form.get('email') + ' on ' + form.get('plan') + (form.get('terms') ? ' with terms' : '');
              });
            </script>`);
        } else if (path === "/select") {
          response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          response.end(`<!doctype html><meta charset=utf-8><title>Exact option selection</title>
            <select id="route" aria-label="Route">
              <option value="PRIVATE-INITIAL">Initial</option>
              <option value="PRIVATE-FIRST">Duplicate</option>
              <option value="PRIVATE-SECOND">Duplicate</option>
            </select><p id="changes">0</p><p id="selection">0</p>
            <script>
              document.querySelector('#route').addEventListener('change', event => {
                const count = document.querySelector('#changes');
                count.textContent = String(Number(count.textContent) + 1);
                document.querySelector('#selection').textContent = String(event.target.selectedIndex);
              });
            </script>`);
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
        submissions,
        change: (change: "type" | "replace" | "destination" | "enable" | "hide" | "remove") => {
          for (const response of events) response.write(`data: ${change}\n\n`);
        },
        complete: () => {
          for (const response of slow) response.end("<p>COMPLETE DOCUMENT</p>");
        },
        close: async () => {
          server.closeAllConnections();
          await new Promise<void>((resolve) => {
            server.close(() => resolve());
          });
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
