/** Owned native fixture handles and the public browser built from their scoped context. */
import { Context, Effect, Layer } from "effect";
import * as Browser from "effect-browser/Browser";
import type * as Chromium from "effect-browser/Chromium";
import { chromium as native, type BrowserContext } from "playwright-core";

import * as Routes from "../FixtureRoutes.ts";

export class NativeContext extends Context.Service<NativeContext, BrowserContext>()(
  "bench/test/NativeContext",
) {}

export const layer = (options: Chromium.Options = {}) =>
  Routes.layer((requests) =>
    Layer.unwrap(
      Effect.gen(function* () {
        const browser = yield* Effect.acquireRelease(
          Effect.promise(() => native.launch({ headless: options.headless ?? true })),
          (browser) => Effect.promise(() => browser.close()),
        );

        const context = yield* Effect.promise(() =>
          browser.newContext({ viewport: options.viewport ?? { width: 1280, height: 720 } }),
        );

        const service = yield* Browser.make(
          context,
          { provider: "bench-fixture" },
          { ...options, requests },
        );

        return Layer.merge(
          Layer.succeed(NativeContext, context),
          Layer.succeed(Browser.Browser, service),
        );
      }),
    ),
  );
