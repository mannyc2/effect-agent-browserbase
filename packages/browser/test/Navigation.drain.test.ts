// HIGH-1 (beta9–beta11): document waits retained input authority after their caller timed out.
// A real server leaves navigation unanswered; Chromium must still admit corrective work and cuts.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Result } from "effect";

import * as Stage from "../src/presentation/Stage.ts";
import * as Chromium from "../src/providers/Chromium.ts";
import * as TestCdp from "./support/TestCdp.ts";

const site = Effect.acquireRelease(
  Effect.callback<{ readonly url: string; readonly close: () => void }>((resume) => {
    const server = createServer((request, response) => {
      if (request.url === "/hang") return;
      response.end(
        '<a href="/hang">Hang</a><button style="display:block;margin-top:40px" onclick="this.textContent=\'Clicked\'">Continue</button>',
      );
    });

    server.listen(0, "127.0.0.1", () =>
      resume(
        Effect.succeed({
          url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
          close: () => {
            server.closeAllConnections();
            server.close();
          },
        }),
      ),
    );
  }),
  ({ close }) => Effect.sync(close),
);

it.live("a timed-out navigation permits correction, browser suspension and an output cut", () =>
  TestCdp.withCdp(
    Effect.gen(function* () {
      const { url } = yield* site;

      const browser = yield* Chromium.open({
        actionTimeout: "300 millis",
        navigationTimeout: "300 millis",
      });

      const stuck = yield* browser.newPage(url);
      const next = yield* browser.newPage("data:text/html,<h1>Next</h1>");
      const stage = yield* Stage.make();

      yield* stage.present(stuck);
      const cue = yield* stage.cue(next);

      yield* cue.ready;
      const navigation = yield* stuck.goto(`${url}/hang`).pipe(Effect.flip);

      assert.strictEqual(navigation.reason._tag, "Timeout");
      assert.isTrue(navigation.dispatched);

      const suspension = yield* browser
        .suspend({ drain: "200 millis" })
        .pipe(Effect.scoped, Effect.asVoid, Effect.result);

      const cut = yield* cue.commit().pipe(Effect.asVoid, Effect.result);
      const correction = yield* stuck.goto("data:text/html,<h1>Recovered</h1>").pipe(Effect.result);

      assert.deepStrictEqual(
        [suspension, cut, correction].map((outcome) =>
          Result.isSuccess(outcome) ? "ok" : outcome.failure.reason._tag,
        ),
        ["ok", "ok", "ok"],
      );
      assert.include(TestCdp.nativePage(stuck).url(), "Recovered");
    }).pipe(Effect.scoped),
  ),
);

it.live("a link's unanswered settling read does not retain input authority", () =>
  TestCdp.withCdp(
    Effect.gen(function* () {
      const { url } = yield* site;

      // Leave time for the native input to reach its settling read under load. The held-reply
      // regression below exercises the earlier deadline during input acknowledgement.
      const browser = yield* Chromium.open({ actionTimeout: "2 seconds" });

      const page = yield* browser.newPage(url);
      const [link] = yield* page.find({ role: "link", name: "Hang" });
      const [button] = yield* page.find({ role: "button", name: "Continue" });
      const clicked = yield* page.click(link!.ref).pipe(Effect.result);

      if (Result.isFailure(clicked)) assert.isTrue(clicked.failure.dispatched);

      const suspension = yield* browser
        .suspend({ drain: "200 millis" })
        .pipe(Effect.scoped, Effect.result);

      const continued = yield* page.click(button!.ref).pipe(Effect.result);

      assert.isTrue(Result.isSuccess(suspension));
      assert.isTrue(Result.isSuccess(continued) || continued.failure.dispatched);
      assert.strictEqual(
        yield* Effect.promise(() => TestCdp.nativePage(page).locator("button").textContent()),
        "Clicked",
      );
    }).pipe(Effect.scoped),
  ),
);

it.live("a refused history traversal sends no stop-loading mutation", () =>
  TestCdp.withCdp(
    Effect.gen(function* () {
      const faults = yield* TestCdp.make();
      const browser = yield* faults.provide(Chromium.open());
      const page = yield* browser.newPage();
      const error = yield* page.back.pipe(Effect.flip);

      assert.strictEqual(error.reason._tag, "NotFound");
      assert.isFalse(error.dispatched);
      assert.strictEqual(
        faults.calls.filter(({ method }) => method === "Page.stopLoading").length,
        0,
      );
    }).pipe(Effect.scoped),
  ),
);

// 98077ec only stopped a link's navigation after its settling read began. A held input reply
// forces the earlier deadline without depending on machine load, and preserves real Chromium.
it.live(
  "stops interrupted input's navigation after acknowledgement and retains cleanup authority",
  () =>
    TestCdp.withCdp(
      Effect.gen(function* () {
        const { url } = yield* site;

        const faults = yield* TestCdp.make();

        const browser = yield* faults.provide(
          Chromium.open({ actionTimeout: "2 seconds", navigationTimeout: "200 millis" }),
        );

        const arrived = Promise.withResolvers<void>();
        const ackGate = yield* Deferred.make<void>();
        const stopGate = yield* Deferred.make<void>();
        const acknowledge = { resolve: () => Deferred.doneUnsafe(ackGate, Effect.void) };
        const stopReply = { resolve: () => Deferred.doneUnsafe(stopGate, Effect.void) };
        let releases = 0;
        let stops = 0;

        faults.rule(
          { method: "Input.dispatchMouseEvent", params: { type: "mouseReleased" } },
          { _tag: "Hold", gate: ackGate },
          { phase: "after" },
        );
        faults.rule(
          { method: "Page.stopLoading" },
          { _tag: "Hold", gate: stopGate },
          { phase: "after" },
        );
        faults.observe((call, phase) => {
          if (phase !== "received") return;
          if (call.method === "Page.stopLoading") stops++;
          if (
            call.method === "Input.dispatchMouseEvent" &&
            (call.params as { type?: string }).type === "mouseReleased"
          ) {
            releases++;
            arrived.resolve();
          }
        });
        yield* Effect.addFinalizer(() =>
          Deferred.succeed(ackGate, undefined).pipe(
            Effect.andThen(Deferred.succeed(stopGate, undefined)),
          ),
        );
        const page = yield* browser.newPage(url);
        const [link] = yield* page.find({ role: "link", name: "Hang" });
        const clicking = yield* page.click(link!.ref).pipe(Effect.flip, Effect.forkChild);

        yield* Effect.promise(() => arrived.promise);
        const error = yield* Fiber.join(clicking);

        const pending = yield* browser
          .suspend({ drain: "40 millis" })
          .pipe(Effect.scoped, Effect.flip);

        assert.strictEqual(error.reason._tag, "Timeout");
        assert.isTrue(error.dispatched);
        assert.strictEqual(pending.reason._tag, "Busy");
        assert.strictEqual(stops, 0, "stop must follow the actual input acknowledgement");
        acknowledge.resolve();
        // A bounded read can only finish once cleanup has stopped the unanswered navigation.
        const readable = yield* page.text().pipe(Effect.result);

        const cleaning = yield* browser
          .suspend({ drain: "40 millis" })
          .pipe(Effect.scoped, Effect.result);

        stopReply.resolve();
        assert.isTrue(
          Result.isSuccess(readable),
          "acknowledged input must leave the page readable",
        );
        assert.isTrue(Result.isFailure(cleaning) && cleaning.failure.reason._tag === "Busy");
        assert.strictEqual(stops, 1);
        assert.strictEqual(releases, 1, "interrupted input must never be replayed");
        yield* browser.suspend({ drain: "200 millis" }).pipe(Effect.scoped);
      }).pipe(Effect.scoped),
    ),
);

it.live("bounds a missing stop reply without surrendering its input authority", () =>
  TestCdp.withCdp(
    Effect.gen(function* () {
      const { url } = yield* site;
      const faults = yield* TestCdp.make();
      const browser = yield* faults.provide(Chromium.open({ navigationTimeout: "200 millis" }));
      const sent = Promise.withResolvers<void>();
      const gate = yield* Deferred.make<void>();
      const reply = { resolve: () => Deferred.doneUnsafe(gate, Effect.void) };

      faults.rule({ method: "Page.stopLoading" }, { _tag: "Hold", gate }, { phase: "after" });
      faults.observe((call, phase) => {
        if (phase === "received" && call.method === "Page.stopLoading") sent.resolve();
      });
      yield* Effect.addFinalizer(() => Deferred.succeed(gate, undefined));
      const page = yield* browser.newPage(url);
      const navigation = yield* page.goto(`${url}/hang`).pipe(Effect.flip, Effect.forkChild);

      yield* Effect.promise(() => sent.promise);
      yield* Effect.sleep("400 millis");
      const ended = navigation.pollUnsafe();
      const held = yield* browser.suspend({ drain: "40 millis" }).pipe(Effect.scoped, Effect.flip);

      // Always release before asserting, so the deliberately broken implementation can clean up.
      reply.resolve();
      const error = yield* Fiber.join(navigation);

      assert.isDefined(ended, "the original timeout must return despite a missing cleanup reply");
      assert.strictEqual(error.reason._tag, "Timeout");
      assert.isTrue(error.dispatched);
      assert.strictEqual(held.reason._tag, "Busy");
      yield* browser.suspend({ drain: "200 millis" }).pipe(Effect.scoped);
    }).pipe(Effect.scoped),
  ),
);
