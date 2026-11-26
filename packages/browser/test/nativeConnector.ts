// The README's native WebSocket example, using Playwright's public transport overload.
import { chromium, type ConnectOverCDPTransport } from "playwright-core";

import type { Connector } from "../src/Cdp.ts";

export const nativeConnect: Connector = async (endpoint, { timeout, headers, signal }) => {
  if (headers !== undefined)
    throw new Error("This native connector does not support custom headers");
  if (signal.aborted) throw new Error("CDP opening canceled");
  const socket = new WebSocket(endpoint);

  const transport: ConnectOverCDPTransport = {
    send: (message) => socket.send(JSON.stringify(message)),
    close: () => socket.close(),
  };

  const abort = () => socket.close();

  signal.addEventListener("abort", abort, { once: true });
  socket.addEventListener("message", (event) => {
    transport.onmessage?.(JSON.parse(String(event.data)) as object);
  });
  socket.addEventListener("close", () => {
    signal.removeEventListener("abort", abort);
    transport.onclose?.();
  });

  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("Native CDP WebSocket failed")), {
        once: true,
      });
      socket.addEventListener("close", () => reject(new Error("Native CDP WebSocket closed")), {
        once: true,
      });
    });

    return await chromium.connectOverCDP(transport, { timeout });
  } catch (cause) {
    signal.removeEventListener("abort", abort);
    socket.close();

    throw cause;
  }
};
