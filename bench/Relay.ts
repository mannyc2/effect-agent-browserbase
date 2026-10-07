// A hosted session's DevTools connection, relayed through the bench so its commands can be read
// as a latency run's are. Playwright connects to a local WebSocket; each message it sends goes on
// to Browserbase over the session's own connection, and each answer comes back the same way.
import { createHash } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";

import { Clock, Effect, Layer, Redacted } from "effect";
import { BrowserbaseClient, Session } from "effect-browserbase/BrowserbaseClient";

import { type Command, messages, protocol } from "./Latency.ts";

const accept = (key: string) =>
  createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");

// One unmasked frame from the relay's side: a text message, or a close.
const frame = (opcode: number, payload: Buffer) => {
  const length = payload.length;

  const head =
    length < 126 ? Buffer.alloc(2) : length < 65_536 ? Buffer.alloc(4) : Buffer.alloc(10);

  head.writeUInt8(0x80 | opcode, 0);
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

const closing = frame(0x8, Buffer.alloc(0));

/**
 * Accept Playwright's connections and relay each to the address `target` gives, once that
 * connection is open, passing each command to `record` once answered. The relay offers no
 * compression, so Playwright's messages arrive as text; the onward connection is the session's.
 */
const listen = (
  target: () => string | undefined,
  clock: Clock.Clock,
  record: (command: Command) => void,
) =>
  Effect.callback<{ readonly server: Server; readonly sockets: Set<Socket> }, Error>((resume) => {
    const sockets = new Set<Socket>();

    const server = createServer((client) => {
      sockets.add(client);
      const commands = protocol(clock, record);
      let upstream: WebSocket | undefined;
      let request: Buffer | undefined = Buffer.alloc(0);

      const end = () => {
        if (!client.destroyed) client.end(closing);
        upstream?.close();
      };

      const fromBench = messages((text) => {
        commands.sent(text);
        upstream?.send(text);
      }, end);

      client.on("data", (chunk: Buffer) => {
        if (request === undefined) return fromBench(chunk);
        request = Buffer.concat([request, chunk]);
        if (request.indexOf("\r\n\r\n") === -1) return;

        const handshake = request;
        const key = /^Sec-WebSocket-Key:\s*(\S+)/im.exec(handshake.toString("latin1"))?.[1];
        const address = target();

        request = undefined;
        if (key === undefined || address === undefined) return client.destroy();

        const socket = new WebSocket(address);

        upstream = socket;
        socket.binaryType = "arraybuffer";
        socket.addEventListener("open", () => {
          client.write(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
              `Sec-WebSocket-Accept: ${accept(key)}\r\n\r\n`,
          );
          // Past the handshake, which the reader skips.
          fromBench(handshake);
        });
        socket.addEventListener("message", (event: MessageEvent) => {
          const text =
            typeof event.data === "string"
              ? event.data
              : Buffer.from(event.data as ArrayBuffer).toString();

          // An answer is timed as it reaches the bench.
          commands.received(text);
          client.write(frame(0x1, Buffer.from(text)));
        });
        socket.addEventListener("close", () => {
          if (!client.destroyed) client.end(closing);
        });
        socket.addEventListener("error", () => client.destroy());
      });
      client.on("close", () => {
        commands.closed();
        upstream?.close();
      });
      client.on("error", () => client.destroy());
    });

    server.on("error", (error) => resume(Effect.fail(error)));
    server.listen(0, "127.0.0.1", () => resume(Effect.succeed({ server, sockets })));
  });

const portOf = (server: Server) => {
  const address = server.address();

  return typeof address === "object" && address !== null ? address.port : 0;
};

/**
 * The client, with each session it creates connected through a relay that passes each DevTools
 * command to `record` once answered. The relay lasts as long as the layer.
 */
export const client = (record: (command: Command) => void) =>
  Layer.effect(
    BrowserbaseClient,
    Effect.gen(function* () {
      const client = yield* BrowserbaseClient;
      const clock = yield* Clock.Clock;
      let target: string | undefined;

      const { server } = yield* Effect.acquireRelease(
        listen(() => target, clock, record).pipe(Effect.orDie),
        ({ server, sockets }) =>
          Effect.sync(() => {
            for (const socket of sockets) socket.destroy();
            server.close();
          }),
      );

      const relayed = Redacted.make(`ws://127.0.0.1:${portOf(server)}/devtools/browser`);

      return BrowserbaseClient.of({
        ...client,
        createSession: (options) =>
          client.createSession(options).pipe(
            Effect.map((session) => {
              if (session.connectUrl === undefined) return session;
              target = Redacted.value(session.connectUrl);

              return new Session({ ...session, connectUrl: relayed });
            }),
          ),
      });
    }),
  );
