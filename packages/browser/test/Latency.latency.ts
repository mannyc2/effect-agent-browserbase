/** Optional machine-latency checks. Normal tests retain the causal/ownership assertions. */
import { assert, layer } from "@effect/vitest";
import { Duration, Effect, Exit, Layer, Schema } from "effect";

import { behindProxy } from "../../../tools/testing/cdp-proxy.ts";
import { Browser, make as makeBrowser, type Options } from "../src/Browser.ts";
import type { Page } from "../src/Page.ts";
import * as Cdp from "../src/providers/Cdp.ts";
import * as Chromium from "../src/providers/Chromium.ts";
import * as Stillness from "../src/stillness/Stillness.ts";
import { Site, SiteLayer } from "./fixtures.ts";
import * as TestCdp from "./support/TestCdp.ts";

const measured = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const started = performance.now();
    const value = yield* effect;

    return { value, millis: performance.now() - started };
  });

const opened = (options: Options = {}) =>
  Effect.gen(function* () {
    const native = TestCdp.nativeContext(yield* Browser).browser();

    if (native === null) return yield* Effect.die("local Chromium is required");

    const context = yield* Effect.acquireRelease(
      Effect.promise(() => native.newContext({ viewport: { width: 800, height: 600 } })),
      (context) => Effect.promise(() => context.close()),
    );

    return yield* makeBrowser(context, { id: "local-latency", provider: "test" }, options);
  });

const control = (page: Page, role: string, name: string) =>
  Effect.gen(function* () {
    const [found] = yield* page.find({ role, name });

    assert.isDefined(found);

    return found?.ref ?? "";
  });

layer(TestCdp.provideLayer(Layer.mergeAll(Chromium.layer(), SiteLayer)), {
  excludeTestServices: true,
  timeout: Duration.seconds(60),
})("Local native latency (opt-in)", (it) => {
  it.effect("returns from a fetch-triggering click before the delayed fetch response", () =>
    TestCdp.withCdp(
      Effect.gen(function* () {
        const browser = yield* opened();
        const page = yield* browser.newPage((yield* Site).url("/navigating"));
        const ref = yield* control(page, "button", "Fetch");
        const result = yield* measured(page.click(ref));

        assert.isBelow(result.millis, 400);
        assert.include((yield* page.text()).text, "Fetch");
      }),
    ),
  );

  it.effect("settles history-only and no-content navigation clicks within one second", () =>
    TestCdp.withCdp(
      Effect.gen(function* () {
        const browser = yield* opened();

        for (const [role, name] of [
          ["button", "Push"],
          ["link", "Empty"],
        ] as const) {
          const page = yield* browser.newPage((yield* Site).url("/navigating"));
          const ref = yield* control(page, role, name);
          const result = yield* measured(page.click(ref));

          assert.isBelow(result.millis, 1000, name);
          assert.include((yield* page.text()).text, "Still", name);
        }
      }),
    ),
  );

  it.effect("settles ten acknowledged clicks faster than the former fixed sleeps", () =>
    TestCdp.withCdp(
      Effect.gen(function* () {
        const browser = yield* opened();
        const page = yield* browser.newPage((yield* Site).url("/navigating"));
        const ref = yield* control(page, "button", "Still");

        yield* page.click(ref);
        const result = yield* measured(Effect.repeat(page.click(ref), { times: 9 }));

        assert.isBelow(result.millis, 1200);
      }),
    ),
  );

  it.effect("inserts a guarded two-thousand-character paste within two seconds", () =>
    TestCdp.withCdp(
      Effect.gen(function* () {
        let asked = 0;

        const browser = yield* opened({
          guard: () =>
            Effect.sync(() => {
              asked++;
            }),
        });

        const page = yield* browser.newPage(
          'data:text/html,<textarea aria-label="Notes"></textarea>',
        );

        const ref = yield* control(page, "textbox", "Notes");
        const text = "a guarded paste ".repeat(125);

        asked = 0;
        const result = yield* measured(page.type(text, { into: ref }));

        assert.isBelow(result.millis, 2000);
        assert.strictEqual(asked, 1);
        assert.deepStrictEqual(
          (yield* page.recentEvents)
            .filter((event) => event._tag === "TextInserted" || event._tag === "KeyChanged")
            .map((event) => event._tag),
          ["TextInserted"],
        );
        assert.strictEqual(
          (yield* page.read(() => document.querySelector("textarea")?.value ?? "", {
            arg: undefined,
            result: Schema.String,
          })).value,
          text,
        );
      }),
    ),
  );

  it.effect("reads a busy renderer's browser-maintained title within one second", () =>
    TestCdp.withCdp(
      Effect.gen(function* () {
        const browser = yield* opened({ actionTimeout: "5 seconds" });
        const page = yield* browser.newPage("data:text/html,<title>Blank</title>");

        yield* Effect.promise(() =>
          TestCdp.nativePage(page).evaluate(() => {
            setTimeout(() => {
              const end = Date.now() + 3000;

              while (Date.now() < end);
            }, 0);
          }),
        );
        const result = yield* measured(page.title);

        assert.strictEqual(result.value, "Blank");
        assert.isBelow(result.millis, 1000);
      }),
    ),
  );

  it.effect("bounds actual busy-renderer viewport calls within eighteen hundred milliseconds", () =>
    TestCdp.withCdp(
      Effect.gen(function* () {
        const proxy = yield* behindProxy();
        const browser = yield* Cdp.open({ endpoint: proxy.endpoint, actionTimeout: "1 second" });
        const page = yield* browser.firstPage;

        yield* page.goto(
          "data:text/html,<body style='margin:0;height:5000px'>busy<script>setTimeout(() => { const s = Date.now(); while (Date.now() - s < 5000) {} }, 300)</script></body>",
        );
        yield* Effect.sleep("600 millis");
        for (const [name, operation] of [
          ["scroll", page.scroll({ dy: 100 })],
          ["viewport", page.viewport],
        ] as const) {
          const result = yield* measured(Effect.exit(operation));

          assert.isTrue(Exit.isFailure(result.value), name);
          assert.isBelow(result.millis, 1800, name);
        }
      }),
    ),
  );

  it.effect("ends a repeated-document wait within its original local latency envelope", () =>
    TestCdp.withCdp(
      Effect.gen(function* () {
        const browser = yield* opened({ actionTimeout: "150 millis" });
        const page = yield* browser.newPage((yield* Site).url("/replacing"));
        const result = yield* measured(page.until({ text: "Never present" }, "some", 120));

        assert.isFalse(result.value.met);
        assert.isBelow(result.millis, 600);
      }),
    ),
  );

  it.effect(
    "bounds content readiness through repeated commits within fifteen hundred milliseconds",
    () =>
      TestCdp.withCdp(
        Effect.gen(function* () {
          const browser = yield* opened();
          const page = yield* browser.newPage();

          yield* Effect.promise(() =>
            TestCdp.nativePage(page).route("https://ready.test/**", (route) => {
              const hop = Number(new URL(route.request().url()).pathname.slice(1));

              return route.fulfill({
                contentType: "text/html",
                body: `<main aria-busy="true">${hop}</main><script>setTimeout(() => location.href = "/${hop + 1}", 100)</script>`,
              });
            }),
          );
          yield* page.goto("https://ready.test/0");

          const result = yield* measured(
            Effect.exit(
              Stillness.wait(page, {
                still: "content",
                quietMillis: 250,
                timeout: Duration.millis(700),
              }),
            ),
          );

          assert.isTrue(Exit.isFailure(result.value));
          assert.isBelow(result.millis, 1500);
        }),
      ),
  );
});
