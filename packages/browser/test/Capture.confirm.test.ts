// Confirmation proves a delivered frame is still current across a transport round trip. Local
// Chromium separately proves the page's own session must answer, even when capture sync is empty.
import { assert, it, layer } from "@effect/vitest";
import { Clock, Deferred, Duration, Effect, Fiber, Option, Schedule, Stream } from "effect";

import { Browser } from "../src/Browser.ts";
import { BrowserError, Closed } from "../src/BrowserError.ts";
import type { Frame } from "../src/Frame.ts";
import * as Capture from "../src/internal/pictures/capture.ts";
import type { NativeFrame, Transport } from "../src/internal/pictures/transport.ts";
import * as Chromium from "../src/providers/Chromium.ts";
import * as TestCdp from "./support/TestCdp.ts";

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
    restore: () => Promise.resolve(),
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
    TestCdp.withCdp(
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
    ),
);

it.live("refuses a capture replaced while its confirmation was in flight", () =>
  TestCdp.withCdp(
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
  ),
);

it.live("never confirms a capture that loses its transport during the round trip", () =>
  TestCdp.withCdp(
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
  ),
);

const nativeFixture = Effect.fnUntraced(function* () {
  const faults = yield* TestCdp.TestCdp;
  const browser = yield* Browser;
  const page = yield* faults.provide(browser.newPage("data:text/html,<h1>Quiet frame</h1>"));
  const capture = yield* page.capture();
  let withheld: NativeFrame | undefined;
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
    capture,
    calls: faults.calls,
    latest: () => latest!,
    withhold: () => {
      faults.rule(
        { page: page.id, method: "Page.screencastFrame" },
        {
          _tag: "Transform",
          reply: (frame) => {
            withheld = frame as NativeFrame;

            return frame;
          },
        },
        { phase: "event" },
      );
      faults.rule(
        { page: page.id, method: "Page.screencastFrame" },
        { _tag: "Drop" },
        { phase: "event" },
      );
    },
    withheld: () => withheld,
    inject: (frame: NativeFrame) =>
      faults.inject({ page: page.id }, { method: "Page.screencastFrame", params: frame }),
    hold: (gate: Deferred.Deferred<void>) =>
      faults.rule(
        { page: page.id, method: "Page.getFrameTree" },
        { _tag: "Hold", gate },
        { phase: "after" },
      ),
  };
});

layer(TestCdp.provideLayer(Chromium.layer()), { excludeTestServices: true })(
  "native shown-frame confirmation",
  (it) => {
    it.effect("joins a quiet capture with its current image and no duplicate stream frame", () =>
      TestCdp.withCdp(
        Effect.gen(function* () {
          const fixture = yield* nativeFixture();
          const joined = yield* fixture.page.capture();

          assert.isTrue(joined.current === fixture.latest());
          const next = yield* joined.stream.pipe(Stream.runHead, Effect.forkChild);

          yield* Effect.promise(() =>
            TestCdp.nativePage(fixture.page).evaluate(() => {
              document.body.style.background = "blue";
            }),
          );

          const frame = Option.getOrThrow(
            yield* Fiber.join(next).pipe(Effect.timeout("2 seconds")),
          );

          assert.notStrictEqual(frame, joined.current);
        }),
      ),
    );
    it.effect("refuses delayed old paint even when its arrival carries the new document tag", () =>
      TestCdp.withCdp(
        Effect.gen(function* () {
          const fixture = yield* nativeFixture();
          const before = fixture.latest().document;

          fixture.withhold();
          yield* Effect.promise(() =>
            TestCdp.nativePage(fixture.page).evaluate(() => {
              document.body.style.background = "red";
            }),
          );
          yield* eventually(Effect.sync(() => fixture.withheld() !== undefined));
          const oldPaint = fixture.withheld()!;

          yield* fixture.page.goto("data:text/html,<h1>New document</h1>");
          yield* fixture.inject(oldPaint);
          yield* eventually(Effect.sync(() => fixture.latest().document > before));
          assert.isFalse(fixture.capture.isCurrent(fixture.latest()));
          assert.isFalse(yield* fixture.capture.confirm(fixture.latest()));
        }),
      ),
    );
    it.effect("asks the live page even when its capture transport sync is a no-op", () =>
      TestCdp.withCdp(
        Effect.gen(function* () {
          const fixture = yield* nativeFixture();

          const before = fixture.calls.filter(
            ({ method }) => method === "Page.getFrameTree",
          ).length;

          assert.isTrue(yield* fixture.capture.confirm(fixture.latest()));
          assert.strictEqual(
            fixture.calls.filter(({ method }) => method === "Page.getFrameTree").length,
            before + 1,
          );
          const old = fixture.latest();

          yield* fixture.page.goto("data:text/html,<h1>Another document</h1>");
          assert.isFalse(yield* fixture.capture.confirm(old));
        }),
      ),
    );
    it.effect("bounds missing live-page replies and fails after the page closes", () =>
      TestCdp.withCdp(
        Effect.gen(function* () {
          const fixture = yield* nativeFixture();
          const reply = yield* Deferred.make<void>();

          yield* Effect.addFinalizer(() => Deferred.succeed(reply, undefined));
          fixture.hold(reply);
          const error = yield* fixture.capture.confirm(fixture.latest()).pipe(Effect.flip);

          assert.strictEqual(error.reason._tag, "Timeout");
          yield* Deferred.succeed(reply, undefined);
          yield* fixture.page.close;
          const closed = yield* fixture.capture.confirm(fixture.latest()).pipe(Effect.flip);

          assert.strictEqual(closed.reason._tag, "Closed");
        }),
      ),
    );
  },
);
