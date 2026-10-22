// Requested public main-world seam (21 October audit stage 6): guard, document and dispatch evidence.
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Schema } from "effect";

import { consequence, PolicyDenied } from "../src/BrowserError.ts";
import * as Chromium from "../src/providers/Chromium.ts";
import * as TestCdp from "./support/TestCdp.ts";

it.live("main-world scripts bind an act to the read document and invalidate earlier reads", () =>
  Effect.gen(function* () {
    const browser = yield* Chromium.open();

    const page = yield* browser.newPage(
      "data:text/html,<h1>first</h1><script>window.chart={value:1}</script>",
    );

    const first = yield* page.read(() => Reflect.get(window, "chart").value, {
      arg: undefined,
      result: Schema.Finite,
    });

    assert.strictEqual(first.value, 1);
    yield* page.act(
      (value: number) => {
        Reflect.get(window, "chart").value = value;

        return value;
      },
      { arg: 2, result: Schema.Finite, document: first.document },
    );
    assert.strictEqual(
      (yield* page.read(() => Reflect.get(window, "chart").value, {
        arg: undefined,
        result: Schema.Finite,
      })).value,
      2,
    );
    yield* page.goto("data:text/html,<h1>second</h1>");

    const stale = yield* Effect.flip(
      page.act(
        () => {
          document.title = "wrong";

          return true;
        },
        { arg: undefined, result: Schema.Boolean, document: first.document },
      ),
    );

    assert.strictEqual(stale.dispatched, false);
    assert.notStrictEqual(yield* page.title, "wrong");
  }).pipe(Effect.scoped),
);

it.live("scripts consult the guard and preserve sent evidence on decode or execution failure", () =>
  Effect.gen(function* () {
    const browser = yield* Chromium.open({
      guard: (request) =>
        request.action._tag === "Act"
          ? Effect.fail(new PolicyDenied({ detail: "scripts denied" }))
          : Effect.void,
    });

    const page = yield* browser.newPage("data:text/html,<h1>guarded</h1>");

    const refused = yield* Effect.flip(
      page.act(
        () => {
          document.title = "wrong";

          return 1;
        },
        { arg: undefined, result: Schema.Finite, document: (yield* page.state).document },
      ),
    );

    assert.strictEqual(refused.dispatched, false);
    assert.strictEqual(refused.reason._tag, "PolicyDenied");
    const plain = yield* (yield* Chromium.open()).newPage("data:text/html,<h1>plain</h1>");

    const badResult = yield* Effect.flip(
      plain.act(() => "wrong", {
        arg: undefined,
        result: Schema.Finite,
        document: (yield* plain.state).document,
      }),
    );

    assert.strictEqual(badResult.dispatched, true);
    assert.strictEqual(consequence(badResult).repeat, "check");

    const threw = yield* Effect.flip(
      plain.read(
        () => {
          throw new Error("script failed");
        },
        { arg: undefined, result: Schema.Finite },
      ),
    );

    assert.strictEqual(threw.reason._tag, "Threw");
    assert.strictEqual(consequence(threw).repeat, "pointless");
  }).pipe(Effect.scoped),
);

it.live("a cancelled act retains its native reply before the next writer enters", () =>
  Effect.gen(function* () {
    const browser = yield* Chromium.open();
    const page = yield* browser.newPage("data:text/html,<h1>cancellation</h1>");
    const started = yield* Deferred.make<void>();

    const act = yield* page
      .act(
        async () => {
          await new Promise((resolve) => {
            setTimeout(resolve, 100);
          });
          document.title = "late";

          return true;
        },
        { arg: undefined, result: Schema.Boolean, document: (yield* page.state).document },
      )
      .pipe(
        Effect.onExit(() => Deferred.succeed(started, undefined)),
        Effect.forkScoped,
      );

    yield* Effect.sleep("25 millis");
    yield* Fiber.interrupt(act);
    yield* Deferred.await(started);
    yield* page.goto("data:text/html,<title>after</title>");
    assert.strictEqual(yield* page.title, "after");
  }).pipe(Effect.scoped),
);

// 1d6d7c7: replacing a document during an asynchronous read was misreported as script Threw.
it.live("read retries its script after the site replaces the execution context", () =>
  Effect.gen(function* () {
    const browser = yield* Chromium.open();
    const page = yield* browser.newPage("data:text/html,<title>before</title>");
    const native = yield* TestCdp.nativeOf(page);
    const entered = Promise.withResolvers<void>();

    yield* Effect.promise(() => native.exposeFunction("__readEntered", () => entered.resolve()));

    const reading = yield* page
      .read(
        () => {
          if (document.title !== "before") return Promise.resolve(document.title);
          void Reflect.get(window, "__readEntered")();

          return new Promise<string>(() => {});
        },
        { arg: undefined, result: Schema.String },
      )
      .pipe(Effect.forkScoped);

    yield* Effect.promise(() => entered.promise);
    yield* Effect.promise(() => native.goto("data:text/html,<title>after</title>"));
    const read = yield* Fiber.join(reading);

    assert.strictEqual(read.value, "after");
    assert.strictEqual(read.document, (yield* page.state).document);
  }).pipe(TestCdp.withCdp),
);

it.live("act reports a replaced context as uncertain input, not a script throw", () =>
  Effect.gen(function* () {
    const browser = yield* Chromium.open();
    const page = yield* browser.newPage("data:text/html,<title>before</title>");
    const native = yield* TestCdp.nativeOf(page);
    const entered = Promise.withResolvers<void>();

    yield* Effect.promise(() => native.exposeFunction("__actEntered", () => entered.resolve()));

    const acting = yield* page
      .act(
        () => {
          void Reflect.get(window, "__actEntered")();

          return new Promise<string>(() => {});
        },
        { arg: undefined, result: Schema.String, document: (yield* page.state).document },
      )
      .pipe(Effect.flip, Effect.forkScoped);

    yield* Effect.promise(() => entered.promise);
    yield* Effect.promise(() =>
      native.goto("data:text/html,<title>after</title>", { waitUntil: "commit" }),
    );
    const failure = yield* Fiber.join(acting);

    assert.strictEqual(failure.reason._tag, "NotActionable");
    assert.isTrue(failure.dispatched);
    assert.strictEqual(consequence(failure).repeat, "check");
  }).pipe(TestCdp.withCdp),
);
