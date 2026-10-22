// Refresh existing workers under browser interception before granting request authority.
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
  it.live(
    kind === "shared_worker"
      ? "refuses request authority over an existing shared worker"
      : `refuses POSTs from a ${kind} started ${timing} installation without sending them`,
    () =>
      Effect.gen(function* () {
        const hits: string[] = [];

        const server = yield* Effect.acquireRelease(
          Effect.callback<ReturnType<typeof createServer>>((resume) => {
            const instance = createServer((request, response) => {
              hits.push(request.url ?? "");
              response.setHeader(
                "content-type",
                request.url?.endsWith(".js") ? "text/javascript" : "text/html",
              );
              response.end(
                request.url === "/dedicated.js"
                  ? `self.onmessage = () => { void fetch("/owned-worker", { method: "POST", body: "worker-body" })
                    .then(() => self.postMessage("went"), () => self.postMessage("refused")) }; self.postMessage("ready")`
                  : request.url === "/shared.js"
                    ? 'self.onconnect = event => event.ports[0].postMessage("ready")'
                    : request.url === "/service.js"
                      ? `self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
                       self.addEventListener("message", event => event.waitUntil(
                         fetch("/owned-service_worker", { method: "POST", body: "worker-body" })
                           .then(() => event.ports[0].postMessage("went"), () => event.ports[0].postMessage("refused"))))`
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

        const decisions: Array<{
          readonly url: string;
          readonly method: string;
          readonly body: string | null;
        }> = [];

        const faults = yield* TestCdp.make();
        const enable = yield* Deferred.make<void>();

        if (timing === "during")
          faults.rule(
            { channel: "browser", method: "Fetch.enable" },
            { _tag: "Hold", gate: enable },
          );
        else yield* start;

        const opening = yield* faults
          .provide(
            Browser.make(
              context,
              { provider: "existing-worker-fixture" },
              {
                requests: {
                  patterns: [`${origin}/owned*`],
                  decide: (request) =>
                    Effect.sync(() => {
                      decisions.push(request);

                      return { _tag: "Refused" as const, reason: "worker POST refused" };
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

        if (kind === "shared_worker") {
          assert.strictEqual(opened._tag, "Failure");
          if (opened._tag === "Failure")
            assert.strictEqual(opened.failure.reason._tag, "InvalidRequest");
          assert.deepStrictEqual(decisions, []);
        } else {
          if (opened._tag === "Failure") return yield* opened.failure;

          const outcome = yield* Effect.promise(() =>
            page.evaluate(async (kind) => {
              if (kind === "service_worker") {
                const registration = await navigator.serviceWorker.ready;
                const channel = new MessageChannel();

                return new Promise<string>((resolve) => {
                  channel.port1.onmessage = (event) => resolve(event.data);
                  registration.active?.postMessage("go", [channel.port2]);
                });
              }
              const worker = Reflect.get(window, "heldWorker") as Worker;

              return new Promise<string>((resolve) => {
                worker.onmessage = (event) => resolve(event.data);
                worker.postMessage("go");
              });
            }, kind),
          ).pipe(Effect.timeout("3 seconds"));

          assert.strictEqual(outcome, "refused");
          assert.deepStrictEqual(decisions, [
            { url: `${origin}/owned-${kind}`, method: "POST", body: "worker-body" },
          ]);
          assert.deepStrictEqual(
            hits.filter((url) => url.startsWith("/owned")),
            [],
          );
          assert.isFalse(
            (yield* opened.success.recentEvents).some((event) => event._tag === "Disconnected"),
          );
        }
        assert.isTrue(native.isConnected());
      }).pipe(Effect.scoped),
  );
}
