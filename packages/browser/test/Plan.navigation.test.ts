// beta7 (63a1356) compared relative navigation with state from before readiness and arrival.
// An earlier fetch/redirect must not satisfy this step; native handlers use explicit handshakes.
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { assert, layer } from "@effect/vitest";
import { Deferred, Duration, Effect, Exit, Fiber } from "effect";

import { Browser } from "../src/Browser.ts";
import { Subject } from "../src/BrowserEvent.ts";
import * as Chromium from "../src/Chromium.ts";
import type { Page } from "../src/Page.ts";
import * as Plan from "../src/Plan.ts";

const named = (name: string) => new Subject({ role: "button", name, tag: "button", context: {} });

const fixture = Effect.fnUntraced(function* (crossOrigin = false) {
  const requested = yield* Deferred.make<void>();
  let pending: ServerResponse | undefined;
  let destination = "";

  const server = createServer((request, response) => {
    if (request.url === "/await") {
      pending = response;
      Deferred.doneUnsafe(requested, Exit.void);

      return;
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<!doctype html><title>Navigation expectation</title><main>
      <h1>${request.url === "/done" ? "Done" : "Ready"}</h1>
      <button id="fetch">Fetch</button><button id="still">Still</button>
      <button id="navigate">Navigate</button></main><script>
      document.getElementById('fetch').onclick = () => {
        document.querySelector('main').setAttribute('aria-busy', 'true');
        fetch('/await').then(() => location.href = ${JSON.stringify(destination)});
      };
      document.getElementById('still').onclick = () => {
        document.body.dataset.pressed = String(Number(document.body.dataset.pressed || 0) + 1);
      };
      document.getElementById('navigate').onclick = () => location.href = '/done';
      </script>`);
  });

  yield* Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          server.listen(0, "127.0.0.1", resolve);
        }),
    ),
    () =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
  );
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;

  destination = `http://${crossOrigin ? "localhost" : "127.0.0.1"}:${port}/arrived`;

  return {
    start: `${origin}/start`,
    destination,
    done: `${origin}/done`,
    requested: Deferred.await(requested),
    release: Effect.sync(() => pending?.end("continue")),
  };
});

const open = Effect.fnUntraced(function* (url: string) {
  const browser = yield* Browser;

  return yield* Effect.acquireRelease(browser.newPage(url), (page) => Effect.ignore(page.close));
});

layer(Chromium.layer(), { excludeTestServices: true, timeout: Duration.seconds(30) })(
  "Plan relative navigation",
  (it) => {
    for (const phase of ["ready", "arrival"] as const)
      it.effect(`does not skip input because an earlier redirect completed during ${phase}`, () =>
        Effect.gen(function* () {
          const site = yield* fixture(phase === "arrival");
          const page = yield* open(site.start);

          const earlier = Plan.Plan.new([
            new Plan.Step({ action: "click", subject: named("Fetch"), url: site.start }),
          ]);

          yield* Plan.take(page, earlier, 0, { settle: false });
          yield* site.requested;
          const preparing = yield* Deferred.make<void>();

          // Signal entry at the public boundary; readiness, arrival reads and all input still
          // use the real page. The prior handler cannot navigate before Plan takes its baseline.
          const observed: Page = {
            ...page,
            ready: (options) =>
              Deferred.succeed(preparing, undefined).pipe(Effect.andThen(page.ready(options))),
            url:
              phase === "arrival"
                ? Deferred.succeed(preparing, undefined).pipe(Effect.andThen(page.url))
                : page.url,
          };

          const plan = Plan.Plan.new([
            new Plan.Step({ action: "navigate", url: site.destination }),
            new Plan.Step({
              action: "click",
              subject: named("Still"),
              url: site.destination,
              expect: { _tag: "Navigated" },
            }),
          ]);

          const taking = yield* Plan.take(observed, plan, 1, {
            settle: phase === "ready" ? { still: "content", quietMillis: 50 } : false,
            arrival: "1 second",
          }).pipe(Effect.exit, Effect.forkChild);

          yield* Deferred.await(preparing);
          yield* site.release;
          const result = yield* Fiber.join(taking);

          assert.isTrue(Exit.isFailure(result), "the current action did not navigate");
          if (Exit.isFailure(result)) {
            const error = Exit.findErrorOption(result);

            assert.strictEqual(error._tag, "Some");
            if (error._tag === "Some") {
              assert.strictEqual(error.value.reason._tag, "Drifted");
              assert.strictEqual(error.value.input, "unknown");
            }
          }
          assert.strictEqual(
            yield* Effect.promise(() =>
              page.playwright.evaluate(() => document.body.dataset["pressed"]),
            ),
            "1",
            "the current action must be sent exactly once",
          );
        }),
      );

    it.effect("verifies a document change caused by the current action", () =>
      Effect.gen(function* () {
        const site = yield* fixture();
        const page = yield* open(site.start);

        const plan = Plan.Plan.new([
          new Plan.Step({
            action: "click",
            subject: named("Navigate"),
            url: site.done,
            expect: { _tag: "Navigated" },
          }),
        ]);

        const receipt = yield* Plan.take(page, plan, 0, { arrival: "1 second" });

        assert.strictEqual(receipt.outcome, "verified");
        assert.strictEqual(yield* page.url, site.done);
      }),
    );
  },
);
