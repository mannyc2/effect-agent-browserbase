// Confirmation proves a delivered frame is still current across a transport round trip. Local
// Chromium separately proves the page's own session must answer, even when capture sync is empty.
import { assert, it, layer } from "@effect/vitest";
import { Clock, Deferred, Duration, Effect, Fiber, Option, Schedule, Stream } from "effect";
import type { CDPSession } from "playwright-core";

import { Browser, make as makeBrowser } from "../src/Browser.ts";
import { BrowserError, Closed } from "../src/BrowserError.ts";
import * as Chromium from "../src/Chromium.ts";
import type { Frame } from "../src/Frame.ts";
import { internalsOf } from "../src/internal/page/page.ts";
import * as Capture from "../src/internal/pictures/capture.ts";
import type { NativeFrame, Transport } from "../src/internal/pictures/transport.ts";

const eventually = (check: Effect.Effect<boolean>) =>
  check.pipe(
    Effect.repeat({ until: Boolean, schedule: Schedule.spaced("5 millis") }),
    Effect.timeout("5 seconds"),
  );

const transport = Effect.fnUntraced(function* () {
  const clock = yield* Clock.Clock;
  let listening: Parameters<Transport["listen"]>[0] | undefined;
  let document = 1;
  let timestamp = 0;
  let acknowledgement = Promise.resolve();
  let synchronize = () => Promise.resolve();

  const failed = new BrowserError({
    operation: "screencast",
    reason: new Closed({ cause: "connection" }),
    dispatched: false,
  });

  const controller = yield* Capture.make({
    id: "page",
    clock,
    transport: Effect.sync(() => ({
      start: () => Promise.resolve(),
      acknowledge: () => acknowledgement,
      stop: () => Promise.resolve(),
      sync: () => synchronize(),
      listen: (on) => {
        listening = on;

        return () => {
          if (listening === on) listening = undefined;
        };
      },
      frameTag: () => ({
        session: "session",
        connection: "fixture-connection",
        document,
        url: "https://fixture.test",
      }),
    })),
    calibrate: Effect.succeed({
      offsetMillis: 0,
      uncertaintyMillis: 0,
      roundTripMillis: 0,
      sampledAt: 0,
    }),
    latest: () => undefined,
    renew: Effect.void,
    watch: Effect.void,
    frameHistory: Duration.seconds(5),
    viewport: Effect.succeed({ width: 1, height: 1 }),
    imageSize: () => ({ width: 1, height: 1 }),
    error: () => failed,
  });

  const emit = () =>
    listening?.frame({
      data: "AA==",
      sessionId: ++timestamp,
      metadata: { timestamp, deviceWidth: 1, deviceHeight: 1 },
    });

  const current = controller.latest.pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.die("no current frame"),
        onSome: Effect.succeed,
      }),
    ),
  );

  return {
    controller,
    current,
    emit,
    start: controller.stream().pipe(Stream.runDrain, Effect.forkScoped),
    commit: () => {
      document += 1;
    },
    lose: () => listening?.lost(failed),
    holdAck: (reply: Promise<void>) => {
      acknowledgement = reply;
    },
    onSync: (run: () => Promise<void>) => {
      synchronize = run;
    },
  };
});

it.live(
  "refuses changed documents, newer frames, pending acknowledgements and stopped captures",
  () =>
    Effect.gen(function* () {
      const fixture = yield* transport();
      const reader = yield* fixture.start;

      yield* eventually(fixture.controller.active);
      fixture.emit();
      yield* Effect.promise(() => Promise.resolve());
      const first = yield* fixture.current;

      assert.isTrue(fixture.controller.current(first));
      assert.isTrue(yield* fixture.controller.confirm(first));
      fixture.onSync(() => {
        fixture.commit();

        return Promise.resolve();
      });
      assert.isFalse(yield* fixture.controller.confirm(first));
      assert.isFalse(fixture.controller.current(first));
      fixture.onSync(() => Promise.resolve());
      const ack = Promise.withResolvers<void>();

      fixture.holdAck(ack.promise);
      fixture.emit();
      const latest = yield* fixture.current;

      assert.isTrue(fixture.controller.current(latest));
      assert.isFalse(yield* fixture.controller.confirm(first));
      assert.isFalse(yield* fixture.controller.confirm(latest));
      ack.resolve();
      yield* Effect.promise(() => Promise.resolve());
      assert.isTrue(yield* fixture.controller.confirm(latest));
      yield* Fiber.interrupt(reader);
      assert.isFalse(yield* fixture.controller.confirm(latest));
    }),
);

it.live("refuses a capture replaced while its confirmation was in flight", () =>
  Effect.gen(function* () {
    const fixture = yield* transport();
    const reader = yield* fixture.start;

    yield* eventually(fixture.controller.active);
    fixture.emit();
    yield* Effect.promise(() => Promise.resolve());
    const old = yield* fixture.current;
    const sent = yield* Deferred.make<void>();
    const reply = Promise.withResolvers<void>();

    fixture.onSync(() => {
      Deferred.doneUnsafe(sent, Effect.void);

      return reply.promise;
    });
    const confirming = yield* fixture.controller.confirm(old).pipe(Effect.forkChild);

    yield* Deferred.await(sent);
    yield* Fiber.interrupt(reader);
    yield* fixture.start;
    yield* eventually(fixture.controller.active);
    fixture.emit();
    reply.resolve();
    assert.isFalse(yield* Fiber.join(confirming));
  }),
);

it.live("never confirms a capture that loses its transport during the round trip", () =>
  Effect.gen(function* () {
    const fixture = yield* transport();

    yield* fixture.start;
    yield* eventually(fixture.controller.active);
    fixture.emit();
    yield* Effect.promise(() => Promise.resolve());
    const frame = yield* fixture.current;

    fixture.onSync(() => {
      fixture.lose();

      assert.isFalse(fixture.controller.current(frame));

      return Promise.resolve();
    });
    assert.isFalse(yield* fixture.controller.confirm(frame));
  }),
);

const nativeFixture = Effect.fnUntraced(function* () {
  const native = (yield* Browser).context.browser();

  if (native === null) return yield* Effect.die("local Chromium is required");

  const context = yield* Effect.acquireRelease(
    Effect.promise(() => native.newContext()),
    (context) => Effect.promise(() => context.close()),
  );

  const create = context.newCDPSession.bind(context);
  const calls: Array<string> = [];
  let hold: Promise<void> | undefined;
  let withholding = false;
  let withheld: NativeFrame | undefined;
  let inject: ((frame: NativeFrame) => void) | undefined;

  context.newCDPSession = async (target) => {
    const cdp = await create(target);
    const send = cdp.send.bind(cdp);

    const emitter = cdp as CDPSession & {
      emit(event: string, ...args: ReadonlyArray<unknown>): boolean;
    };

    const emit = emitter.emit.bind(emitter);

    emitter.emit = (event, ...args) => {
      if (event === "Page.screencastFrame" && withholding) {
        withheld = args[0] as NativeFrame;

        return true;
      }

      return emit(event, ...args);
    };
    inject = (frame) => {
      emit("Page.screencastFrame", frame);
    };

    const observed: CDPSession["send"] = (method, params) => {
      calls.push(method);
      const reply = send(method, params);

      return method === "Page.getFrameTree" && hold !== undefined
        ? reply.then((value) => hold!.then(() => value))
        : reply;
    };

    cdp.send = observed;

    return cdp;
  };
  const browser = yield* makeBrowser(context, { id: "shown", provider: "local" });
  const page = yield* browser.newPage("data:text/html,<h1>Quiet frame</h1>");
  const internals = internalsOf(page);

  if (internals === undefined) return yield* Effect.die("missing page internals");
  let latest: Frame | undefined;

  yield* page.screencast().pipe(
    Stream.runForEach((frame) =>
      Effect.sync(() => {
        latest = frame;
      }),
    ),
    Effect.forkScoped,
  );
  yield* eventually(Effect.sync(() => latest !== undefined));
  yield* Effect.sleep("100 millis");

  return {
    page,
    internals,
    calls,
    latest: () => latest!,
    withhold: () => {
      withholding = true;
    },
    withheld: () => withheld,
    inject: (frame: NativeFrame) => inject?.(frame),
    hold: (reply: Promise<void>) => {
      hold = reply;
    },
  };
});

layer(Chromium.layer(), { excludeTestServices: true })("native shown-frame confirmation", (it) => {
  it.effect("joins a quiet capture with its current image and no duplicate stream frame", () =>
    Effect.gen(function* () {
      const fixture = yield* nativeFixture();
      const joined = yield* fixture.internals.capture();

      assert.isTrue(joined.current === fixture.latest());
      const next = yield* joined.stream.pipe(Stream.runHead, Effect.forkChild);

      yield* Effect.promise(() =>
        fixture.page.playwright.evaluate(() => {
          document.body.style.background = "blue";
        }),
      );
      const frame = Option.getOrThrow(yield* Fiber.join(next).pipe(Effect.timeout("2 seconds")));

      assert.notStrictEqual(frame, joined.current);
    }),
  );
  it.effect("refuses delayed old paint even when its arrival carries the new document tag", () =>
    Effect.gen(function* () {
      const fixture = yield* nativeFixture();
      const before = fixture.latest().document;

      fixture.withhold();
      yield* Effect.promise(() =>
        fixture.page.playwright.evaluate(() => {
          document.body.style.background = "red";
        }),
      );
      yield* eventually(Effect.sync(() => fixture.withheld() !== undefined));
      const oldPaint = fixture.withheld()!;

      yield* fixture.page.goto("data:text/html,<h1>New document</h1>");
      fixture.inject(oldPaint);
      yield* eventually(Effect.sync(() => fixture.latest().document > before));
      assert.isFalse(fixture.internals.current(fixture.latest()));
      assert.isFalse(yield* fixture.internals.confirm(fixture.latest()));
    }),
  );
  it.effect("asks the live page even when its capture transport sync is a no-op", () =>
    Effect.gen(function* () {
      const fixture = yield* nativeFixture();
      const before = fixture.calls.filter((method) => method === "Page.getFrameTree").length;

      assert.isTrue(yield* fixture.internals.confirm(fixture.latest()));
      assert.strictEqual(
        fixture.calls.filter((method) => method === "Page.getFrameTree").length,
        before + 1,
      );
      const old = fixture.latest();

      yield* fixture.page.goto("data:text/html,<h1>Another document</h1>");
      assert.isFalse(yield* fixture.internals.confirm(old));
    }),
  );
  it.effect("bounds missing live-page replies and fails after the page closes", () =>
    Effect.gen(function* () {
      const fixture = yield* nativeFixture();
      const reply = Promise.withResolvers<void>();

      yield* Effect.addFinalizer(() => Effect.sync(() => reply.resolve()));
      fixture.hold(reply.promise);
      const error = yield* fixture.internals.confirm(fixture.latest()).pipe(Effect.flip);

      assert.strictEqual(error.reason._tag, "Timeout");
      reply.resolve();
      yield* fixture.page.close;
      const closed = yield* fixture.internals.confirm(fixture.latest()).pipe(Effect.flip);

      assert.strictEqual(closed.reason._tag, "Closed");
    }),
  );
});
