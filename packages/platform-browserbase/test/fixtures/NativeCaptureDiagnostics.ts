import type { Browser, Page } from "playwright-core";

import { captureLifecycle, type CaptureEnd } from "./CaptureLifecycle.ts";

/** Installed only by the local Chromium fixture; not part of production exports. */
export const installCaptureDiagnostics = (
  browser: Browser,
  fixtureSession: string,
  fixtureConnection: number,
) => {
  const seen = new WeakSet<Page>();
  const pending = new Set<() => void>();
  let pageSerial = 0;
  let intervalSerial = 0;

  const observePage = (page: Page) => {
    if (seen.has(page)) return;
    seen.add(page);
    const fixturePage = ++pageSerial;
    const start = page.screencast.start.bind(page.screencast);
    const stop = page.screencast.stop.bind(page.screencast);
    let active: { readonly finish: (end: CaptureEnd) => void } | undefined;

    page.screencast.start = (options) => {
      const callback = options?.onFrame;

      if (callback === undefined) return start(options);
      active?.finish("superseded");
      const intervalId = ++intervalSerial;

      const identity = {
        fixtureSession,
        fixtureConnection,
        fixturePage,
        intervalId,
        chromiumVersion: browser.version(),
        nodeVersion: process.version,
        declaredPlaywrightVersion: "1.63.0",
      };

      const disconnected: () => void = () => attempt.finish("disconnected");

      const attempt = captureLifecycle(
        callback,
        (event) =>
          console.error("BROWSERBASE_CAPTURE_TIMING", JSON.stringify({ ...identity, ...event })),
        (event) => {
          pending.delete(disconnected);
          console.error("BROWSERBASE_CAPTURE_LIFECYCLE", JSON.stringify({ ...identity, ...event }));
        },
        () => process.hrtime.bigint(),
      );

      active = attempt;
      pending.add(disconnected);
      try {
        const promise = start({ ...options, onFrame: attempt.receive });

        void promise.then(
          () => attempt.acknowledged(),
          () => attempt.finish("start-failed"),
        );

        return promise;
      } catch (error) {
        attempt.finish("start-failed");
        throw error;
      }
    };
    page.screencast.stop = () => {
      const attempt = active;

      try {
        const promise = stop();

        void promise.then(
          () => attempt?.finish("stop-confirmed"),
          () => attempt?.finish("stop-failed"),
        );

        return promise;
      } catch (error) {
        attempt?.finish("stop-failed");
        throw error;
      }
    };
    page.once("close", () => active?.finish("page-closed"));
  };

  const contexts = browser.contexts();

  for (const context of contexts) {
    for (const page of context.pages()) observePage(page);
    context.on("page", observePage);
  }
  browser.once("disconnected", () => {
    for (const finish of pending) finish();
    pending.clear();
    for (const context of contexts) context.off("page", observePage);
  });
};
