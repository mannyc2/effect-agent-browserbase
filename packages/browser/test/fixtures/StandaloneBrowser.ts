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

/** Only public page content; no provider endpoints, credentials or session responses. */
export const localSite = Effect.acquireRelease(
  attempt("start site", async () => {
    const requests: string[] = [];

    const server = createServer((request, response) => {
      requests.push(request.url ?? "/");
      response.writeHead(200, { "content-type": "text/html" });
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
      close: () =>
        new Promise<void>((resolve, reject) => {
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
