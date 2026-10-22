import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Stream } from "effect";

import * as Chromium from "../src/providers/Chromium.ts";
import { Site, SiteLayer } from "./fixtures.ts";
import * as TestCdp from "./support/TestCdp.ts";

it.live("keeps a popup registration alive when its input caller is interrupted", () =>
  TestCdp.isolated((faults) =>
    Effect.gen(function* () {
      const browser = yield* Chromium.open();
      const opener = yield* browser.firstPage;

      yield* opener.goto((yield* Site).url("/form"));
      const [link] = yield* opener.find({ role: "link", name: "Open in a new tab" });
      const gate = yield* Deferred.make<void>();
      const baseline = faults.calls.filter((call) => call.method === "$open").length;

      yield* Effect.addFinalizer(() => Deferred.succeed(gate, undefined));
      faults.rule({ method: "$open" }, { _tag: "Hold", gate }, { times: 1 });
      const clicking = yield* opener.click(link?.ref ?? "").pipe(Effect.forkChild);

      yield* faults.waitUntil(
        (calls) => calls.filter((call) => call.method === "$open").length > baseline,
      );
      yield* Fiber.interrupt(clicking);
      assert.strictEqual((yield* browser.pages).length, 1);
      yield* Deferred.succeed(gate, undefined);
      yield* browser.events({ after: 0 }).pipe(
        Stream.filter(({ event }) => event._tag === "PageOpened"),
        Stream.take(2),
        Stream.runDrain,
        Effect.timeout("2 seconds"),
      );
      assert.strictEqual((yield* browser.pages).length, 2);
      assert.strictEqual(
        faults.calls.filter((call) => call.method === "$open").length - baseline,
        1,
      );
      assert.isFalse((yield* browser.recentEvents).some((event) => event._tag === "PageUntracked"));
    }).pipe(Effect.scoped, Effect.provide(SiteLayer)),
  ),
);

it.live("cleans a canceled newPage allocation without canceling another registration", () =>
  TestCdp.isolated((faults) =>
    Effect.gen(function* () {
      const browser = yield* Chromium.open();

      yield* browser.firstPage;
      const context = TestCdp.nativeContext(browser);
      const gate = yield* Deferred.make<void>();
      const baseline = faults.calls.filter((call) => call.method === "$open").length;

      yield* Effect.addFinalizer(() => Deferred.succeed(gate, undefined));
      faults.rule({ method: "$open" }, { _tag: "Hold", gate }, { times: 1 });
      const creating = yield* browser.newPage().pipe(Effect.forkChild);

      yield* faults.waitUntil(
        (calls) => calls.filter((call) => call.method === "$open").length > baseline,
      );
      // Let native allocation settle before interrupting the caller awaiting registration.
      // The context page event precedes context.newPage's own promise resolution.
      yield* Effect.promise(() => context.pages().at(-1)!.title());
      yield* Fiber.interrupt(creating);
      assert.strictEqual(context.pages().length, 1);
      const survivor = yield* browser.newPage().pipe(Effect.timeout("2 seconds"));

      yield* Deferred.succeed(gate, undefined);
      assert.strictEqual((yield* browser.pages).length, 2);
      assert.isTrue((yield* browser.pages).some((page) => page.id === survivor.id));
      assert.isFalse((yield* browser.recentEvents).some((event) => event._tag === "Disconnected"));
    }).pipe(Effect.scoped),
  ),
);
