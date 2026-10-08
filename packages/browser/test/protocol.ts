// A local Chromium reached only through a DevTools proxy, for tests that count what crosses the
// connection or plant a command's absence. Nothing else attaches to the browser: it is started
// directly, in its own headless mode, where a tab behind another is hidden unless a session holds
// focus emulation on it.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { chromium } from "playwright-core";

/** One command a client sent through the proxy. */
export interface Command {
  readonly id: number;
  readonly method: string;
  readonly sessionId: string | undefined;
  /** The message's size on the wire. */
  readonly bytes: number;
  /**
   * The round trip it went out in. Commands sent while another awaits its answer share one, as
   * they would share the latency of a remote browser. Screencast acknowledgements take none.
   */
  readonly round: number;
  /** The connection it came on, numbered from 0 in the order the clients connected. */
  readonly connection: number;
}

export interface Proxy {
  /** The browser's DevTools address, through the proxy. */
  endpoint: string;
  /** Every command sent, in order. */
  readonly commands: Array<Command>;
  /** The size of each answer, by its command's id. */
  readonly answers: Map<number, number>;
  /** Sessions a client attached itself with `Target.attachToTarget`, rather than automatically. */
  readonly attached: Set<string>;
  /** Answer a command with an empty result instead of sending it on. */
  swallow: (command: Command) => boolean;
  /**
   * Hold everything one way for a while, then send it on in order, as a stalled connection does:
   * toward the client, frames and answers alike; toward the browser, acknowledgements and commands.
   */
  stall: (toward: "client" | "browser", millis: number) => void;
  /**
   * How long a command takes to reach the browser, every later message on its connection waiting
   * behind it, as behind a large upload on a slow link. None by default.
   */
  hold: (command: Command) => number;
  /** How long what the browser sends on a connection takes to reach its client. None by default. */
  lag: (connection: number) => number;
  /** How many connections clients have opened. */
  connected: number;
  /** Cut every connection open now, or the one numbered `connection`, as a network fault would. */
  readonly drop: (connection?: number) => void;
}

// One direction of a connection: messages pass at once, except while it stalls, when they wait and
// then go in the order they came.
const direction = (until: () => number, deliver: (message: string) => void) => {
  const held: Array<string> = [];

  const release = () => {
    const wait = until() - performance.now();

    if (wait > 0) return void setTimeout(release, wait);
    for (const message of held.splice(0)) deliver(message);
  };

  return (message: string) => {
    if (held.length === 0 && performance.now() >= until()) return deliver(message);
    if (held.push(message) === 1) setTimeout(release, Math.max(0, until() - performance.now()));
  };
};

// The messages a client sends over a WebSocket: each frame is masked, and a message can span
// several frames.
const messages = (onMessage: (text: string) => void, onClose: () => void) => {
  let held = Buffer.alloc(0);
  let parts: Array<Buffer> = [];

  return (chunk: Buffer) => {
    held = Buffer.concat([held, chunk]);
    while (held.length >= 2) {
      const short = held[1]! & 0x7f;
      const lengthBytes = short === 126 ? 2 : short === 127 ? 8 : 0;
      const head = 2 + lengthBytes + 4;

      if (held.length < head) return;

      const length =
        lengthBytes === 2
          ? held.readUInt16BE(2)
          : lengthBytes === 8
            ? Number(held.readBigUInt64BE(2))
            : short;

      if (held.length < head + length) return;
      const mask = held.subarray(head - 4, head);

      const payload = held
        .subarray(head, head + length)
        .map((byte, index) => byte ^ mask[index % 4]!);

      const first = held[0]!;

      held = held.subarray(head + length);
      if ((first & 0x0f) === 0x8) return onClose();
      // Other control frames, such as a ping, end no message.
      if ((first & 0x08) !== 0) continue;
      parts.push(Buffer.from(payload));
      if ((first & 0x80) !== 0) {
        onMessage(Buffer.concat(parts).toString());
        parts = [];
      }
    }
  };
};

// One unmasked text frame, as a server sends it.
const frame = (text: string) => {
  const payload = Buffer.from(text);
  const length = payload.length;
  const head = Buffer.alloc(length < 126 ? 2 : length < 65_536 ? 4 : 10);

  head.writeUInt8(0x81, 0);
  if (length < 126) head.writeUInt8(length, 1);
  else if (length < 65_536) {
    head.writeUInt8(126, 1);
    head.writeUInt16BE(length, 2);
  } else {
    head.writeUInt8(127, 1);
    head.writeBigUInt64BE(BigInt(length), 2);
  }

  return Buffer.concat([head, payload]);
};

const accept = (key: string) =>
  createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");

// Relay each connection to the browser, counting what it sends and swallowing what it asks to.
const relay = (
  browser: URL,
  proxy: Proxy,
  stalled: { client: number; browser: number },
  connections: Map<number, Socket>,
) =>
  createServer((client) => {
    const connection = proxy.connected++;
    const attaching = new Set<number>();
    const awaiting = new Set<number>();
    let rounds = 0;
    let upstream: WebSocket | undefined;
    let request = Buffer.alloc(0);
    // Until when this connection's held command holds what follows it, and when its latest
    // message toward the client arrives, which none after it precedes.
    let heldUntil = 0;
    let arrives = 0;

    connections.set(connection, client);
    client.on("close", () => connections.delete(connection));

    const toBrowser = direction(
      () => Math.max(stalled.browser, heldUntil),
      (text) => upstream?.send(text),
    );

    const toClient = direction(
      () => stalled.client,
      (text) => {
        arrives = Math.max(performance.now() + proxy.lag(connection), arrives);
        const wait = arrives - performance.now();

        if (wait <= 0) client.write(frame(text));
        else
          setTimeout(() => {
            if (!client.destroyed) client.write(frame(text));
          }, wait);
      },
    );

    const fromClient = messages(
      (text) => {
        const { id, method, sessionId } = JSON.parse(text) as Command;
        const acknowledging = method === "Page.screencastFrameAck";

        if (!acknowledging && awaiting.size === 0) rounds++;

        const command = {
          id,
          method,
          sessionId,
          bytes: Buffer.byteLength(text),
          round: rounds,
          connection,
        };

        proxy.commands.push(command);
        if (method === "Target.attachToTarget") attaching.add(id);
        if (proxy.swallow(command)) toClient(JSON.stringify({ id, result: {}, sessionId }));
        else {
          if (!acknowledging) awaiting.add(id);
          heldUntil = Math.max(heldUntil, performance.now() + proxy.hold(command));
          toBrowser(text);
        }
      },
      () => {
        // Answer the closing handshake, or the client waits for it.
        client.end(Buffer.from([0x88, 0x00]));
        upstream?.close();
      },
    );

    client.on("data", (chunk: Buffer) => {
      if (upstream !== undefined) return fromClient(chunk);
      request = Buffer.concat([request, chunk]);
      const key = /^Sec-WebSocket-Key:\s*(\S+)/im.exec(request.toString("latin1"))?.[1];

      if (key === undefined || !request.includes("\r\n\r\n")) return;
      const socket = new WebSocket(browser);

      upstream = socket;
      // No extension is accepted, so the client sends plain text.
      socket.addEventListener("open", () =>
        client.write(
          "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
            `Sec-WebSocket-Accept: ${accept(key)}\r\n\r\n`,
        ),
      );
      socket.addEventListener("message", ({ data }: MessageEvent<string>) => {
        const { id, result } = JSON.parse(data) as {
          readonly id?: number;
          readonly result?: { readonly sessionId?: string };
        };

        if (id !== undefined) {
          proxy.answers.set(id, Buffer.byteLength(data));
          awaiting.delete(id);
        }
        if (id !== undefined && attaching.delete(id) && result?.sessionId !== undefined)
          proxy.attached.add(result.sessionId);
        toClient(data);
      });
      socket.addEventListener("close", () => client.destroy());
    });
    client.on("close", () => upstream?.close());
    client.on("error", () => client.destroy());
  });

// Chromium and its helper processes, in a group of their own so that one signal stops them all.
const launch = (profile: string, args: ReadonlyArray<string>) =>
  Effect.callback<{ readonly stop: () => void; readonly endpoint: URL }>((resume) => {
    const child = spawn(
      chromium.executablePath(),
      [
        "--headless",
        "--no-sandbox",
        "--no-first-run",
        "--no-default-browser-check",
        "--hide-scrollbars",
        "--mute-audio",
        "--window-size=800,600",
        ...args,
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"], detached: true },
    );

    const stop = () => {
      try {
        process.kill(-(child.pid ?? 0), "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };

    let output = "";
    let settled = false;

    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const address = /DevTools listening on (ws:\/\/\S+)/.exec(output)?.[1];

      if (address === undefined || settled) return;
      settled = true;
      resume(Effect.succeed({ stop, endpoint: new URL(address) }));
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      resume(Effect.die(new Error(`Chromium exited with ${code ?? "a signal"}: ${output}`)));
    });

    return Effect.sync(stop);
  });

/** A local Chromium for the rest of the scope, and the proxy every connection to it goes through. */
export const behindProxy = Effect.fnUntraced(function* (args: ReadonlyArray<string> = []) {
  const profile = yield* Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "effect-browser-proxy-"))),
    (directory) =>
      Effect.sync(() =>
        rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
      ),
  );

  const { endpoint } = yield* Effect.acquireRelease(launch(profile, args), ({ stop }) =>
    Effect.sync(stop),
  );

  const stalled = { client: 0, browser: 0 };
  const connections = new Map<number, Socket>();

  const proxy: Proxy = {
    endpoint: "",
    commands: [],
    answers: new Map(),
    attached: new Set(),
    swallow: () => false,
    stall: (toward, millis) => {
      stalled[toward] = Math.max(stalled[toward], performance.now() + millis);
    },
    hold: () => 0,
    lag: () => 0,
    connected: 0,
    drop: (connection) => {
      for (const [number, socket] of connections)
        if (connection === undefined || connection === number) socket.destroy();
    },
  };

  const server = yield* Effect.acquireRelease(
    Effect.callback<Server>((resume) => {
      const listening = relay(endpoint, proxy, stalled, connections).listen(0, "127.0.0.1", () =>
        resume(Effect.succeed(listening)),
      );
    }),
    (server) => Effect.sync(() => server.close()),
  );

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  proxy.endpoint = `ws://127.0.0.1:${port}${endpoint.pathname}`;

  return proxy;
});
