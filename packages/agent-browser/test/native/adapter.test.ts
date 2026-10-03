import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  BrowserNavigateRequest,
  InteractiveBrowser,
  InteractiveBrowserPolicy,
} from "@yielded/agent/interactive-browser";
import { Context, Effect, Layer } from "effect";
import { fromSession, interactiveLayer } from "effect-agent-browser/adapter";
import * as Browser from "effect-browser/browser";
import { BrowserPolicy } from "effect-browser/browser-data";
import {
  Chromium,
  type ChromiumSession,
  type ChromiumCleanupResult,
} from "effect-browser/chromium";

import { toolSite } from "../fixtures/ToolSite.ts";

class Marker extends Context.Service<Marker, { readonly value: number }>()("test/AdapterMarker") {}

it.live(
  "the common framework Layer captures services but every Chromium belongs to its caller scope",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const site = yield* toolSite;
        const opened: ChromiumSession[] = [];
        const values: number[] = [];
        const cleanup: ChromiumCleanupResult[] = [];

        const source = Chromium.layer({
          launch: {
            ...(process.env.BROWSERBASE_CHROMIUM === undefined
              ? {}
              : { executablePath: process.env.BROWSERBASE_CHROMIUM }),
            chromiumSandbox: false,
            startupTimeoutMillis: 25000,
          },
          viewport: { width: 640, height: 480 },
          onCleanup: (result) =>
            Effect.sync(() => {
              cleanup.push(result);
            }),
        }).pipe(Layer.provide(NodeCrypto.layer));

        const layer = interactiveLayer({
          implementation: "chromium-playwright-cdp",
          open: (policy) =>
            Effect.gen(function* () {
              values.push((yield* Marker).value);
              const browser = yield* (yield* Chromium).launch(policy);

              opened.push(browser);

              return browser;
            }),
        }).pipe(Layer.provide(Layer.merge(source, Layer.succeed(Marker, { value: 7 }))));

        const context = yield* Layer.build(layer);

        expect(opened).toHaveLength(0);
        const browser = Context.get(context, InteractiveBrowser);

        const policy = InteractiveBrowserPolicy.make({
          network: { _tag: "Unrestricted" },
          maxActions: 20,
          maxElapsedMillis: 60000,
          maxReturnedBytes: 2 * 1024 * 1024,
        });

        for (let execution = 0; execution < 2; execution++) {
          yield* Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* browser.open(policy);

              yield* handle.navigate(BrowserNavigateRequest.make({ url: site.url }));
              expect((yield* handle.readText({ selector: "#visible" })).text).toBe("VISIBLE WORDS");
            }),
          ).pipe(Effect.provideService(Marker, { value: 99 }));
          expect(cleanup).toHaveLength(execution + 1);
          expect(cleanup[execution]).toMatchObject({
            connection: "closed",
            process: "terminated",
            issues: [],
          });
          const ended = opened[execution];

          expect(ended).toBeDefined();
          if (ended === undefined) return yield* Effect.die("Missing owned session");
          expect((yield* ended.initialPage.observe().pipe(Effect.flip)).reason._tag).toBe("Closed");
        }
        expect(values).toEqual([7, 7]);
        expect(new Set(opened.map((session) => session.reference.id)).size).toBe(2);
      }),
    ),
);

it.live(
  "framework handles keep their issued Page across display selection and preserve owner-wide cleanup",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const site = yield* toolSite;

        yield* Browser.scoped(Chromium.launch(BrowserPolicy.unrestricted()), (browser) =>
          Effect.gen(function* () {
            const firstPage = browser.initialPage;

            yield* firstPage.navigate({ url: site.url });
            const [first] = yield* browser.listPages();

            if (first === undefined) return yield* Effect.die("Missing original page");
            const adaptedFirst = yield* fromSession(browser, firstPage);
            const laterAdaptation = fromSession(browser, firstPage);
            const nextNavigation = adaptedFirst.handle.navigate({ url: `${site.url}?first=1` });
            const secondPage = yield* browser.createPage();
            const adaptedSecond = yield* fromSession(browser, secondPage);

            expect(adaptedFirst.browser).toBe(browser);
            expect(adaptedSecond.browser).toBe(browser);
            expect((yield* secondPage.describe()).selected).toBe(false);
            expect(yield* browser.selectPage(secondPage)).toBeUndefined();
            yield* nextNavigation;
            const recheckedFirst = yield* laterAdaptation;

            expect((yield* recheckedFirst.handle.readText({ selector: "#visible" })).text).toBe(
              "VISIBLE WORDS",
            );
            yield* adaptedSecond.handle.navigate({ url: `${site.url}?second=1` });
            const pages = yield* browser.listPages();

            expect(pages.find((page) => page.pageId === first.pageId)?.url).toBe(
              `${site.url}?first=1`,
            );
            expect(pages.find((page) => page.pageId === secondPage.identity.pageId)?.url).toBe(
              `${site.url}?second=1`,
            );
            expect(pages.find((page) => page.selected)?.pageId).toBe(secondPage.identity.pageId);

            yield* browser.selectPage(firstPage);
            yield* browser.selectPage(secondPage);
            expect((yield* adaptedFirst.handle.readText({ selector: "#visible" })).text).toBe(
              "VISIBLE WORDS",
            );
            yield* firstPage.close();
            expect((yield* adaptedFirst.handle.readText({}).pipe(Effect.flip))._tag).toBe(
              "InteractiveBrowserExpiredError",
            );
            expect((yield* adaptedSecond.handle.readText({ selector: "#visible" })).text).toBe(
              "VISIBLE WORDS",
            );
            yield* browser.closeChecked;
            expect((yield* adaptedSecond.handle.readText({}).pipe(Effect.flip))._tag).toBe(
              "InteractiveBrowserExpiredError",
            );
          }),
        ).pipe(
          Effect.provide(
            Chromium.layer({
              launch: {
                ...(process.env.BROWSERBASE_CHROMIUM === undefined
                  ? {}
                  : { executablePath: process.env.BROWSERBASE_CHROMIUM }),
                chromiumSandbox: false,
                startupTimeoutMillis: 25000,
              },
              viewport: { width: 640, height: 480 },
            }).pipe(Layer.provide(NodeCrypto.layer)),
          ),
        );
      }),
    ),
);
