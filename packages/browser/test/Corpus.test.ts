import { assert, layer } from "@effect/vitest";
import { Duration, Effect, Layer } from "effect";

import { Browser, make as makeBrowser } from "../src/Browser.ts";
import { PolicyDenied } from "../src/BrowserError.ts";
import * as Chromium from "../src/Chromium.ts";
import { type InputRequest, redacted } from "../src/Page.ts";
import { corpus } from "./consequence-corpus.ts";
import { Site, SiteLayer } from "./fixtures.ts";

const sorted = (values: ReadonlyArray<string>) =>
  [...values].sort((left, right) => left.localeCompare(right));

layer(Layer.mergeAll(Chromium.layer(), SiteLayer), {
  excludeTestServices: true,
  timeout: Duration.seconds(120),
})("Corpus", (it) => {
  it.effect("reports exactly the structural facts of every corpus control", () =>
    Effect.gen(function* () {
      const host = yield* Browser;
      const native = host.context.browser();

      if (native === null) return yield* Effect.die("the corpus requires a launched Chromium");

      const context = yield* Effect.acquireRelease(
        Effect.promise(() => native.newContext({ viewport: { width: 1280, height: 720 } })),
        (context) => Effect.promise(() => context.close()),
      );

      const requests: Array<InputRequest> = [];

      const browser = yield* makeBrowser(
        context,
        { id: "corpus", provider: "test" },
        {
          guard: (request) =>
            Effect.sync(() => requests.push(request)).pipe(
              Effect.andThen(Effect.fail(new PolicyDenied({ detail: "inspection only" }))),
            ),
        },
      );

      const page = yield* browser.newPage();

      const site = yield* Site;

      // Relative destinations resolve against the fixture site; other.example is another origin.
      yield* Effect.promise(() => page.playwright.goto(site.url("/form")));
      const misreported: Array<string> = [];
      const silent: Array<string> = [];

      for (const item of corpus) {
        requests.length = 0;
        yield* Effect.promise(() => page.playwright.setContent(item.html));

        const input =
          item.action === "click"
            ? Effect.promise(() => page.playwright.locator("#t").boundingBox()).pipe(
                Effect.flatMap((box) =>
                  box === null
                    ? Effect.die(item.id + " has no box")
                    : page.click({ x: box.x + box.width / 2, y: box.y + box.height / 2 }),
                ),
              )
            : Effect.promise(() => page.playwright.locator("#t").focus()).pipe(
                Effect.andThen(item.action === "type" ? page.type("x") : page.press("Enter")),
              );

        const refused = yield* input.pipe(
          Effect.match({
            onFailure: (error) => error.reason._tag === "PolicyDenied" && !error.dispatched,
            onSuccess: () => false,
          }),
        );

        const request = requests.at(-1);

        if (!refused || request === undefined) {
          misreported.push(item.id + " never reached the guard");
          continue;
        }

        if (JSON.stringify(sorted(request.facts)) !== JSON.stringify(sorted(item.facts)))
          misreported.push(
            `${item.id}: ${JSON.stringify(request.facts)}, expected ${JSON.stringify(item.facts)}`,
          );
        if (
          item.action === "type" &&
          request.text !== (request.facts.includes("secret") ? redacted : "x")
        )
          misreported.push(`${item.id}: typed text reached the guard as ${request.text}`);
        if (item.risks.length > 0 && request.facts.length === 0) silent.push(item.id);
      }

      assert.deepStrictEqual(misreported, []);
      // Structure leaves only one consequential case without any fact: a field whose purpose
      // only its words give. Every other one is a submission, a secret, or up to script.
      assert.deepStrictEqual(silent, ["type-ssn"]);
    }),
  );
});
