import type { Browser, Page } from "playwright-core";

import { observeCaptureFrames } from "./CaptureTiming.ts";

/** Installed only by the local Chromium fixture; not part of production exports. */
export const installCaptureDiagnostics = (
  browser: Browser,
  fixtureSession: string,
  fixtureConnection: number,
) => {
  const seen = new WeakSet<Page>();
  let pageSerial = 0;
  let intervalSerial = 0;

  const observePage = (page: Page) => {
    if (seen.has(page)) return;
    seen.add(page);
    const fixturePage = ++pageSerial;
    const start = page.screencast.start.bind(page.screencast);

    page.screencast.start = (options) => {
      const callback = options?.onFrame;

      if (callback === undefined) return start(options);
      const intervalId = ++intervalSerial;

      return start({
        ...options,
        onFrame: observeCaptureFrames(
          callback,
          (event) => {
            console.error(
              "BROWSERBASE_CAPTURE_TIMING",
              JSON.stringify({
                fixtureSession,
                fixtureConnection,
                fixturePage,
                intervalId,
                chromiumVersion: browser.version(),
                nodeVersion: process.version,
                declaredPlaywrightVersion: "1.63.0",
                ...event,
              }),
            );
          },
          () => process.hrtime.bigint(),
        ),
      });
    };
  };

  const contexts = browser.contexts();

  for (const context of contexts) {
    for (const page of context.pages()) observePage(page);
    context.on("page", observePage);
  }
  browser.once("disconnected", () => {
    for (const context of contexts) context.off("page", observePage);
  });
};
