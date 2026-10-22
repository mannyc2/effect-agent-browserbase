// PLAN 9: idle ownership is the last host read, including later documents.
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";

import * as Chromium from "../src/providers/Chromium.ts";
import * as TestCdp from "./support/TestCdp.ts";

const html = (source: string) => `data:text/html,${encodeURIComponent(source)}`;

for (const overlap of ["none", "navigate", "cancel", "close"] as const)
  it.effect(
    overlap === "none"
      ? "expiry removes the recorder across documents, and a fresh read starts it again"
      : overlap === "close"
        ? "closing a page interrupts held recorder cleanup without deadlocking its scope"
        : `expiry keeps ${overlap === "cancel" ? "cancelled " : ""}navigation behind its native cleanup`,
    () =>
      Effect.gen(function* () {
        const faults = yield* TestCdp.make();
        const browser = yield* faults.provide(Chromium.open());

        const page = yield* faults.provide(
          browser.newPage(html('<div role="status" id="status">First</div>')),
        );

        yield* page.changes();
        yield* TestClock.adjust("119 seconds");
        yield* page.goto(html('<div role="status" id="status">Second</div>'));
        const release = yield* Deferred.make<void>();

        if (overlap !== "none")
          faults.rule(
            { page: page.id, method: "Page.removeScriptToEvaluateOnNewDocument" },
            { _tag: "Hold", gate: release },
          );
        yield* TestClock.adjust("2 seconds");
        assert.isTrue(
          faults.calls.some(({ method }) => method === "Page.removeScriptToEvaluateOnNewDocument"),
          "idle ownership must remove the future-document recorder registration",
        );
        if (overlap === "close") {
          yield* page.close;

          return;
        }
        const third = html('<div role="status" id="status">Third</div>');

        if (overlap !== "none") {
          const moving = yield* page.goto(third).pipe(Effect.forkScoped);

          yield* TestClock.adjust("1 milli");
          yield* Effect.gen(function* () {
            assert.isFalse(
              faults.calls.some(
                ({ method, params }) =>
                  method === "goto" &&
                  typeof params === "object" &&
                  params !== null &&
                  Reflect.get(params, "url") === third,
              ),
              "navigation must not cross recorder cleanup's native mutation",
            );
            if (overlap === "cancel") yield* Fiber.interrupt(moving);
          }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
          if (overlap === "cancel") yield* page.goto(third);
          else yield* Fiber.join(moving);
        } else yield* page.goto(third);
        yield* page.act(
          () => {
            document.querySelector("#status")!.textContent = "Before new read";
          },
          { arg: undefined, result: Schema.Void, document: (yield* page.state).document },
        );
        const resumed = yield* page.changes();

        assert.strictEqual(
          faults.calls.filter(({ method }) => method === "Page.removeScriptToEvaluateOnNewDocument")
            .length,
          1,
        );
        assert.deepStrictEqual(
          resumed.changes,
          [],
          "expired init registration must not record a later document",
        );
        yield* page.act(
          () => {
            document.querySelector("#status")!.textContent = "After new read";
          },
          { arg: undefined, result: Schema.Void, document: (yield* page.state).document },
        );
        const fresh = yield* page.changes({ since: resumed });

        assert.isTrue(fresh.changes.some((change) => change.after === "After new read"));
      }).pipe(Effect.scoped),
  );

// 1d6d7c7: an idle expiry waiting behind navigation permanently poisoned later reads.
it.effect("idle expiry waits for navigation and later changes renew the recorder", () =>
  Effect.gen(function* () {
    const faults = yield* TestCdp.make();

    const browser = yield* faults.provide(
      Chromium.open({ actionTimeout: "500 millis", navigationTimeout: "20 seconds" }),
    );

    const page = yield* faults.provide(browser.newPage(html("<title>First</title>")));

    yield* page.changes();
    yield* TestClock.adjust("119 seconds");
    const release = yield* Deferred.make<void>();

    faults.rule({ page: page.id, method: "goto" }, { _tag: "Hold", gate: release }, { times: 1 });
    const moving = yield* page.goto(html("<title>Second</title>")).pipe(Effect.forkScoped);

    yield* faults.waitUntil((calls) =>
      calls.some(
        ({ method, params }) =>
          method === "goto" &&
          typeof params === "object" &&
          params !== null &&
          Reflect.get(params, "url") === html("<title>Second</title>"),
      ),
    );
    yield* TestClock.adjust("2 seconds");
    assert.isFalse(
      faults.calls.some(({ method }) => method === "Page.removeScriptToEvaluateOnNewDocument"),
      "cleanup must not cross navigation's lane ownership",
    );
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(moving);
    yield* page.changes();

    const removed = faults.calls.filter(
      ({ method }) => method === "Page.removeScriptToEvaluateOnNewDocument",
    ).length;

    yield* TestClock.adjust("120 seconds");
    assert.strictEqual(
      faults.calls.filter(({ method }) => method === "Page.removeScriptToEvaluateOnNewDocument")
        .length,
      removed + 1,
      "a successful read must renew expiry even after the first idle deadline met navigation",
    );
    yield* page.changes();
  }).pipe(Effect.scoped),
);

// Preserve real cleanup failure evidence while fixing admission-only expiry failure.
it.effect("native recorder cleanup failure remains visible to later changes", () =>
  Effect.gen(function* () {
    const faults = yield* TestCdp.make();
    const browser = yield* faults.provide(Chromium.open());
    const page = yield* faults.provide(browser.newPage(html("<title>First</title>")));

    yield* page.changes();
    faults.rule(
      { page: page.id, method: "Page.removeScriptToEvaluateOnNewDocument" },
      { _tag: "Fail", error: new Error("recorder removal rejected") },
      { times: 1 },
    );
    yield* TestClock.adjust("121 seconds");
    const failure = yield* Effect.flip(page.changes());

    assert.strictEqual(failure.reason._tag, "Failed");
    assert.include(failure.message, "recorder removal rejected");
  }).pipe(Effect.scoped),
);
