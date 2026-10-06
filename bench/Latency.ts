// A local Chromium reached over the DevTools protocol through a proxy that delays each direction,
// so a free run pays the round trips of a remote browser, such as a hosted session over CDP. Only
// the connection between the bench and the browser is slowed; pages still load locally.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer } from "effect";
import * as Browser from "effect-browser/Browser";
import { BrowserError, Failed } from "effect-browser/BrowserError";
import { chromium } from "playwright-core";

const failed = (operation: string) => (cause: unknown) =>
  new BrowserError({
    operation,
    reason: new Failed({ detail: cause instanceof Error ? cause.message : String(cause) }),
    dispatched: false,
  });

// The defaults Playwright gives a launch that change how a page paces itself in a headless browser.
const flags = [
  "--headless",
  "--no-sandbox",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--hide-scrollbars",
  "--mute-audio",
];

/** Start Chromium with a DevTools port and wait for the address it prints. */
const launch = (profile: string) =>
  Effect.callback<{ readonly child: ChildProcess; readonly endpoint: URL }, BrowserError>(
    (resume) => {
      const child = spawn(
        chromium.executablePath(),
        [...flags, "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"],
        // A group of its own, so stopping it stops its helper processes too.
        { stdio: ["ignore", "ignore", "pipe"], detached: true },
      );

      let output = "";
      let settled = false;

      const settle = (
        outcome: Effect.Effect<
          { readonly child: ChildProcess; readonly endpoint: URL },
          BrowserError
        >,
      ) => {
        if (settled) return;
        settled = true;
        resume(outcome);
      };

      child.stderr?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        const address = /DevTools listening on (ws:\/\/\S+)/.exec(output)?.[1];

        if (address !== undefined) settle(Effect.succeed({ child, endpoint: new URL(address) }));
      });
      child.on("error", (error) => settle(Effect.fail(failed("launch")(error))));
      child.on("exit", (code) =>
        settle(Effect.fail(failed("launch")(`Chromium exited with ${code ?? "a signal"}`))),
      );

      return Effect.sync(() => child.kill("SIGKILL"));
    },
  );

/**
 * Kill Chromium and its helper processes, whose profile is thrown away so nothing needs saving,
 * and wait until it has exited.
 */
const stop = (child: ChildProcess) =>
  Effect.callback<void>((resume) => {
    if (child.exitCode !== null || child.signalCode !== null) return resume(Effect.void);
    child.once("exit", () => resume(Effect.void));
    if (child.pid === undefined || !killGroup(child.pid)) child.kill("SIGKILL");
  }).pipe(Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.void }));

const killGroup = (pid: number) => {
  try {
    return process.kill(-pid, "SIGKILL");
  } catch {
    return false;
  }
};

/** Forward connections to `port`, holding every chunk `delay` milliseconds, in order. */
const delaying = (port: number, delay: number) =>
  Effect.callback<{ readonly server: Server; readonly sockets: Set<Socket> }, BrowserError>(
    (resume) => {
      const sockets = new Set<Socket>();

      const forward = (from: Socket, to: Socket) => {
        const queue: Array<{ readonly due: number; readonly data: Buffer }> = [];
        let timer: NodeJS.Timeout | undefined;

        const pump = () => {
          timer = undefined;
          for (let next = queue[0]; next !== undefined && next.due <= Date.now(); next = queue[0]) {
            queue.shift();
            to.write(next.data);
          }
          if (queue[0] !== undefined) timer = setTimeout(pump, queue[0].due - Date.now());
        };

        from.on("data", (data: Buffer) => {
          queue.push({ due: Date.now() + delay, data });
          timer ??= setTimeout(pump, delay);
        });
        from.on("close", () => to.destroy());
        from.on("error", () => to.destroy());
      };

      const server = createServer((client) => {
        const upstream = connect(port, "127.0.0.1");

        sockets.add(client).add(upstream);
        forward(client, upstream);
        forward(upstream, client);
      });

      server.on("error", (error) => resume(Effect.fail(failed("proxy")(error))));
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed({ server, sockets })));
    },
  );

const portOf = (server: Server) => {
  const address = server.address();

  return typeof address === "object" && address !== null ? address.port : 0;
};

/**
 * Open a `Browser` on a new 1280×720 context of a local Chromium whose DevTools connection takes
 * `roundTripMillis` more per round trip, half each way. The context is fresh, as a new hosted
 * session's is, so it is calibrated the same way.
 */
export const open = Effect.fn("Latency.open")(function* (
  roundTripMillis: number,
  options: Browser.Options = {},
) {
  const profile = yield* Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "bench-latency-"))),
    (directory) =>
      // Chromium's helper processes can still write to it briefly after the browser exits.
      Effect.try(() =>
        rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
      ).pipe(
        Effect.ignore({ log: "Warn", message: "the latency browser's profile was not removed" }),
      ),
  );

  const { endpoint } = yield* Effect.acquireRelease(launch(profile), ({ child }) => stop(child));

  const { server } = yield* Effect.acquireRelease(
    delaying(Number(endpoint.port), roundTripMillis / 2),
    ({ server, sockets }) =>
      Effect.sync(() => {
        for (const socket of sockets) socket.destroy();
        server.close();
      }),
  );

  const connected = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        chromium.connectOverCDP(`ws://127.0.0.1:${portOf(server)}${endpoint.pathname}`, {
          timeout: 30_000,
        }),
      catch: failed("connect"),
    }),
    (browser) => Effect.tryPromise(() => browser.close()).pipe(Effect.ignore),
  );

  const context = yield* Effect.tryPromise({
    try: () =>
      connected.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 }),
    catch: failed("connect"),
  });

  return yield* Browser.make(
    context,
    { id: `chromium-${connected.version()}`, provider: "chromium", contextOrigin: "fresh" },
    options,
  );
});

export const layer = (roundTripMillis: number, options: Browser.Options = {}) =>
  Layer.effect(Browser.Browser, open(roundTripMillis, options));
