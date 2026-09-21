import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BrowserbaseBrowser, type BrowserOptions } from "@effect-agent/browserbase/browser";
import { BrowserPolicy } from "@effect-agent/browserbase/browser-data";
import { BrowserbaseClient, type ClientOptions } from "@effect-agent/browserbase/client";
import type { LaunchRecipe } from "@effect-agent/browserbase/launch";
import { BrowserbaseSessions } from "@effect-agent/browserbase/sessions";
import { Effect, Layer, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { chromium, type Page, type ConnectOverCDPOptions } from "playwright-core";

import { installCaptureDiagnostics } from "./NativeCaptureDiagnostics.ts";

/** The scripted control plane answers with the same session shape the provider sends. */
export const clientOptions: ClientOptions = {
  projectId: "project-1",
  apiKey: Redacted.make("fixture-key-not-a-credential"),
};

/** One account and one resource service, shared by every fixture-backed acquisition. */
export const account = BrowserbaseSessions.layer.pipe(
  Layer.provideMerge(BrowserbaseClient.layer(clientOptions)),
);

/** One local launch recipe; overrides extend it rather than inventing a second default. */
export const localLaunch: LaunchRecipe = {
  remoteTimeoutSeconds: 120,
  viewport: { _tag: "Fixed", width: 640, height: 480 },
  provider: {},
};

const providerSession = (id: string, status: string) => ({
  id,
  projectId: "project-1",
  status,
  createdAt: "2026-09-20T19:00:00.000Z",
  updatedAt: "2026-09-20T19:01:00.000Z",
  expiresAt: "2026-09-20T20:00:00.000Z",
  startedAt: "2026-09-20T19:00:01.000Z",
  keepAlive: false,
  proxyBytes: 0,
  region: "us-east-1",
  connectUrl: `wss://connect.browserbase.com/?session=${id}`,
});

export class NativeFixtureError extends Schema.TaggedError<NativeFixtureError>()(
  "NativeFixtureError",
  {
    operation: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

const attempt = <A>(operation: string, body: () => Promise<A>) =>
  Effect.tryPromise({
    try: body,
    catch: (cause) => NativeFixtureError.make({ operation, cause }),
  });

/** Only provider allocation, control-address lookup and status are scripted.
 * Every allocated session has a DIFFERENT real Chromium process and persistent
 * default context. The production adapter still crosses connectOverCDP and runs
 * its actual HTTP/session/page/capture code. This is NOT hosted provider evidence.
 * No production option allows substituting provider origins or CDP addresses. */
export const localBrowser = Effect.acquireRelease(
  attempt("start local fixture", async () => {
    const directory = await mkdtemp(join(tmpdir(), "browserbase-acceptance-"));
    const sessions = new Map<string, { process: ChildProcess; endpoint: string; status: string }>();
    const releaseIds: string[] = [];
    const createBodies: unknown[] = [];
    const connections: string[] = [];
    const nativePages = new Map<string, () => ReadonlyArray<Page>>();
    const requests: string[] = [];
    const uploadedPaths: string[] = [];
    let fileRequests = 0;

    const server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://fixture.test").pathname;

      requests.push(path);
      if (path === "/file") {
        fileRequests++;
        res.writeHead(200, {
          "content-type": "text/plain",
          "content-disposition": 'attachment; filename="fixture.txt"',
        });
        res.end("real browser download\n");

        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      if (path === "/clocks") {
        res.end(`<!doctype html><style>@keyframes clockMotion{to{transform:translateX(100px)}}.clock{width:40px;height:40px;animation:clockMotion 10s linear infinite}#moving{background:red}#paused{background:green;animation-play-state:paused}</style>
          <div id=moving class=clock></div><div id=paused class=clock></div><button id=click onclick="clicks++">Action</button><script>
          window.ticks=0;window.rafs=0;window.clicks=0;window.freezes=[];window.resumes=[];
          setInterval(()=>ticks++,20);function frame(){rafs++;requestAnimationFrame(frame)}requestAnimationFrame(frame);
          window.counters=()=>({ticks,rafs,animation:document.querySelector('#moving').getAnimations()[0].currentTime,paused:document.querySelector('#paused').getAnimations()[0].currentTime});
          document.addEventListener('freeze',()=>freezes.push(counters()));document.addEventListener('resume',()=>resumes.push(counters()));
          window.read=()=>({...counters(),clicks,freezes,resumes});</script>`);

        return;
      }
      if (path === "/frame") {
        res.end(
          '<p>frame text</p><button id="inner" onclick="this.textContent=\'frame clicked\'">Frame action</button>',
        );

        return;
      }
      if (path === "/next") {
        res.end('<h1>next page</h1><a href="/">Return</a>');

        return;
      }
      res.end(`<!doctype html><meta charset=utf-8><title>Local browser acceptance</title>
      <style>body{margin:0;font:18px sans-serif}#motion{width:300px;height:100px;background:#e30;animation:slide 1s linear infinite alternate}@keyframes slide{to{transform:translateX(220px);background:#05c}}.spacer{height:1600px}</style>
      <h1>Local browser fixture</h1><button id="increment" onclick="count.textContent=Number(count.textContent)+1">Increment</button><span id="count">0</span>
      <input aria-label="Name" id="name" oninput="echo.textContent=this.value"><span id="echo"></span>
      <button class="duplicate">Duplicate</button><button class="duplicate">Duplicate</button>
      <button id="disabled" disabled>Unavailable</button>
      <a id="next" href="/next">Next page</a><a id="download" href="/file" download>Download</a>
      <button id="popup" onclick="window.open('/next')">Popup</button>
      <button id="dialog" onclick="alert('private dialog');echo.textContent='dialog completed'">Dialog</button>
      <input id="file" type="file" multiple onchange="chosen.textContent=[...this.files].map(f=>f.name+':'+f.size).join(',')"><span id="chosen"></span>
      <button id="choose" onclick="document.querySelector('#file').click()">Choose files</button>
      <button id="readFile" onclick="(async()=>{const f=document.querySelector('#file').files[0];content.textContent=f?await f.text():''})()">Read file</button><span id="content"></span>
      <div id="motion"></div><iframe name="child" src="/frame"></iframe><div class="spacer"></div><p>bottom marker</p>`);
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();

    if (address === null || typeof address === "string") throw new Error("No fixture port");
    const url = `http://127.0.0.1:${address.port}/`;
    const originalConnect = chromium.connectOverCDP.bind(chromium);

    // Test-only replacement of the provider address resolution, NOT the native engine.
    // The adapter's configured WSS origin still passes its unmodified validation.
    chromium.connectOverCDP = async (endpoint: unknown, options?: ConnectOverCDPOptions) => {
      if (typeof endpoint !== "string") throw new Error("Expected provider URL");
      const requested = new URL(endpoint);

      assert.equal(requested.origin, "wss://connect.browserbase.com");
      const id = requested.searchParams.get("session");
      const session = id === null ? undefined : sessions.get(id);

      if (!session) throw new Error("Unknown scripted provider session");
      connections.push(id!);

      const browser = await originalConnect(session.endpoint, options);

      installCaptureDiagnostics(browser, id!, connections.length);
      nativePages.set(id!, () => browser.contexts().flatMap((context) => context.pages()));

      return browser;
    };

    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      const parsed = new URL(request.url);

      assert.equal(parsed.origin, "https://api.browserbase.com");
      assert.equal(request.headers.get("x-bb-api-key"), "fixture-key-not-a-credential");
      if (parsed.pathname === "/v1/sessions" && request.method === "POST") {
        createBodies.push(await request.json());
        const id = `session-${createBodies.length}`;
        const profile = join(directory, id);

        await mkdir(profile, { recursive: true });

        // Launch ONLY the process: a launchPersistentContext client would be a
        // second controller which can auto-dismiss dialogs behind the adapter.
        const process = spawn(
          globalThis.process.env.BROWSERBASE_CHROMIUM ?? chromium.executablePath(),
          [
            "--headless=new",
            "--no-sandbox",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-dev-shm-usage",
            "--remote-debugging-port=0",
            `--user-data-dir=${profile}`,
            "about:blank",
          ],
          { cwd: profile, stdio: ["ignore", "pipe", "pipe"] },
        );

        let diagnostic = "";

        process.stdout?.resume();
        process.stderr?.on("data", (chunk: Buffer) => {
          diagnostic = (diagnostic + chunk.toString()).slice(-4096);
        });
        // Always register process cleanup before waiting for the CDP address.
        sessions.set(id, { process, endpoint: "", status: "RUNNING" });
        try {
          const deadline = performance.now() + 10000;
          let port: string | undefined;

          while (!port && performance.now() < deadline) {
            if (process.exitCode !== null) throw new Error(`Local Chromium exited: ${diagnostic}`);
            try {
              port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0];
            } catch {
              await new Promise<void>((resolve) => setTimeout(resolve, 20));
            }
          }
          if (!port || !/^\d+$/.test(port)) throw new Error(`No local CDP port: ${diagnostic}`);
          const endpoint = `http://127.0.0.1:${port}`;

          sessions.set(id, { process, endpoint, status: "RUNNING" });
          // Production configures Browserbase's required relative "downloads"
          // directory through real CDP. cwd keeps those files execution-owned;
          // no fixture-side CDP client overrides the adapter's download policy.
        } catch (error) {
          console.error("Local process fixture allocation failed", error);
          process.kill("SIGKILL");
          throw error;
        }

        return Response.json(providerSession(id, "RUNNING"));
      }
      const id = parsed.pathname.split("/")[3];
      const session = sessions.get(id);

      if (!session) return Response.json({}, { status: 404 });
      if (parsed.pathname.endsWith("/uploads") && request.method === "POST") {
        // The fixture stands in for provider-side storage: it keeps the bytes where the
        // browser process can open them, exactly as a remote upload location would.
        const file = (await request.formData()).get("file");

        if (!(file instanceof File)) return Response.json({}, { status: 400 });
        const directoryPath = join(directory, id, "uploads");

        await mkdir(directoryPath, { recursive: true });
        const stored = join(directoryPath, file.name);

        await writeFile(stored, new Uint8Array(await file.arrayBuffer()));
        uploadedPaths.push(stored);

        return Response.json({ message: "File uploaded successfully", path: stored });
      }
      if (parsed.pathname.endsWith("/debug")) {
        return Response.json({
          debuggerFullscreenUrl: "https://www.browserbase.com/view?token=fixture",
          pages: [],
        });
      }
      if (request.method === "POST") {
        releaseIds.push(id);
        session.status = "COMPLETED";
      }

      return Response.json(providerSession(id, session.status));
    };

    const options: BrowserOptions = { launch: localLaunch, actionTimeoutMillis: 5000 };

    return {
      directory,
      url,
      sessions,
      releaseIds,
      createBodies,
      connections,
      nativePages: (id: string) => nativePages.get(id)?.() ?? [],
      requests,
      uploadedPaths,
      fileRequests: () => fileRequests,
      options,
      account,
      layer: (overrides: Partial<BrowserOptions> = {}) =>
        BrowserbaseBrowser.layer({ ...options, ...overrides }).pipe(Layer.provide(account)),
      fetch,
      human: async <A>(id: string, action: (page: Page) => Promise<A>): Promise<A> => {
        const session = sessions.get(id);

        if (!session) throw new Error("No native fixture session");
        const browser = await originalConnect(session.endpoint);

        try {
          const page = browser.contexts()[0]?.pages()[0];

          if (!page) throw new Error("No native fixture page");

          return await action(page);
        } finally {
          await browser.close();
        }
      },
      close: async () => {
        chromium.connectOverCDP = originalConnect;
        await Promise.all(
          [...sessions.values()].map(
            (s) =>
              new Promise<void>((resolve) => {
                if (s.process.exitCode !== null || s.process.signalCode !== null) {
                  resolve();

                  return;
                }

                const timer = setTimeout(() => {
                  s.process.kill("SIGKILL");
                }, 2000);

                s.process.once("exit", () => {
                  clearTimeout(timer);
                  resolve();
                });
                s.process.kill("SIGTERM");
              }),
          ),
        );
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        // Chromium may finish releasing profile files just after process exit.
        // Node's recursive rm retries the documented ENOTEMPTY/EBUSY/EPERM class
        // without weakening the fixture's requirement to remove its whole profile.
        await rm(directory, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        });
      },
    };
  }),
  (fixture) => attempt("close local fixture", fixture.close).pipe(Effect.orDie),
);

export const policy = BrowserPolicy.make({
  network: { _tag: "Unrestricted" },
  maxActions: 100,
  maxElapsedMillis: 120000,
  maxReturnedBytes: 2 * 1024 * 1024,
});

export const withProvider = <A, E, R>(
  fixture: Effect.Success<typeof localBrowser>,
  effect: Effect.Effect<A, E, R>,
  options: Partial<BrowserOptions> = {},
) =>
  Effect.scoped(effect).pipe(
    Effect.provide(fixture.layer(options)),
    Effect.provideService(FetchHttpClient.Fetch, fixture.fetch),
  );
