import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Redacted, Scheduler } from "effect";
import { BrowserPolicy } from "effect-browser/browser-data";
import type { CaptureStart } from "effect-browser/browser-runtime";
import * as Capture from "effect-browser/capture";
import * as BrowserTesting from "effect-browser/testing";
import { TestClock } from "effect/testing";
import { FetchHttpClient } from "effect/unstable/http";
import { Socket } from "effect/unstable/socket";

import * as Account from "../src/Account.ts";
import { BrowserbaseBrowser } from "../src/Browser.ts";
import * as BrowserBinding from "../src/BrowserBinding.ts";
import { makeObservation } from "../src/internal/browser/Observation.ts";
import { registerObservationEndpoint } from "../src/internal/browser/ObservationBinding.ts";
import { recipe } from "../src/Launch.ts";
import * as Testing from "../src/Testing.ts";

interface Command {
  readonly id: number;
  readonly method: string;
  readonly sessionId?: string;
  readonly params?: { readonly targetId?: string; readonly sessionId?: string | number };
}

class ScriptedSocket implements Socket.WebSocketLike {
  readyState = 1;
  readonly commands: Array<Command> = [];
  readonly held = new Set<string>();
  readonly rejected = new Set<string>();
  readonly attached = new Map<string, string>();
  readonly listeners = new Map<string, Set<(event: Socket.WebSocketEvent) => void>>();
  readonly sent = Deferred.makeUnsafe<void>();
  confirmClose = true;
  malformedAttachment = false;
  detachOnAttach = false;

  addEventListener(type: string, listener: (event: Socket.WebSocketEvent) => void) {
    const listeners = this.listeners.get(type) ?? new Set();

    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: Socket.WebSocketEvent) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, event: Socket.WebSocketEvent) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  message(message: unknown) {
    this.emit("message", { data: JSON.stringify(message) });
  }

  send(data: string | Uint8Array<ArrayBuffer>) {
    const command: Command = JSON.parse(String(data));

    this.commands.push(command);
    Deferred.doneUnsafe(this.sent, Effect.void);
    if (this.held.has(command.method)) return;
    if (this.rejected.has(command.method)) {
      this.message({ id: command.id, error: { code: -32000, message: "SCRIPTED-CONNECT-KEY" } });

      return;
    }
    let result: unknown = {};

    if (command.method === "Target.attachToTarget") {
      const sessionId = `observation-${String(command.params?.targetId)}`;

      this.attached.set(String(command.params?.targetId), sessionId);
      result = this.malformedAttachment ? { unexpected: sessionId } : { sessionId };
    }
    if (command.method === "Page.getFrameTree")
      result = { frameTree: { frame: { id: "root", url: "https://capture.test/one" } } };
    this.message({ id: command.id, result });
    if (command.method === "Target.attachToTarget" && this.detachOnAttach)
      this.message({
        method: "Target.detachedFromTarget",
        params: { sessionId: this.attached.get(String(command.params?.targetId)) },
      });
    if (command.method === "Target.detachFromTarget")
      this.message({ method: "Target.detachedFromTarget", params: command.params });
  }

  frame(sessionId: string, timestamp: number) {
    this.message({
      sessionId,
      method: "Page.screencastFrame",
      params: {
        sessionId: Math.floor(timestamp),
        data: Buffer.from(BrowserTesting.jpeg()).toString("base64"),
        metadata: { timestamp, deviceWidth: 640, deviceHeight: 480 },
      },
    });
  }

  close() {
    if (!this.confirmClose || this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", { code: 1000 });
  }
}

const fixture = Effect.fnUntraced(function* () {
  const provider = yield* Testing.provider();

  const engine = yield* BrowserTesting.binding({
    documents: [{ url: "https://capture.test/one", text: "control remains usable" }],
  });

  const sockets: Array<ScriptedSocket> = [];
  const routing: Array<string> = [];
  let configure = (_socket: ScriptedSocket): void => {};

  const constructor: typeof Socket.WebSocketConstructor.Service = () => {
    const socket = new ScriptedSocket();

    configure(socket);
    sockets.push(socket);

    return socket;
  };

  const binding = registerObservationEndpoint(engine.binding, ({ url }) =>
    Effect.sync(() => {
      routing.push(Redacted.value(url));

      return "wss://scripted.invalid/observation";
    }),
  );

  const account = Account.layer({
    projectId: provider.control.projectId,
    apiKey: Redacted.make(provider.control.secrets.apiKey),
  }).pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, provider.fetch)));

  const layer = BrowserbaseBrowser.layer({ launch: recipe() }).pipe(
    Layer.provide(account),
    Layer.provide(BrowserTesting.sequentialCrypto),
    Layer.provide(BrowserBinding.layer(binding)),
    Layer.provide(Layer.succeed(Socket.WebSocketConstructor, constructor)),
  );

  return {
    layer,
    provider: provider.control,
    sockets,
    routing,
    configure: (f: typeof configure) => {
      configure = f;
    },
  };
});

const policy = BrowserPolicy.unrestricted();
const sessionId = (socket: ScriptedSocket) => [...socket.attached.values()][0]!;

const settle = <A>(effect: Effect.Effect<A>, done: (value: A) => boolean): Effect.Effect<A> =>
  effect.pipe(
    Effect.filterOrElse(done, () =>
      Effect.yieldNow.pipe(Effect.andThen(Effect.suspend(() => settle(effect, done)))),
    ),
  );

it.effect("scripted provider lazily shares observation and preserves ordered document frames", () =>
  Effect.gen(function* () {
    const f = yield* fixture();

    yield* Effect.scoped(
      Effect.gen(function* () {
        const browser = yield* BrowserbaseBrowser.open(policy);

        yield* browser.initialPage.navigate({ url: "https://capture.test/one" });
        expect(f.sockets).toHaveLength(0);
        const capture = yield* Capture.start(browser.initialPage, { lifetime: "page" });
        const socket = f.sockets[0]!;
        const id = sessionId(socket);

        socket.frame(id, 1);
        socket.message({
          sessionId: id,
          method: "Page.frameNavigated",
          params: { frame: { id: "root", url: "https://capture.test/two" } },
        });
        socket.frame(id, 2);
        socket.message({
          sessionId: id,
          method: "Page.navigatedWithinDocument",
          params: { frameId: "root", url: "https://capture.test/two#hash" },
        });
        socket.frame(id, 3);
        const snapshot = yield* settle(capture.snapshot, (value) => value.received === 3);

        expect(snapshot.documentBoundaries.map((value) => [value.url, value.sameDocument])).toEqual(
          [
            ["https://capture.test/two", false],
            ["https://capture.test/two#hash", true],
          ],
        );
        expect(
          socket.commands.filter((command) => command.method === "Page.screencastFrameAck"),
        ).toHaveLength(3);
        const peer = yield* browser.createPage();
        const other = yield* Capture.start(peer);

        expect(f.sockets).toHaveLength(1);
        expect(f.routing).toHaveLength(1);
        expect((yield* other.stop).qualification.authority).toBe("open");
        expect((yield* capture.stop).nativeStop).toBe("confirmed");
        expect(socket.readyState).toBe(1);
        const receipt = yield* browser.closeChecked;

        expect(receipt.issues).toEqual([]);
        expect(socket.readyState).toBe(3);
        expect(
          socket.commands.every(
            (command) =>
              !command.method.startsWith("Runtime.") && !command.method.startsWith("Input."),
          ),
        ).toBe(true);
      }),
    ).pipe(Effect.provide(f.layer));
    expect((yield* f.provider.sessions)[0]?.releaseRequests).toBe(1);
  }),
);

it.effect("an observation attachment failure ends only its capture and keeps control usable", () =>
  Effect.gen(function* () {
    const f = yield* fixture();

    yield* Effect.scoped(
      Effect.gen(function* () {
        const browser = yield* BrowserbaseBrowser.open(policy);

        yield* browser.initialPage.navigate({ url: "https://capture.test/one" });
        const capture = yield* Capture.start(browser.initialPage);
        const peer = yield* browser.createPage();
        const sibling = yield* Capture.start(peer);
        const socket = f.sockets[0]!;

        socket.message({
          method: "Target.detachedFromTarget",
          params: { sessionId: sessionId(socket) },
        });
        const ended = yield* capture.completed;

        expect(ended.error?.reason._tag).toBe("Disconnected");
        expect(ended.qualification.authority).toBe("open");
        expect(ended.nativeStop).toBe("confirmed");
        expect((yield* browser.initialPage.observe()).text).toBe("control remains usable");
        expect((yield* sibling.snapshot).phase).toBe("capturing");
        expect((yield* sibling.stop).nativeStop).toBe("confirmed");
        expect((yield* browser.closeChecked).issues).toEqual([]);
      }),
    ).pipe(Effect.provide(f.layer));
  }),
);

it.effect("malformed observation replies are sanitized and close without retiring control", () =>
  Effect.gen(function* () {
    const f = yield* fixture();

    f.configure((socket) => {
      socket.malformedAttachment = true;
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const browser = yield* BrowserbaseBrowser.open(policy);
        const error = yield* Capture.start(browser.initialPage).pipe(Effect.flip);

        expect(error.reason._tag).toBe("Malformed");
        expect(f.sockets[0]?.readyState).toBe(3);
        expect(JSON.stringify(error)).not.toContain(f.provider.secrets.connectUrl);
        expect((yield* browser.initialPage.describe()).targetId).toBeDefined();
        expect((yield* browser.closeChecked).issues).toEqual([]);
      }),
    ).pipe(Effect.provide(f.layer));
  }),
);

it.effect("a late rejected acknowledgement for a stopped page cannot stop its sibling", () =>
  Effect.gen(function* () {
    const f = yield* fixture();

    f.configure((socket) => {
      socket.held.add("Page.screencastFrameAck");
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const browser = yield* BrowserbaseBrowser.open(policy);
        const capture = yield* Capture.start(browser.initialPage);
        const peer = yield* browser.createPage();
        const sibling = yield* Capture.start(peer);
        const socket = f.sockets[0]!;

        socket.frame(sessionId(socket), 1);
        yield* settle(capture.snapshot, (value) => value.received === 1);

        const acknowledgement = socket.commands.find(
          (command) => command.method === "Page.screencastFrameAck",
        )!;

        expect((yield* capture.stop).nativeStop).toBe("confirmed");
        socket.message({
          id: acknowledgement.id,
          error: { code: -32001, message: "Session not found: SCRIPTED-CONNECT-KEY" },
        });
        socket.frame([...socket.attached.values()][1]!, 2);
        expect((yield* settle(sibling.snapshot, (value) => value.received === 1)).phase).toBe(
          "capturing",
        );
        expect((yield* sibling.stop).nativeStop).toBe("confirmed");
        expect((yield* browser.closeChecked).issues).toEqual([]);
      }),
    ).pipe(Effect.provide(f.layer));
  }),
);

it.effect("a lost attach reply closes observation and never retries the uncertain attachment", () =>
  Effect.gen(function* () {
    const f = yield* fixture();

    f.configure((socket) => {
      socket.held.add("Target.attachToTarget");
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const browser = yield* BrowserbaseBrowser.open(policy);
        const starting = yield* Capture.start(browser.initialPage).pipe(Effect.forkScoped);

        yield* settle(
          Effect.sync(() => f.sockets[0]?.commands.length ?? 0),
          (value) => value > 0,
        );
        yield* TestClock.adjust(2000);
        const error = yield* Fiber.join(starting).pipe(Effect.flip);

        expect(error.reason._tag).toBe("Timeout");
        expect(f.sockets[0]?.readyState).toBe(3);
        expect(f.sockets[0]?.commands.map((command) => command.method)).toEqual([
          "Target.attachToTarget",
        ]);
        expect((yield* browser.initialPage.describe()).targetId).toBeDefined();
        expect((yield* browser.closeChecked).issues).toEqual([]);
      }),
    ).pipe(Effect.provide(f.layer));
  }),
);

it.effect("a stalled acknowledgement stream ends its capture with a bounded typed timeout", () =>
  Effect.gen(function* () {
    const f = yield* fixture();

    f.configure((socket) => {
      socket.held.add("Page.screencastFrameAck");
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const browser = yield* BrowserbaseBrowser.open(policy);
        const capture = yield* Capture.start(browser.initialPage);
        const peer = yield* browser.createPage();
        const sibling = yield* Capture.start(peer);
        const socket = f.sockets[0]!;

        socket.frame(sessionId(socket), 1);
        yield* settle(capture.snapshot, (value) => value.received === 1);
        yield* TestClock.adjust(2250);
        const ended = yield* capture.completed;

        expect(ended.error?.reason._tag).toBe("Timeout");
        expect(ended.nativeStop).toBe("confirmed");
        expect((yield* sibling.snapshot).phase).toBe("capturing");
        expect((yield* browser.initialPage.describe()).targetId).toBeDefined();
        expect((yield* sibling.stop).nativeStop).toBe("confirmed");
        expect((yield* browser.closeChecked).issues).toEqual([]);
      }),
    ).pipe(Effect.provide(f.layer));
  }),
);

it.effect("provider checked cleanup records an unconfirmed observation socket close", () =>
  Effect.gen(function* () {
    const f = yield* fixture();

    f.configure((socket) => {
      socket.confirmClose = false;
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const browser = yield* BrowserbaseBrowser.open(policy);
        const capture = yield* Capture.start(browser.initialPage);

        yield* capture.stop;
        const closing = yield* browser.closeChecked.pipe(Effect.forkScoped);

        yield* TestClock.adjust(1600);
        expect((yield* Fiber.join(closing).pipe(Effect.flip)).reason._tag).toBe("Provider");
        expect(yield* browser.cleanupResult).toMatchObject({
          value: { issues: [{ step: "capture", reason: "failed" }], remote: "confirmed" },
        });
      }),
    ).pipe(Effect.provide(f.layer));
    expect((yield* f.provider.sessions)[0]?.releaseRequests).toBe(1);
  }),
);

it.effect("closing during endpoint resolution prevents a late observation connection", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const routing = yield* Deferred.make<void>();
      const resolved = yield* Deferred.make<string>();
      let opened = 0;

      const observation = yield* makeObservation({
        connection: () => Effect.succeed(Redacted.make("wss://scripted.invalid")),
        resolve: () =>
          Deferred.succeed(routing, undefined).pipe(Effect.andThen(Deferred.await(resolved))),
        constructor: () => {
          opened++;

          return new ScriptedSocket();
        },
        deadline: Infinity,
      });

      const options: CaptureStart = {
        quality: 70,
        receive: () => {},
        invalidate: () => {},
        fail: () => {},
      };

      const start = yield* observation
        .source({ pageId: "page", targetId: "target" })
        .start(options)
        .pipe(Effect.forkScoped);

      yield* Deferred.await(routing);
      yield* observation.close;
      yield* Deferred.succeed(resolved, "wss://scripted.invalid");
      expect((yield* Fiber.join(start).pipe(Effect.flip)).reason._tag).toBe("Closed");
      expect(opened).toBe(0);
    }),
  ),
);

it.effect("an immediate observation detach remains known when attachment setup yields", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const socket = new ScriptedSocket();
      const failures: string[] = [];

      socket.detachOnAttach = true;
      socket.rejected.add("Page.enable");
      socket.rejected.add("Page.stopScreencast");
      socket.rejected.add("Target.detachFromTarget");

      const observation = yield* makeObservation({
        connection: () => Effect.succeed(Redacted.make("wss://scripted.invalid")),
        resolve: () => Effect.succeed("wss://scripted.invalid"),
        constructor: () => socket,
        deadline: Infinity,
      });

      const source = observation.source({ pageId: "page", targetId: "target" });

      const start = yield* source
        .start({
          quality: 70,
          receive: () => {},
          invalidate: () => {},
          fail: (error) => {
            failures.push(error.reason._tag);
          },
        })
        .pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 32), Effect.result);

      expect(start._tag).toBe("Failure");
      expect(failures).toEqual(["Disconnected"]);
      expect((yield* source.stop.pipe(Effect.result))._tag).toBe("Success");
      expect(socket.commands.map((command) => command.method)).not.toContain(
        "Target.detachFromTarget",
      );
    }),
  ),
);
