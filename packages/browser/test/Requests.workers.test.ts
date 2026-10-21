// Existing worker targets escape browser Fetch; installation must refuse that unsupported state.
import { createServer } from "node:http";

import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { chromium } from "playwright-core";

import * as Browser from "../src/Browser.ts";
import * as TestCdp from "./support/TestCdp.ts";

for (const [kind, timing] of [
  ["worker", "before"],
  ["shared_worker", "before"],
  ["service_worker", "before"],
  ["worker", "during"],
] as const) {
  it.live(`refuses request authority when ${kind} starts ${timing} installation`, () =>
    Effect.gen(function* () {
      const server = yield* Effect.acquireRelease(
        Effect.callback<ReturnType<typeof createServer>>((resume) => {
          const instance = createServer((request, response) => {
            response.setHeader(
              "content-type",
              request.url?.endsWith(".js") ? "text/javascript" : "text/html",
            );
            response.end(
              request.url === "/dedicated.js"
                ? 'self.postMessage("ready")'
                : request.url === "/shared.js"
                  ? 'self.onconnect = event => event.ports[0].postMessage("ready")'
                  : request.url === "/service.js"
                    ? 'self.addEventListener("install", event => event.waitUntil(self.skipWaiting()))'
                    : "<body>Existing worker fixture</body>",
            );
          });

          instance.listen(0, "127.0.0.1", () => resume(Effect.succeed(instance)));
        }),
        (server) =>
          Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                server.close(() => resolve());
              }),
          ),
      );

      const address = server.address();

      assert.isTrue(typeof address === "object" && address !== null);
      const origin = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;

      const native = yield* Effect.acquireRelease(
        Effect.promise(() => chromium.launch()),
        (browser) => Effect.promise(() => browser.close()),
      );

      const context = yield* Effect.promise(() => native.newContext());
      const page = yield* Effect.promise(() => context.newPage());

      yield* Effect.promise(() => page.goto(origin));

      const start = Effect.promise(() =>
        page.evaluate(async (kind) => {
          if (kind === "service_worker") {
            await navigator.serviceWorker.register("/service.js");
            await navigator.serviceWorker.ready;

            return;
          }

          await new Promise<void>((resolve) => {
            const worker =
              kind === "worker" ? new Worker("/dedicated.js") : new SharedWorker("/shared.js");

            Object.assign(window, { heldWorker: worker });
            if (worker instanceof SharedWorker) worker.port.onmessage = () => resolve();
            else worker.onmessage = () => resolve();
          });
        }, kind),
      );

      let decisions = 0;
      const faults = yield* TestCdp.make();
      const enable = yield* Deferred.make<void>();

      if (timing === "during")
        faults.rule({ channel: "browser", method: "Fetch.enable" }, { _tag: "Hold", gate: enable });
      else yield* start;

      const opening = yield* faults
        .provide(
          Browser.make(
            context,
            { provider: "existing-worker-fixture" },
            {
              requests: {
                patterns: [`${origin}/*`],
                decide: () =>
                  Effect.sync(() => {
                    decisions++;

                    return { _tag: "Allowed" as const };
                  }),
              },
            },
          ),
        )
        .pipe(Effect.result, Effect.forkScoped);

      if (timing === "during") {
        yield* faults.waitUntil((calls) => calls.some(({ method }) => method === "Fetch.enable"));
        yield* start;
        yield* Deferred.succeed(enable, undefined);
      }

      const opened = yield* Fiber.join(opening);

      assert.strictEqual(
        opened._tag,
        "Failure",
        "request authority must refuse an unobserved active worker",
      );
      if (opened._tag === "Failure")
        assert.strictEqual(opened.failure.reason._tag, "InvalidRequest");
      assert.strictEqual(decisions, 0);
      assert.isTrue(native.isConnected());
    }).pipe(Effect.scoped),
  );
}
