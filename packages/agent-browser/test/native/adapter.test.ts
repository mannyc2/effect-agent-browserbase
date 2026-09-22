import { expect, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";
import { interactiveLayer } from "effect-agent-browser/adapter";
import {
  BrowserNavigateRequest,
  InteractiveBrowser,
  InteractiveBrowserPolicy,
} from "effect-agent/interactive-browser";
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
        });

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
          expect((yield* ended.observe().pipe(Effect.flip)).reason).toBe("closed");
        }
        expect(values).toEqual([7, 7]);
        expect(new Set(opened.map((session) => session.reference.id)).size).toBe(2);
      }),
    ),
);
