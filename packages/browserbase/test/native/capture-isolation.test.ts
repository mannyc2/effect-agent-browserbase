import assert from "node:assert/strict";

import { expect, it } from "@effect/vitest";
import { Effect, Fiber, Schema } from "effect";
import * as Capture from "effect-browser/capture";
import { BrowserbaseBrowser } from "effect-browserbase/browser";
import { Socket } from "effect/unstable/socket";

import { localBrowser, policy, settle, withProvider } from "../fixtures/LocalBrowser.ts";

const Command = Schema.fromJsonString(Schema.Struct({ method: Schema.String }));

it.live("real CDP: observation acknowledgements progress beside a large control request", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* localBrowser;
      const sockets: Array<WebSocket> = [];
      const sent: Array<{ readonly method: string; readonly pending: boolean }> = [];
      let pending = false;

      const constructor: typeof Socket.WebSocketConstructor.Service = (url) => {
        const socket = new WebSocket(url);

        sockets.push(socket);

        return {
          get readyState() {
            return socket.readyState;
          },
          addEventListener: (type, listener, options) =>
            socket.addEventListener(type, listener, options),
          removeEventListener: (type, listener) => socket.removeEventListener(type, listener),
          close: (code, reason) => socket.close(code, reason),
          send: (data) => {
            assert.equal(typeof data, "string");
            const command = Schema.decodeUnknownSync(Command)(data);

            sent.push({ method: command.method, pending });
            socket.send(data);
          },
        };
      };

      yield* withProvider(
        fixture,
        Effect.gen(function* () {
          const session = yield* BrowserbaseBrowser.open(policy);
          const stage = session.initialPage;

          yield* stage.navigate({ url: fixture.url });
          const peer = yield* session.createPage();

          yield* peer.navigate({ url: `${fixture.url}?peer` });
          expect(sockets).toHaveLength(0);

          const capture = yield* Capture.start(stage, {
            lifetime: "page",
            maxFrames: 64,
            maxDurationMillis: 20_000,
          });

          expect(sockets).toHaveLength(1);
          expect(
            (yield* settle(capture.snapshot, (value) => value.received >= 3, 5000)).received,
          ).toBeGreaterThanOrEqual(3);

          // This is a protocol session on the owner's existing Playwright connection.
          const nativePeer = fixture
            .nativePages(session.reference.sessionId)
            .find((page) => page.url().endsWith("?peer"));

          assert.ok(nativePeer);

          // A large upload, followed by an asynchronous reply, keeps the request pending
          // long enough to observe multiple acknowledgements on a real loopback browser.
          // Hosted checks separately qualify upload-time cadence at remote round trips.
          const request = yield* Effect.acquireUseRelease(
            Effect.promise(() => nativePeer.context().newCDPSession(nativePeer)),
            (control) =>
              Effect.promise(async () => {
                pending = true;
                try {
                  await control.send("Runtime.evaluate", {
                    expression: `/*${"x".repeat(2 * 1024 * 1024)}*/new Promise(resolve => setTimeout(() => resolve(true), 1500))`,
                    awaitPromise: true,
                    returnByValue: true,
                  });
                } finally {
                  pending = false;
                }
              }),
            (cdp) => Effect.promise(() => cdp.detach()),
          ).pipe(Effect.forkScoped);

          yield* Fiber.join(request);
          expect(
            sent.filter(
              (command) => command.method === "Page.screencastFrameAck" && command.pending,
            ).length,
          ).toBeGreaterThanOrEqual(6);

          // Both captured targets share the one observation socket; stopping one leaves its peer alive.
          const other = yield* Capture.start(peer, { maxDurationMillis: 10_000 });

          expect(sockets).toHaveLength(1);
          expect(
            (yield* settle(other.snapshot, (value) => value.received > 0, 5000)).received,
          ).toBeGreaterThan(0);
          const otherStopped = yield* other.stop;

          expect(otherStopped.nativeStop).toBe("confirmed");
          expect(otherStopped.qualification.authority).toBe("open");
          expect((yield* peer.observe({ maxControls: 1 })).controls.length).toBeGreaterThan(0);
          const before = (yield* capture.snapshot).received;

          expect(
            (yield* settle(capture.snapshot, (value) => value.received > before, 5000)).received,
          ).toBeGreaterThan(before);
          yield* stage.navigate({ url: `${fixture.url}?next` });

          const navigated = yield* settle(
            capture.snapshot,
            (value) => value.documentBoundaries.length === 1,
            5000,
          );

          expect(navigated.documentBoundaries.map((boundary) => boundary.url)).toEqual([
            `${fixture.url}?next`,
          ]);
          const stopped = yield* capture.stop;

          expect(stopped.nativeStop).toBe("confirmed");
          expect(stopped.qualification.authority).toBe("open");

          const failed = yield* Capture.start(stage, { maxDurationMillis: 10_000 });

          sockets[0]!.close();
          const ended = yield* failed.completed;

          expect(ended.error?.reason._tag).toBe("Transport");
          expect(ended.nativeStop).toBe("confirmed");
          expect(ended.qualification.authority).toBe("open");
          expect((yield* stage.observe({ maxControls: 1 })).controls.length).toBeGreaterThan(0);
          const cleanup = yield* session.closeChecked;

          expect(cleanup.remote).toBe("confirmed");
          expect(sockets[0]!.readyState).toBe(WebSocket.CLOSED);
          expect(fixture.connections).toHaveLength(1);

          const allowed = new Set([
            "Target.attachToTarget",
            "Target.detachFromTarget",
            "Page.enable",
            "Page.getFrameTree",
            "Page.setLifecycleEventsEnabled",
            "Page.startScreencast",
            "Page.screencastFrameAck",
            "Page.stopScreencast",
          ]);

          expect(sent.every((command) => allowed.has(command.method))).toBe(true);
        }),
      ).pipe(Effect.provideService(Socket.WebSocketConstructor, constructor));
    }),
  ),
);
