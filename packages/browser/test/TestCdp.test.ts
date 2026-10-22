import { EventEmitter } from "node:events";

// The fault seam is scoped; timing uses TestClock and injected events never patch a platform object.
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import type { CDPSession } from "playwright-core";

import * as Port from "../src/internal/page/port.ts";
import * as TestCdp from "./support/TestCdp.ts";

const nativeSession = () =>
  Object.assign(new EventEmitter(), {
    send: async (method: string) =>
      method === "Target.getTargetInfo"
        ? { targetInfo: { targetId: "target" } }
        : { product: "native" },
    detach: () => Promise.resolve(),
  });

it.effect("creation faults are owned and do not call the native factory", () =>
  Effect.gen(function* () {
    const faults = yield* TestCdp.make();
    let created = false;

    faults.rule({ method: "$open" }, { _tag: "Fail", error: new Error("session creation fault") });

    const error = yield* faults
      .provide(
        Port.openSession(() => {
          created = true;

          return Promise.resolve(nativeSession() as unknown as CDPSession);
        }),
      )
      .pipe(Effect.flip);

    assert.isFalse(created);
    assert.strictEqual(error.reason._tag, "Failed");
  }),
);

it.effect("command delay, hold, transform and dropped replies have deterministic bounds", () =>
  Effect.gen(function* () {
    const faults = yield* TestCdp.make();
    const native = nativeSession();

    const session = yield* faults.provide(
      Port.openSession(() => Promise.resolve(native as unknown as CDPSession)),
    );

    yield* Effect.promise(() => session.send("Target.getTargetInfo"));
    const gate = yield* Deferred.make<void>();

    faults.rule(
      { page: "target", method: "Browser.getVersion" },
      { _tag: "Delay", duration: "200 millis" },
      { times: 1 },
    );
    faults.rule(
      { page: "target", method: "Browser.getVersion" },
      { _tag: "Hold", gate },
      { times: 1 },
    );
    faults.rule(
      { page: "target", method: "Browser.getVersion" },
      { _tag: "Transform", reply: () => ({ product: "transformed" }) },
      { phase: "after", times: 1 },
    );

    const request = yield* Effect.promise(() => session.send("Browser.getVersion")).pipe(
      Effect.forkChild,
    );

    yield* faults.waitUntil((calls) => calls.some(({ method }) => method === "Browser.getVersion"));
    yield* TestClock.adjust("200 millis");
    assert.isUndefined(request.pollUnsafe());
    yield* Deferred.succeed(gate, undefined);
    assert.strictEqual((yield* Fiber.join(request)).product, "transformed");
    faults.rule({ method: "Browser.getVersion" }, { _tag: "Drop" });

    const missing = yield* Effect.promise(() => session.send("Browser.getVersion")).pipe(
      Effect.forkChild,
    );

    yield* faults.waitUntil(
      (calls) => calls.filter(({ method }) => method === "Browser.getVersion").length === 2,
    );
    assert.isUndefined(missing.pollUnsafe());
    yield* Fiber.interrupt(missing);
  }),
);

it.effect("events can be transformed, delayed, dropped and injected by session", () =>
  Effect.gen(function* () {
    const faults = yield* TestCdp.make();
    const native = nativeSession();

    const session = yield* faults.provide(
      Port.openSession(() => Promise.resolve(native as unknown as CDPSession)),
    );

    yield* Effect.promise(() => session.send("Target.getTargetInfo"));
    const seen: Array<unknown> = [];

    session.on("Page.frameNavigated", (event) => {
      seen.push(event);
    });
    faults.rule(
      { page: "target", method: "Page.frameNavigated" },
      { _tag: "Delay", duration: "200 millis" },
      { phase: "event", times: 1 },
    );
    faults.rule(
      { page: "target", method: "Page.frameNavigated" },
      { _tag: "Transform", reply: () => ({ frame: { id: "changed" } }) },
      { phase: "event", times: 1 },
    );
    native.emit("Page.frameNavigated", { frame: { id: "original" } });
    yield* TestClock.adjust("200 millis");
    yield* Effect.yieldNow;
    assert.deepStrictEqual(seen, [{ frame: { id: "changed" } }]);
    faults.rule({ method: "Page.frameNavigated" }, { _tag: "Drop" }, { phase: "event" });
    native.emit("Page.frameNavigated", { frame: { id: "dropped" } });
    yield* faults.inject(
      { page: "target" },
      { method: "Page.frameNavigated", params: { frame: { id: "injected" } } },
    );
    assert.deepStrictEqual(seen.at(-1), { frame: { id: "injected" } });
  }),
);

it.effect("browser ownership queries never acquire page-scoped fault rules", () =>
  Effect.gen(function* () {
    const faults = yield* TestCdp.make();

    const session = yield* faults.provide(
      Port.openSession(
        () => Promise.resolve(nativeSession() as unknown as CDPSession),
        undefined,
        "browser",
      ),
    );

    yield* Effect.promise(() => session.send("Target.getTargetInfo", { targetId: "target" }));
    faults.rule(
      { channel: "browser", page: "target", method: "Browser.getVersion" },
      { _tag: "Reply", value: { product: "wrong page rule" } },
    );
    assert.strictEqual(
      (yield* Effect.promise(() => session.send("Browser.getVersion"))).product,
      "native",
    );
    const browserCalls = faults.calls.filter((call) => call.session.channel === "browser");

    assert.isTrue(browserCalls.every((call) => call.session.page === undefined));
  }),
);
