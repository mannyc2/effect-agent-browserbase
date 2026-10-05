// Synthetic transport fragments and one real Chromium process; protocol payloads never leave the sink.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { chromium } from "playwright-core";

import * as Protocol from "../Protocol.ts";

class ProbeError extends Schema.TaggedError<ProbeError>()("ProtocolProbeError", {
  cause: Schema.Defect(),
}) {}

const secret = "PRIVATE-CANARY-session-url-page-text";
const encoder = new TextEncoder();
const baseTime = Date.parse("2026-01-01T00:00:00.000Z");

const wire = (millis: number, direction: "send" | "receive", message: unknown) =>
  encoder.encode(
    new Date(baseTime + millis).toISOString() +
      " pw:protocol " +
      (direction === "send" ? "SEND ► " : "◀ RECV ") +
      JSON.stringify(message) +
      "\n",
  );

const send = (sink: Protocol.Sink, millis: number, id: number, method = "Runtime.evaluate") =>
  sink.feed(wire(millis, "send", { id, method, params: { value: secret } }));

const reply = (sink: Protocol.Sink, millis: number, id: number) =>
  sink.feed(wire(millis, "receive", { id, result: { value: secret } }));

const localAttachment = Effect.gen(function* () {
  const directory = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => mkdtemp(join(tmpdir(), "protocol-attach-")),
      catch: (cause) => new ProbeError({ cause }),
    }),
    (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
  );

  const context = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        chromium.launchPersistentContext(directory, {
          args: ["--remote-debugging-port=0"],
        }),
      catch: (cause) => new ProbeError({ cause }),
    }),
    (browser) => Effect.promise(() => browser.close()),
  );

  const portFile = yield* Effect.tryPromise({
    try: () => readFile(join(directory, "DevToolsActivePort"), "utf8"),
    catch: (cause) => new ProbeError({ cause }),
  });

  const port = Number(portFile.split("\n")[0]);

  assert.isTrue(Number.isInteger(port) && port > 0 && port < 65536);

  return { context, url: "http://127.0.0.1:" + port };
});

describe("native protocol aggregation", () => {
  it("matches sessions, reversed replies and errors across every byte boundary without disclosing payloads", () => {
    const sink = Protocol.make();

    const messages = [
      { at: 0, direction: "send", value: { id: 1, method: "Browser.getVersion", params: {} } },
      {
        at: 1,
        direction: "send",
        value: {
          id: 1,
          sessionId: secret,
          method: "Runtime.evaluate",
          params: { expression: secret + " 字 😀" },
        },
      },
      {
        at: 2,
        direction: "receive",
        value: {
          method: "Page.loadEventFired",
          sessionId: secret,
          params: { url: "https://" + secret },
        },
      },
      {
        at: 5,
        direction: "receive",
        value: { id: 1, sessionId: secret, result: { value: secret } },
      },
      { at: 10, direction: "receive", value: { id: 1, result: { product: secret } } },
      {
        at: 11,
        direction: "send",
        value: { id: 2, method: "Input.dispatchKeyEvent", params: { text: secret } },
      },
      { at: 21, direction: "receive", value: { id: 2, error: { code: -1, message: secret } } },
      {
        at: 22,
        direction: "send",
        value: { id: 3, method: "Private.secret", params: { url: secret } },
      },
      { at: 24, direction: "receive", value: { id: 3, result: {} } },
    ] as const;

    for (const message of messages) {
      for (const byte of wire(message.at, message.direction, message.value))
        sink.feed(Uint8Array.of(byte));
    }
    sink.feed(encoder.encode("An unrelated warning " + secret + "\n"));
    assert.isFalse(sink.snapshot().complete);
    const result = sink.finish();

    assert.isTrue(result.complete);
    assert.isTrue(result.finished);
    assert.strictEqual(result.commands, 4);
    assert.strictEqual(result.replies, 4);
    assert.strictEqual(result.matchedReplies, 4);
    assert.strictEqual(result.unmatchedReplies, 0);
    assert.strictEqual(result.pendingCommands, 0);
    assert.strictEqual(result.events, 1);
    assert.strictEqual(result.errors, 1);
    assert.strictEqual(result.commandsByDomain.browser, 1);
    assert.strictEqual(result.commandsByDomain.runtime, 1);
    assert.strictEqual(result.commandsByDomain.input, 1);
    assert.strictEqual(result.commandsByDomain.other, 1);
    assert.strictEqual(result.eventsByDomain.page, 1);
    assert.strictEqual(result.ignoredStderrLines, 1);
    assert.deepStrictEqual(result.latency, {
      measuredReplies: 4,
      p50Millis: 4,
      p95Millis: 10,
      minMillis: 2,
      maxMillis: 10,
    });
    assert.deepStrictEqual(result.bytes, {
      sent: messages
        .filter((message) => message.direction === "send")
        .reduce(
          (sum, message) => sum + Buffer.byteLength(JSON.stringify(message.value), "utf8"),
          0,
        ),
      received: messages
        .filter((message) => message.direction === "receive")
        .reduce(
          (sum, message) => sum + Buffer.byteLength(JSON.stringify(message.value), "utf8"),
          0,
        ),
    });
    assert.strictEqual(result.latencyClock, "logger-wall-millis");
    assert.strictEqual(result.byteMeasurement, "serialized-cdp-json-utf8");
    assert.notInclude(JSON.stringify(result), secret);
    assert.notInclude(JSON.stringify(result), "Private.secret");
    assert.notInclude(JSON.stringify(result), "https://");
    assert.deepStrictEqual(sink.finish(), result);
  });

  it("recovers after oversized, malformed, truncated and invalid UTF-8 lines while marking counts incomplete", () => {
    const sink = Protocol.make({ maxLineBytes: 256 });

    sink.feed(encoder.encode(secret.repeat(40) + "\n"));
    sink.feed(
      encoder.encode("2026-01-01T00:00:00.000Z pw:protocol SEND ► {broken " + secret + "\n"),
    );
    sink.feed(
      encoder.encode(
        '2026-01-01T00:00:00.000Z pw:protocol SEND ► {"id":1, <<<<<( LOG TRUNCATED )>>>>> }\n',
      ),
    );
    sink.feed(Uint8Array.of(0xc3, 0x28, 10));
    send(sink, 1, 2);
    reply(sink, 2, 2);
    const result = sink.finish();

    assert.isFalse(result.complete);
    assert.strictEqual(result.commands, 1);
    assert.strictEqual(result.matchedReplies, 1);
    assert.strictEqual(result.issues.oversizedLines, 1);
    assert.strictEqual(result.issues.malformedLines, 1);
    assert.strictEqual(result.issues.truncatedLines, 1);
    assert.strictEqual(result.issues.invalidUtf8Lines, 1);
    assert.notInclude(JSON.stringify(result), secret);
  });

  it("keeps unmatched replies, duplicate IDs and bounded pending overflow explicit", () => {
    const sink = Protocol.make({ maxPending: 2 });

    send(sink, 0, 1);
    send(sink, 1, 1);
    send(sink, 2, 2);
    send(sink, 3, 3);
    reply(sink, 4, 3);
    reply(sink, 5, 1);
    const result = sink.finish();

    assert.isFalse(result.complete);
    assert.strictEqual(result.commands, 4);
    assert.strictEqual(result.replies, 2);
    assert.strictEqual(result.matchedReplies, 1);
    assert.strictEqual(result.unmatchedReplies, 1);
    assert.strictEqual(result.pendingCommands, 1);
    assert.strictEqual(result.issues.duplicateCommands, 1);
    assert.strictEqual(result.issues.pendingOverflow, 1);
    assert.strictEqual(result.issues.malformedLines, 0);
  });

  it("requires EOF and reports a shutdown command without a reply separately from malformed input", () => {
    const sink = Protocol.make();

    send(sink, 0, -9999, "Browser.close");
    const result = sink.finish();

    assert.isFalse(result.complete);
    assert.strictEqual(result.pendingCommands, 1);
    assert.strictEqual(result.pendingShutdownCommands, 1);
    assert.strictEqual(result.knownUnloggedShutdownReplies, 0);
    assert.strictEqual(result.issues.unfinishedLines, 0);
    assert.strictEqual(result.issues.malformedLines, 0);
    assert.isNull(result.latency.p50Millis);
    assert.isFalse(Protocol.make().finish().complete);
    const nativeClose = Protocol.make();

    reply(nativeClose, 1, -9999);
    const close = nativeClose.finish();

    assert.isFalse(close.complete);
    assert.strictEqual(close.commands, 0);
    assert.strictEqual(close.replies, 1);
    assert.strictEqual(close.unmatchedReplies, 1);
    assert.strictEqual(close.knownUnloggedShutdownReplies, 1);
    assert.strictEqual(close.issues.malformedLines, 0);
    assert.strictEqual(close.bytes.sent, 0);
  });

  it("rejects partial EOF, post-EOF chunks and invalid wire envelopes without exposing input", () => {
    const sink = Protocol.make();

    sink.feed(wire(0, "send", { id: 1.5, method: "Runtime.evaluate" }));
    sink.feed(wire(1, "receive", { id: 1, result: {}, error: { message: secret } }));
    sink.feed(wire(2, "send", { id: 1, method: "Runtime.evaluate" }).subarray(0, 40));
    const result = sink.finish();

    assert.isFalse(result.complete);
    assert.strictEqual(result.issues.malformedLines, 2);
    assert.strictEqual(result.issues.unfinishedLines, 1);
    sink.feed(encoder.encode(secret));
    assert.strictEqual(sink.snapshot().issues.chunksAfterFinish, 1);
    assert.notInclude(JSON.stringify(sink.snapshot()), secret);
  });

  it("invalidates logger clock regressions and bounded percentile overflow", () => {
    const clock = Protocol.make();

    send(clock, 10, 1);
    reply(clock, 5, 1);
    const backwards = clock.finish();

    assert.isFalse(backwards.complete);
    assert.strictEqual(backwards.issues.clockRegressions, 1);
    assert.strictEqual(backwards.latency.measuredReplies, 0);
    assert.isNull(backwards.latency.p50Millis);
    const limited = Protocol.make({ maxLatencyBuckets: 1 });

    send(limited, 0, 1);
    reply(limited, 1, 1);
    send(limited, 2, 2);
    reply(limited, 5, 2);
    const overflow = limited.finish();

    assert.isFalse(overflow.complete);
    assert.strictEqual(overflow.issues.latencyOverflow, 1);
    assert.strictEqual(overflow.latency.measuredReplies, 2);
    assert.strictEqual(overflow.latency.minMillis, 1);
    assert.strictEqual(overflow.latency.maxMillis, 3);
    assert.isNull(overflow.latency.p50Millis);
    assert.isNull(overflow.latency.p95Millis);
    assert.throws(() => Protocol.make({ maxPending: 0 }), RangeError);
  });

  for (const mode of ["launch", "attach"] as const)
    it.live(
      mode +
        " observes Playwright startup, navigation and evaluation as well as an owned CDP session",
      () =>
        Effect.gen(function* () {
          const sink = Protocol.make();

          const attached = mode === "attach" ? yield* localAttachment : undefined;

          const program = `
        import { chromium } from "playwright-core";
        const browser = ${
          attached === undefined
            ? "await chromium.launch()"
            : "await chromium.connectOverCDP(" + JSON.stringify(attached.url) + ")"
        };
        try {
          const context = await browser.newContext();
          const page = await context.newPage();
          await page.goto("data:text/html,<title>free-protocol-probe</title><p>${secret}</p>");
          await page.evaluate((value) => { document.body.dataset.probe = value; }, "${secret}");
          const session = await context.newCDPSession(page);
          await session.send("Performance.enable");
          await session.send("Performance.getMetrics");
          await session.detach();
          await context.close();
        } finally {
          await browser.close();
        }
        process.stdout.write("done");
      `;

          const running = yield* Effect.acquireRelease(
            Effect.sync(() => {
              const child = spawn(process.execPath, ["--input-type=module", "-e", program], {
                cwd: fileURLToPath(new URL("..", import.meta.url)),
                env: {
                  PATH: process.env.PATH,
                  HOME: process.env.HOME,
                  PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
                  ...Protocol.environment,
                },
                stdio: ["ignore", "pipe", "pipe"],
              });

              let stdoutBytes = 0;

              const done = new Promise<{
                readonly code: number | null;
                readonly stdoutBytes: number;
                readonly protocol: Protocol.Snapshot;
              }>((resolve, reject) => {
                child.stderr.on("data", (chunk: Buffer) => sink.feed(chunk));
                child.stdout.on("data", (chunk: Buffer) => {
                  stdoutBytes += chunk.length;
                });
                child.once("error", reject);
                child.once("close", (code) =>
                  resolve({ code, stdoutBytes, protocol: sink.finish() }),
                );
              });

              return { child, done };
            }),
            ({ child, done }) =>
              Effect.promise(async () => {
                if (child.exitCode === null) child.kill("SIGKILL");
                await done.catch(() => undefined);
              }),
          );

          const result = yield* Effect.tryPromise({
            try: () => running.done,
            catch: (cause) => new ProbeError({ cause }),
          });

          const protocol = result.protocol;

          assert.strictEqual(result.code, 0);
          assert.strictEqual(result.stdoutBytes, 4);
          assert.isTrue(protocol.finished);
          assert.isTrue(protocol.observed);
          assert.isAbove(protocol.commands, 10);
          assert.isAbove(protocol.commandsByDomain.browser, 0);
          assert.isAbove(protocol.commandsByDomain.target, 0);
          assert.isAbove(protocol.commandsByDomain.page, 0);
          assert.isAbove(protocol.commandsByDomain.runtime, 0);
          assert.strictEqual(protocol.commandsByDomain.performance, 2);
          assert.isAbove(protocol.events, 0);
          assert.isAbove(protocol.matchedReplies, 10);
          assert.isAbove(protocol.bytes.sent, 0);
          assert.isAbove(protocol.bytes.received, 0);
          assert.strictEqual(protocol.issues.malformedLines, 0);
          assert.strictEqual(protocol.issues.truncatedLines, 0);
          assert.strictEqual(protocol.issues.oversizedLines, 0);
          assert.strictEqual(protocol.issues.invalidUtf8Lines, 0);
          assert.strictEqual(protocol.issues.unfinishedLines, 0);
          assert.strictEqual(protocol.unmatchedReplies, protocol.knownUnloggedShutdownReplies);
          assert.isAtMost(protocol.knownUnloggedShutdownReplies, 1);
          assert.strictEqual(protocol.commands, protocol.matchedReplies + protocol.pendingCommands);
          assert.strictEqual(
            protocol.complete,
            protocol.pendingCommands === 0 && protocol.unmatchedReplies === 0,
          );
          assert.notInclude(JSON.stringify(protocol), secret);
          if (attached !== undefined) {
            assert.strictEqual(protocol.knownUnloggedShutdownReplies, 0);
            assert.isTrue(attached.context.browser()?.isConnected());

            const stillAlive = yield* Effect.tryPromise({
              try: async () => {
                const page = await attached.context.newPage();

                try {
                  return await page.evaluate(() => 2 + 2);
                } finally {
                  await page.close();
                }
              },
              catch: (cause) => new ProbeError({ cause }),
            });

            assert.strictEqual(stillAlive, 4);
          }
        }).pipe(Effect.scoped, Effect.timeout("15 seconds")),
    );
});
