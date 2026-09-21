import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BrowserbaseBrowser } from "@effect-agent/browserbase/browser";
import * as BrowserBinding from "@effect-agent/browserbase/browser-binding";
import { BrowserPolicy } from "@effect-agent/browserbase/browser-data";
import { BrowserbaseClient } from "@effect-agent/browserbase/client";
import { BrowserError } from "@effect-agent/browserbase/errors";
import type { LaunchRecipe } from "@effect-agent/browserbase/launch";
import { BrowserbaseSessions } from "@effect-agent/browserbase/sessions";
import { BrowserbaseInteractiveHost } from "@effect-agent/platform-browserbase/adapter";
import { Effect, Layer, Redacted, Schema } from "effect";
import { InteractiveBrowserPolicy } from "effect-agent/interactive-browser";
import { FetchHttpClient } from "effect/unstable/http";
import { chromium } from "playwright-core";

/**
 * This package owns its live-browser harness. The generic package's fixtures are not
 * reachable from here: each package is installed on its own, and a relative import
 * across package roots is rejected by the workspace's export boundary check.
 *
 * Only provider allocation, the control address and session status are scripted. Every
 * allocated session is a different real Chromium process with its own persistent default
 * context, and the adapter still crosses connectOverCDP and runs its real code: the fixture
 * supplies a trusted binding that resolves the provider address locally, and replaces nothing
 * global. This is not hosted-provider evidence.
 */
export class AgentFixtureError extends Schema.TaggedError<AgentFixtureError>()(
  "AgentFixtureError",
  { operation: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
) {}

const attempt = <A>(operation: string, body: () => Promise<A>) =>
  Effect.tryPromise({ try: body, catch: (cause) => AgentFixtureError.make({ operation, cause }) });

const launch: LaunchRecipe = {
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

export const agentPolicy = InteractiveBrowserPolicy.make({
  network: { _tag: "Unrestricted" },
  maxActions: 100,
  maxElapsedMillis: 120000,
  maxReturnedBytes: 2 * 1024 * 1024,
});

export const genericAgentPolicy = BrowserPolicy.make({
  ...agentPolicy,
  network: { _tag: "Unrestricted" },
});

export const localAgentBrowser = Effect.acquireRelease(
  attempt("start agent fixture", async () => {
    const directory = await mkdtemp(join(tmpdir(), "browserbase-agent-"));
    const sessions = new Map<string, { process: ChildProcess; endpoint: string; status: string }>();
    const releaseIds: string[] = [];
    const connectionIds: string[] = [];
    const createBodies: unknown[] = [];

    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><meta charset=utf-8><title>Local browser fixture</title>
      <h1>Local browser fixture</h1>
      <button id="increment" onclick="count.textContent=Number(count.textContent)+1">Increment</button>
      <span id="count">0</span>
      <input aria-label="Name" id="name" oninput="echo.textContent=this.value"><span id="echo"></span>`);
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();

    if (address === null || typeof address === "string") throw new Error("No fixture port");
    const url = `http://127.0.0.1:${address.port}/`;

    // Only provider address resolution is the fixture's. The binding still applies the
    // production address checks first and runs the unmodified Playwright connection and
    // driver; nothing global is replaced.
    const binding = BrowserBinding.playwright({
      resolveEndpoint: ({ url }) =>
        Effect.suspend(() => {
          const requested = new URL(Redacted.value(url));

          assert.equal(requested.origin, "wss://connect.browserbase.com");
          const id = requested.searchParams.get("session");
          const session = id === null ? undefined : sessions.get(id);

          if (id === null || session === undefined)
            return Effect.fail(BrowserError.make({ operation: "connect", reason: "provider" }));
          connectionIds.push(id);

          return Effect.succeed(session.endpoint);
        }),
    });

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

        // Launch ONLY the process: a second Playwright client would be another
        // controller able to act behind the adapter's own ownership rules.
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

          sessions.set(id, { process, endpoint: `http://127.0.0.1:${port}`, status: "RUNNING" });
        } catch (error) {
          console.error("Local process fixture allocation failed", error);
          process.kill("SIGKILL");
          throw error;
        }

        return Response.json(providerSession(id, "RUNNING"));
      }
      const id = parsed.pathname.split("/")[3] ?? "";
      const session = sessions.get(id);

      if (!session) return Response.json({}, { status: 404 });
      if (request.method === "POST") {
        releaseIds.push(id);
        session.status = "COMPLETED";
      }

      return Response.json(providerSession(id, session.status));
    };

    return {
      url,
      releaseIds,
      connectionIds,
      createBodies,
      fetch,
      binding: BrowserBinding.layer(binding),
      close: async () => {
        await Promise.all(
          [...sessions.values()].map(
            (entry) =>
              new Promise<void>((resolve) => {
                if (entry.process.exitCode !== null || entry.process.signalCode !== null) {
                  resolve();

                  return;
                }

                const timer = setTimeout(() => {
                  entry.process.kill("SIGKILL");
                }, 2000);

                entry.process.once("exit", () => {
                  clearTimeout(timer);
                  resolve();
                });
                entry.process.kill("SIGTERM");
              }),
          ),
        );
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        // Chromium may finish releasing profile files just after process exit.
        await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      },
    };
  }),
  (fixture) => attempt("close agent fixture", fixture.close).pipe(Effect.orDie),
);

const accounts = BrowserbaseSessions.layer.pipe(
  Layer.provideMerge(
    BrowserbaseClient.layer({
      projectId: "project-1",
      apiKey: Redacted.make("fixture-key-not-a-credential"),
    }),
  ),
);

/** One adapter host over this package's local-process fixture and scripted control plane. */
export const withAgentBrowser = <A, E, R>(
  fixture: Effect.Success<typeof localAgentBrowser>,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.scoped(effect).pipe(
    Effect.provide(
      BrowserbaseInteractiveHost.layer({ launch, actionTimeoutMillis: 5000 }).pipe(
        Layer.provide(accounts),
        Layer.provide(fixture.binding),
      ),
    ),
    Effect.provideService(FetchHttpClient.Fetch, fixture.fetch),
  );

/** Typed bootstrap acquisition uses this one generic owner, then the adapter borrows it. */
export const withGenericAgentBrowser = <A, E, R>(
  fixture: Effect.Success<typeof localAgentBrowser>,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.scoped(effect).pipe(
    Effect.provide(
      BrowserbaseBrowser.layer({ launch, actionTimeoutMillis: 5000 }).pipe(
        Layer.provide(accounts),
        Layer.provide(fixture.binding),
      ),
    ),
    Effect.provideService(FetchHttpClient.Fetch, fixture.fetch),
  );
