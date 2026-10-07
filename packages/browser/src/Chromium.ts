/**
 * A local Chromium, launched for the scope and closed with it.
 *
 * It uses the Chromium build that `playwright-core` installs
 * (`npx playwright-core install chromium`), unless `executablePath` names another.
 *
 * @since 0.3.0
 */
import { Effect, Layer } from "effect";
import { chromium } from "playwright-core";

import * as Browser from "./Browser.ts";
import { BrowserError } from "./BrowserError.ts";
import { reasonOf } from "./internal/page.ts";

export interface Options extends Browser.Options {
  /** Defaults to true. */
  readonly headless?: boolean | undefined;
  /**
   * Run Chromium's sandbox. Defaults to false, as in Playwright, so an exploit in a page's renderer
   * runs with this process's privileges. Hosts that don't allow unprivileged user namespaces, such
   * as many containers, can't start the sandbox, and opening then fails.
   */
  readonly sandbox?: boolean | undefined;
  /** Defaults to 1280x720 CSS pixels at a device scale factor of 1. */
  readonly viewport?: { readonly width: number; readonly height: number } | undefined;
  readonly executablePath?: string | undefined;
  readonly args?: ReadonlyArray<string> | undefined;
  readonly userAgent?: string | undefined;
  readonly locale?: string | undefined;
}

// Playwright's own default, stated so that a launch timeout reports the bound it exceeded.
const launchTimeoutMillis = 180_000;

const failed = (operation: string, timeoutMillis?: number) => (cause: unknown) =>
  new BrowserError({ operation, reason: reasonOf(cause, timeoutMillis), dispatched: false });

/** Launch Chromium and open a `Browser` over a fresh context. */
export const open = Effect.fn("Chromium.open")(function* (options: Options = {}) {
  const launched = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        chromium.launch({
          headless: options.headless ?? true,
          chromiumSandbox: options.sandbox ?? false,
          timeout: launchTimeoutMillis,
          ...(options.executablePath === undefined
            ? {}
            : { executablePath: options.executablePath }),
          ...(options.args === undefined ? {} : { args: [...options.args] }),
        }),
      catch: failed("launch", launchTimeoutMillis),
    }).pipe(Effect.withSpan("Chromium.launch", {}, { captureStackTrace: false })),
    (browser) => Effect.tryPromise(() => browser.close()).pipe(Effect.ignore),
  );

  const context = yield* Effect.tryPromise({
    try: () =>
      launched.newContext({
        viewport: options.viewport ?? { width: 1280, height: 720 },
        deviceScaleFactor: 1,
        ...(options.userAgent === undefined ? {} : { userAgent: options.userAgent }),
        ...(options.locale === undefined ? {} : { locale: options.locale }),
      }),
    catch: failed("launch"),
  });

  return yield* Browser.make(
    context,
    { id: `chromium-${launched.version()}`, provider: "chromium", contextOrigin: "fresh" },
    options,
  );
});

/** A `Browser` Layer that launches Chromium when built and closes it when released. */
export const layer = (options: Options = {}): Layer.Layer<Browser.Browser, BrowserError> =>
  Layer.effect(Browser.Browser, open(options));
