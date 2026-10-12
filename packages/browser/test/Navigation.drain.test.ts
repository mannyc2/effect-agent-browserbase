// HIGH-1 (beta9–beta11): document waits retained input authority after their caller timed out.
// A real server leaves navigation unanswered; Chromium must still admit corrective work and cuts.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { assert, it } from "@effect/vitest";
import { Effect, Fiber, Result } from "effect";

import * as Chromium from "../src/Chromium.ts";
import * as Stage from "../src/Stage.ts";

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
    assert.include(stuck.playwright.url(), "Recovered");
  }).pipe(Effect.scoped),
);

it.live("a link's unanswered settling read does not retain input authority", () =>
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
      yield* Effect.promise(() => page.playwright.locator("button").textContent()),
      "Clicked",
    );
  }).pipe(Effect.scoped),
);

it.live("a refused history traversal sends no stop-loading mutation", () =>
  Effect.gen(function* () {
    const browser = yield* Chromium.open();
    const create = browser.context.newCDPSession.bind(browser.context);
    let stops = 0;

    browser.context.newCDPSession = async (target) => {
      const session = await create(target);
      const send = session.send.bind(session);

      session.send = (method, params) => {
        if (method === "Page.stopLoading") stops++;

        return send(method, params);
      };

      return session;
    };
    const page = yield* browser.newPage();
    const error = yield* page.back.pipe(Effect.flip);

    assert.strictEqual(error.reason._tag, "NotFound");
    assert.isFalse(error.dispatched);
    assert.strictEqual(stops, 0);
  }).pipe(Effect.scoped),
);

// 98077ec only stopped a link's navigation after its settling read began. A held input reply
// forces the earlier deadline without depending on machine load, and preserves real Chromium.
it.live(
  "stops interrupted input's navigation after acknowledgement and retains cleanup authority",
  () =>
    Effect.gen(function* () {
      const { url } = yield* site;

      const browser = yield* Chromium.open({
        actionTimeout: "2 seconds",
        navigationTimeout: "200 millis",
      });

      const create = browser.context.newCDPSession.bind(browser.context);
      const arrived = Promise.withResolvers<void>();
      const acknowledge = Promise.withResolvers<void>();
      const stopReply = Promise.withResolvers<void>();
      let releases = 0;
      let stops = 0;

      browser.context.newCDPSession = async (target) => {
        const session = await create(target);
        const send = session.send.bind(session);

        session.send = (method, params) => {
          const reply = send(method, params);

          if (
            method === "Input.dispatchMouseEvent" &&
            params !== undefined &&
            "type" in params &&
            params.type === "mouseReleased"
          ) {
            releases++;

            return reply.then(async (value) => {
              arrived.resolve();
              await acknowledge.promise;

              return value;
            });
          }
          if (method === "Page.stopLoading") {
            stops++;

            return reply.then(async (value) => {
              await stopReply.promise;

              return value;
            });
          }

          return reply;
        };

        return session;
      };
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          acknowledge.resolve();
          stopReply.resolve();
          browser.context.newCDPSession = create;
        }),
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
      assert.isTrue(Result.isSuccess(readable), "acknowledged input must leave the page readable");
      assert.isTrue(Result.isFailure(cleaning) && cleaning.failure.reason._tag === "Busy");
      assert.strictEqual(stops, 1);
      assert.strictEqual(releases, 1, "interrupted input must never be replayed");
      yield* browser.suspend({ drain: "200 millis" }).pipe(Effect.scoped);
    }).pipe(Effect.scoped),
);

it.live("bounds a missing stop reply without surrendering its input authority", () =>
  Effect.gen(function* () {
    const { url } = yield* site;
    const browser = yield* Chromium.open({ navigationTimeout: "200 millis" });
    const create = browser.context.newCDPSession.bind(browser.context);
    const sent = Promise.withResolvers<void>();
    const reply = Promise.withResolvers<void>();

    browser.context.newCDPSession = async (target) => {
      const session = await create(target);
      const send = session.send.bind(session);

      session.send = (method, params) => {
        const response = send(method, params);

        return method === "Page.stopLoading"
          ? response.then(async (value) => {
              sent.resolve();
              await reply.promise;

              return value;
            })
          : response;
      };

      return session;
    };
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
);
