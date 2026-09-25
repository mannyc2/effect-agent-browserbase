import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { Effect, Redacted, Schema } from "effect";
import { chromium } from "playwright-core";

class FixtureError extends Schema.TaggedError<FixtureError>()("StandaloneBrowserFixtureError", {
  operation: Schema.String,
}) {}

const attempt = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: () => FixtureError.make({ operation }),
  });

const spaBarrier = () => {
  let arrive = () => {};
  let release = () => {};

  const arrived = new Promise<void>((resolve) => {
    arrive = resolve;
  });

  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  return { arrived, arrive, released, release };
};

const spaVisitBarrier = () => ({ push: spaBarrier(), fragment: spaBarrier() });

/** Only public page content; no provider endpoints, credentials or session responses. */
export const localSite = Effect.acquireRelease(
  attempt("start site", async () => {
    const requests: string[] = [];
    const spaVisits = new Map<string, ReturnType<typeof spaVisitBarrier>>();
    let spaVisitSerial = 0;

    const closeSpaVisits = () => {
      for (const visit of spaVisits.values()) {
        visit.push.release();
        visit.fragment.release();
      }
      spaVisits.clear();
    };

    const server = createServer((request, response) => {
      requests.push(request.url ?? "/");
      const url = new URL(request.url ?? "/", "http://127.0.0.1");

      if (url.pathname === "/spa/advance") {
        const visit = spaVisits.get(url.searchParams.get("visit") ?? "");
        const step = url.searchParams.get("step");

        const barrier =
          step === "push" ? visit?.push : step === "fragment" ? visit?.fragment : undefined;

        if (barrier === undefined) {
          response.writeHead(404).end();

          return;
        }
        response.writeHead(200, { "content-type": "text/plain" });
        barrier.arrive();
        void barrier.released.then(() => response.end("continue"));

        return;
      }
      response.writeHead(200, { "content-type": "text/html" });

      if (url.pathname === "/pinned-slow") {
        // Intentionally never reaches DOMContentLoaded. The navigation test stops this request.
        response.write("<!doctype html><title>Pinned slow</title><main>loading");

        return;
      }
      if (url.pathname === "/pinned-delayed") {
        response.write("<!doctype html><title>Pinned delayed</title><main>");
        setTimeout(() => {
          response.end('<span id="delayed">complete</span></main>');
        }, 100);

        return;
      }
      if (url.pathname === "/pinned-frame") {
        response.end(`<!doctype html><title>Pinned child</title>
        <strong id=frame-name>${url.searchParams.get("name") ?? "child"}</strong>
        <button id=frame-increment onclick="frameCount.textContent=Number(frameCount.textContent)+1">Increment frame</button>
        <span id=frameCount>0</span>`);

        return;
      }
      if (url.pathname === "/spa") {
        response.end(`<!doctype html><title>Single page navigation</title>
        <button id=push>Push route</button>
        <button id=fragment>Change fragment</button>
        <script>
          const visit = new URLSearchParams(location.search).get('visit');
          const waitForAdvance = async (step) => (await fetch('/spa/advance?visit=' + visit + '&step=' + step)).ok;
          (async () => {
            if (!await waitForAdvance('push')) return;
            history.pushState({}, '', '/spa/route');
            document.body.insertAdjacentHTML('beforeend', '<span id=pushed>pushed</span>');
            if (!await waitForAdvance('fragment')) return;
            location.hash = 'section';
            document.body.insertAdjacentHTML('beforeend', '<span id=fragmented>fragmented</span>');
          })();
        </script>
        <main id=section>Stable page</main>`);

        return;
      }
      if (url.pathname === "/pinned") {
        const name = url.searchParams.get("name") ?? "page";

        response.end(`<!doctype html><title>Pinned ${name}</title>
        <h1 id=page-name>${name}</h1>
        <button id=increment onclick="count.textContent=Number(count.textContent)+1">Increment</button>
        <button id=remove-frame onclick="child.remove()">Remove child</button>
        <span id=count>0</span>
        <iframe id=child src="/pinned-frame?name=${encodeURIComponent(`${name}-child`)}"></iframe>`);

        return;
      }
      response.end(`<!doctype html><title>Local ownership</title><style>
      body{margin:0;font:18px sans-serif}button{margin:30px;padding:20px}
      #motion{width:120px;height:80px;background:red;animation:slide 1s linear infinite alternate}
      @keyframes slide{to{transform:translateX(120px);background:blue}}</style>
      <h1>Local ownership fixture</h1><button id=increment onclick="count.textContent=Number(count.textContent)+1">Increment</button>
      <span id=count>0</span><div id=motion></div>`);
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();

    if (address === null || typeof address === "string") throw new Error("No listening site");

    return {
      url: `http://127.0.0.1:${address.port}/`,
      requests,
      spaVisit: () => {
        const id = String(++spaVisitSerial);
        const barriers = spaVisitBarrier();

        spaVisits.set(id, barriers);

        return {
          url: `http://127.0.0.1:${address.port}/spa?visit=${id}`,
          push: { arrived: barriers.push.arrived, release: barriers.push.release },
          fragment: { arrived: barriers.fragment.arrived, release: barriers.fragment.release },
          close: () => {
            barriers.push.release();
            barriers.fragment.release();
            spaVisits.delete(id);
          },
        };
      },
      close: () =>
        new Promise<void>((resolve, reject) => {
          closeSpaVisits();
          // Register listener closure before forcing socket teardown on Node and Bun.
          server.close((error) => (error === undefined ? resolve() : reject(error)));
          server.closeAllConnections();
        }),
    };
  }),
  (site) => attempt("close site", site.close).pipe(Effect.orDie),
);

const stop = async (child: ChildProcess) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 2000);

    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
};

/** An external host owns this real process; the library only receives its concrete CDP endpoint. */
export const externalChromium = Effect.acquireRelease(
  attempt("start external Chromium", async () => {
    const directory = await mkdtemp(join(tmpdir(), "borrowed-chromium-"));

    const child = spawn(
      process.env.BROWSERBASE_CHROMIUM ?? chromium.executablePath(),
      [
        "--headless=new",
        "--no-sandbox",
        "--no-first-run",
        "--no-default-browser-check",
        "--remote-debugging-port=0",
        `--user-data-dir=${directory}`,
        "about:blank",
      ],
      { cwd: directory, stdio: "ignore" },
    );

    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      const deadline = performance.now() + 25000;
      let address: string | undefined;

      while (performance.now() < deadline) {
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error("External Chromium exited");

        const portFile = await readFile(join(directory, "DevToolsActivePort"), "utf8").catch(
          () => undefined,
        );

        // Chromium creates the file before it writes the port and path; wait for both lines.
        if (portFile !== undefined) {
          const [port, path] = portFile.trim().split("\n");

          if (port !== undefined && path !== undefined) {
            address = `ws://127.0.0.1:${port}${path}`;
            break;
          }
        }
        await delay(20);
      }
      if (address === undefined) throw new Error("No external endpoint");

      return {
        endpoint: Redacted.make(address),
        running: () => child.exitCode === null && child.signalCode === null,
        close: async () => {
          await stop(child);
          await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        },
      };
    } catch (error) {
      await stop(child);
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      throw error;
    }
  }),
  (host) => attempt("stop external Chromium", host.close).pipe(Effect.orDie),
);
