// Borrowed CDP retirement must not release an owned request that policy never allowed.
import { createServer } from "node:http";

import { assert, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Scope } from "effect";
import { chromium } from "playwright-core";

import * as Browser from "../src/Browser.ts";
import * as TestCdp from "./support/TestCdp.ts";

for (const [kind, phase] of [
  ["page", "decision"],
  ["page", "ownership"],
  ["service_worker", "decision"],
  ["service_worker", "ownership"],
  ["page", "cleanup-failure"],
] as const)
  it.live(
    phase === "cleanup-failure"
      ? "surfaces retirement cut failure and still detaches interception"
      : `does not release an unjudged owned ${kind} request when closing during ${phase}`,
    () =>
      Effect.gen(function* () {
        const hits: string[] = [];

        const server = yield* Effect.acquireRelease(
          Effect.callback<ReturnType<typeof createServer>>((resume) => {
            const instance = createServer((request, response) => {
              hits.push(request.url ?? "");
              if (request.url === "/sw.js") {
                response.setHeader("content-type", "text/javascript");
                response.end(`self.addEventListener("message", event => event.waitUntil(fetch("/owned-sw")
                .then(() => event.source.postMessage("went"), () => event.source.postMessage("failed"))))`);
              } else response.end("network reached");
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
        const foreign = yield* Effect.promise(() => native.newContext());
        const untouched = yield* Effect.promise(() => foreign.newPage());
        const owner = yield* Scope.make();

        yield* Effect.addFinalizer(() => Scope.close(owner, Exit.void));
        const entered = yield* Deferred.make<void>();
        const faults = yield* TestCdp.make();

        yield* faults.provide(
          Browser.make(
            context,
            { provider: "borrowed-retirement-fixture" },
            {
              requests: {
                patterns: [`${origin}/owned*`],
                decide: () =>
                  Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
              },
            },
          ).pipe(Scope.provide(owner)),
        );

        if (kind === "service_worker") {
          yield* Effect.promise(() => page.goto(origin));
          yield* Effect.promise(() =>
            page.evaluate(async () => {
              await navigator.serviceWorker.register("/sw.js");
              await navigator.serviceWorker.ready;
            }),
          );
        }

        if (phase !== "decision") {
          faults.rule(
            { channel: "browser", method: "Target.getTargetInfo" },
            {
              _tag: "Fail",
              error: new Error("No target with given id found"),
            },
          );
          faults.rule(
            { channel: "browser", method: "Page.getFrameTree" },
            { _tag: "Hold", gate: Effect.never },
          );
        }
        if (phase === "cleanup-failure")
          faults.rule(
            { channel: "browser", method: "Fetch.enable" },
            { _tag: "Fail", error: new Error("interception cut failed") },
          );

        const request = yield* Effect.promise(() =>
          kind === "page"
            ? page.goto(`${origin}/owned`, { timeout: 5000 }).then(
                () => true,
                () => false,
              )
            : page
                .evaluate(
                  async () =>
                    new Promise<boolean>((resolve) => {
                      navigator.serviceWorker.addEventListener(
                        "message",
                        (event) => resolve(event.data === "went"),
                        { once: true },
                      );
                      void navigator.serviceWorker.ready.then((registration) =>
                        registration.active?.postMessage("go"),
                      );
                    }),
                )
                .catch(() => false),
        ).pipe(Effect.forkScoped);

        yield* phase === "decision"
          ? Deferred.await(entered)
          : faults.waitUntil((calls) => calls.some(({ method }) => method === "Page.getFrameTree"));
        const retired = yield* Scope.close(owner, Exit.void).pipe(Effect.exit);

        if (phase === "cleanup-failure") {
          assert.deepStrictEqual(
            faults.calls.filter(({ method }) => method === "Fetch.enable").at(-1)?.params,
            { patterns: [] },
            "the failing retirement command must cut off new pauses",
          );
          assert.isTrue(Exit.isFailure(retired), "cleanup failure must remain observable");
          if (Exit.isFailure(retired))
            assert.include(Cause.pretty(retired.cause), "interception cut failed");
        } else if (Exit.isFailure(retired)) return yield* retired;
        const reached = yield* Fiber.join(request);

        assert.isTrue(
          native.isConnected(),
          "the external browser must remain alive for this proof",
        );
        if (phase === "decision")
          assert.isFalse(
            page.isClosed(),
            "an acknowledged refusal must preserve the borrowed page",
          );
        yield* Effect.promise(() => untouched.goto(`${origin}/foreign`));
        assert.strictEqual(
          yield* Effect.promise(() => untouched.locator("body").innerText()),
          "network reached",
        );
        if (phase === "cleanup-failure") {
          yield* Effect.promise(() => page.goto(`${origin}/owned-after-detach`, { timeout: 2000 }));
          assert.include(
            hits,
            "/owned-after-detach",
            "failed cleanup must still detach Fetch from the externally owned browser",
          );
        } else {
          assert.deepStrictEqual(
            hits.filter((url) => url.startsWith("/owned")),
            [],
            "native Chromium must not send an unjudged owned request after retirement",
          );
          assert.isFalse(reached, "retiring interception must refuse the held navigation");
        }
      }).pipe(Effect.scoped),
  );

it.live("refuses an Allowed decision while retirement waits for the cut acknowledgement", () =>
  Effect.gen(function* () {
    const hits: string[] = [];

    const server = yield* Effect.acquireRelease(
      Effect.callback<ReturnType<typeof createServer>>((resume) => {
        const instance = createServer((request, response) => {
          hits.push(request.url ?? "");
          response.end("network reached");
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
    const owner = yield* Scope.make();

    yield* Effect.addFinalizer(() => Scope.close(owner, Exit.void));
    const deciding = yield* Deferred.make<void>();
    const allow = yield* Deferred.make<void>();
    const cutReceived = yield* Deferred.make<void>();
    const finishCut = yield* Deferred.make<void>();
    const faults = yield* TestCdp.make();

    yield* faults.provide(
      Browser.make(
        context,
        { provider: "retirement-decision-fixture" },
        {
          requests: {
            patterns: [`${origin}/owned*`],
            decide: () =>
              Deferred.succeed(deciding, undefined).pipe(
                Effect.andThen(Deferred.await(allow)),
                Effect.as({ _tag: "Allowed" as const }),
              ),
          },
        },
      ).pipe(Scope.provide(owner)),
    );
    yield* Effect.promise(() => page.goto(origin));

    const request = yield* Effect.promise(() =>
      page.evaluate(() =>
        fetch("/owned-during-cut", { method: "POST", body: "private" }).then(
          () => "went",
          () => "blocked",
        ),
      ),
    ).pipe(Effect.forkScoped);

    yield* Deferred.await(deciding);
    // Installed only after setup: hold the native empty-pattern cut's actual acknowledgement.
    faults.rule(
      { channel: "browser", method: "Fetch.enable" },
      { _tag: "Hold", gate: finishCut },
      { phase: "after", times: 1 },
    );
    faults.observe((call, phase) => {
      if (call.method === "Fetch.enable" && phase === "received")
        Deferred.doneUnsafe(cutReceived, Effect.void);
    });
    const retiring = yield* Scope.close(owner, Exit.void).pipe(Effect.forkScoped);

    yield* Effect.gen(function* () {
      yield* Deferred.await(cutReceived);
      assert.deepStrictEqual(
        faults.calls.filter(({ method }) => method === "Fetch.enable").at(-1)?.params,
        { patterns: [] },
      );
      yield* Deferred.succeed(allow, undefined);
      assert.strictEqual(yield* Fiber.join(request), "blocked");
      assert.deepStrictEqual(
        hits.filter((url) => url.startsWith("/owned")),
        [],
      );
      assert.strictEqual(
        faults.calls.filter(({ method }) => method === "Fetch.continueRequest").length,
        0,
      );
      assert.strictEqual(
        faults.calls.filter(({ method }) => method === "Fetch.failRequest").length,
        1,
      );
    }).pipe(Effect.ensuring(Deferred.succeed(finishCut, undefined)));
    yield* Fiber.join(retiring);
    assert.isFalse(page.isClosed());
    assert.deepStrictEqual(
      hits.filter((url) => url.startsWith("/owned")),
      [],
    );
  }).pipe(Effect.scoped),
);
