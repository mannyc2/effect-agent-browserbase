// A local Chromium reached over the DevTools protocol through a proxy that delays each direction,
// so a free run pays the round trips of a remote browser, such as a hosted session over CDP. Only
// the connection between the bench and the browser is slowed; pages still load locally. The proxy
// also reads the protocol, so a trial can say which commands each of its spans waited on.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Clock, Effect, Layer } from "effect";
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

/** One DevTools command the bench sent, by method alone: its parameters can carry typed text. */
export interface Command {
  readonly method: string;
  /** When the bench sent it and when the answer reached the bench, on the clock spans use. */
  readonly sent: bigint;
  readonly ended: bigint;
  /** A result, an error, or none before the connection closed. */
  readonly answer: "result" | "error" | "none";
}

// The WebSocket frame starting at `at`, or how many bytes from `at` it needs to be read.
const frameAt = (data: Buffer, at: number) => {
  const available = data.length - at;

  if (available < 2) return 2;

  const second = data.readUInt8(at + 1);
  const short = second & 0x7f;
  const masked = (second & 0x80) !== 0;
  const head = 2 + (short === 126 ? 2 : short === 127 ? 8 : 0) + (masked ? 4 : 0);

  if (available < head) return head;

  const length =
    short === 126
      ? data.readUInt16BE(at + 2)
      : short === 127
        ? Number(data.readBigUInt64BE(at + 2))
        : short;

  if (available < head + length) return head + length;

  const payload = Buffer.from(data.subarray(at + head, at + head + length));

  // The bench's side masks each payload with the four bytes before it.
  if (masked)
    for (let index = 0; index < length; index++)
      payload[index] = payload.readUInt8(index) ^ data.readUInt8(at + head - 4 + (index % 4));

  const first = data.readUInt8(at);

  return {
    last: (first & 0x80) !== 0,
    control: (first & 0x08) !== 0,
    payload,
    size: head + length,
  };
};

/**
 * Read one direction of a WebSocket connection, past its opening handshake, as the text of each
 * message once its last frame has arrived.
 */
const messages = (onMessage: (text: string) => void) => {
  let held: Array<Buffer> = [];
  let size = 0;
  let needed = 0;
  let upgraded = false;
  let parts: Array<Buffer> = [];

  return (chunk: Buffer) => {
    held.push(chunk);
    size += chunk.length;
    if (size < needed) return;

    const data = held.length === 1 ? chunk : Buffer.concat(held, size);
    let at = 0;

    if (!upgraded) {
      const end = data.indexOf("\r\n\r\n");

      if (end === -1) {
        held = [data];

        return;
      }
      upgraded = true;
      at = end + 4;
    }

    for (;;) {
      const frame = frameAt(data, at);

      if (typeof frame === "number") {
        held = at < data.length ? [data.subarray(at)] : [];
        size = data.length - at;
        needed = frame;

        return;
      }
      at += frame.size;
      if (frame.control) continue;
      parts.push(frame.payload);
      if (frame.last) {
        onMessage(Buffer.concat(parts).toString());
        parts = [];
      }
    }
  };
};

const fields = (
  text: string,
): { readonly id?: unknown; readonly method?: unknown; readonly error?: unknown } => {
  try {
    const value: unknown = JSON.parse(text);

    return typeof value === "object" && value !== null ? value : {};
  } catch {
    return {};
  }
};

// Each command the bench sends, matched with its answer by the id the bench gave it.
const protocol = (clock: Clock.Clock, record: (command: Command) => void) => {
  const pending = new Map<number, { readonly method: string; readonly sent: bigint }>();

  return {
    sent: (text: string) => {
      const { id, method } = fields(text);

      if (typeof id === "number" && typeof method === "string")
        pending.set(id, { method, sent: clock.currentTimeNanosUnsafe() });
    },
    received: (text: string) => {
      const { id, error } = fields(text);
      const command = typeof id === "number" ? pending.get(id) : undefined;

      // Events carry no id.
      if (typeof id !== "number" || command === undefined) return;
      pending.delete(id);
      record({
        ...command,
        ended: clock.currentTimeNanosUnsafe(),
        answer: error === undefined ? "result" : "error",
      });
    },
    closed: () => {
      const ended = clock.currentTimeNanosUnsafe();

      for (const command of pending.values()) record({ ...command, ended, answer: "none" });
      pending.clear();
    },
  };
};

// The bench's side offers to compress messages, which would hide them from the proxy. Without the
// offer the browser sends plain text, and a round trip costs the same: the proxy adds delay, not a
// bandwidth limit.
const uncompressed = (request: Buffer) =>
  Buffer.from(
    request.toString("latin1").replace(/^Sec-WebSocket-Extensions:.*\r\n/gim, ""),
    "latin1",
  );

/**
 * Forward connections to `port`, holding every chunk `delay` milliseconds, in order, and pass each
 * command the bench sends to `record` once it is answered.
 */
const delaying = (
  port: number,
  delay: number,
  clock: Clock.Clock,
  record: (command: Command) => void,
) =>
  Effect.callback<{ readonly server: Server; readonly sockets: Set<Socket> }, BrowserError>(
    (resume) => {
      const sockets = new Set<Socket>();

      // Write each chunk to `to` `delay` milliseconds after it is given, then to `written`.
      const delayed = (to: Socket, written: (data: Buffer) => void = () => {}) => {
        const queue: Array<{ readonly due: number; readonly data: Buffer }> = [];
        let timer: NodeJS.Timeout | undefined;

        const pump = () => {
          timer = undefined;
          for (let next = queue[0]; next !== undefined && next.due <= Date.now(); next = queue[0]) {
            queue.shift();
            to.write(next.data);
            written(next.data);
          }
          if (queue[0] !== undefined) timer = setTimeout(pump, queue[0].due - Date.now());
        };

        return (data: Buffer) => {
          queue.push({ due: Date.now() + delay, data });
          timer ??= setTimeout(pump, delay);
        };
      };

      const server = createServer((client) => {
        const upstream = connect(port, "127.0.0.1");
        const commands = protocol(clock, record);
        const sent = messages(commands.sent);
        const toBrowser = delayed(upstream);
        // The bench's opening request is held until whole, to take out its offer to compress.
        let request: Buffer | undefined = Buffer.alloc(0);

        client.on("data", (chunk: Buffer) => {
          let data = chunk;

          if (request !== undefined) {
            request = Buffer.concat([request, chunk]);
            const end = request.indexOf("\r\n\r\n");

            if (end === -1) return;
            data = Buffer.concat([
              uncompressed(request.subarray(0, end + 4)),
              request.subarray(end + 4),
            ]);
            request = undefined;
          }
          sent(data);
          toBrowser(data);
        });
        // An answer is timed as the bench gets it, after the delay back.
        upstream.on("data", delayed(client, messages(commands.received)));
        client.on("close", commands.closed);

        for (const [from, to] of [
          [client, upstream],
          [upstream, client],
        ] as const) {
          from.on("close", () => to.destroy());
          from.on("error", () => to.destroy());
        }
        sockets.add(client).add(upstream);
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
 * session's is, so it is calibrated the same way. Each command sent over the connection is passed
 * to `record` once answered.
 */
export const open = Effect.fn("Latency.open")(function* (
  roundTripMillis: number,
  options: Browser.Options,
  record: (command: Command) => void,
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

  const clock = yield* Clock.Clock;

  const { server } = yield* Effect.acquireRelease(
    delaying(Number(endpoint.port), roundTripMillis / 2, clock, record),
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

export const layer = (
  roundTripMillis: number,
  options: Browser.Options,
  record: (command: Command) => void,
) => Layer.effect(Browser.Browser, open(roundTripMillis, options, record));
