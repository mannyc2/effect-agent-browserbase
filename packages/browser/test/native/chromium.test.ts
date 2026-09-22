import { expect, it } from "@effect/vitest";
import { Effect, Redacted, Stream } from "effect";
import {
  BrowserPolicy,
  ClickRequest,
  NavigateRequest,
  ReadTextRequest,
} from "effect-browser/browser-data";
import * as Capture from "effect-browser/capture";
import { Chromium, type ChromiumCleanupResult } from "effect-browser/chromium";
import * as PageControl from "effect-browser/page-control";
import { chromium } from "playwright-core";

import { externalChromium, localSite } from "../fixtures/StandaloneBrowser.ts";

const policy = BrowserPolicy.unrestricted({ maxElapsedMillis: 60000 });

const launch = {
  ...(process.env.BROWSERBASE_CHROMIUM === undefined
    ? {}
    : { executablePath: process.env.BROWSERBASE_CHROMIUM }),
  chromiumSandbox: false,
  startupTimeoutMillis: 25000,
};

it.live(
  "public local owner records real Chromium and page holds without any Browserbase account",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const site = yield* localSite;
        const reports: ChromiumCleanupResult[] = [];

        yield* Effect.scoped(
          Effect.gen(function* () {
            const browser = yield* Chromium;
            const acquired = yield* browser.acquire(policy);
            const session = yield* acquired.connect;

            expect(yield* acquired.connect).toBe(session);
            expect(session.reference.provider).toBe("chromium");
            expect("sessionId" in session.reference).toBe(false);
            yield* session.bind().navigate(NavigateRequest.make({ url: site.url }));

            const capture = yield* Capture.start(session, {
              lifetime: "page",
              maxDurationMillis: 10000,
            });

            const frames = yield* capture.frames.pipe(Stream.take(1), Stream.runCollect);

            expect(frames.length).toBe(1);
            const page = (yield* session.pages).find((page) => page.selected)!;
            const held = yield* PageControl.suspend(session, page);

            expect((yield* PageControl.state(session, page)).state).toBe("suspended");
            yield* PageControl.resume(session, held);
            yield* session.bind().click(ClickRequest.make({ selector: "#increment" }));
            expect(
              (yield* session.bind().readText(ReadTextRequest.make({ selector: "#count" }))).text,
            ).toBe("1");
            expect((yield* capture.stop).nativeStop).toBe("confirmed");
          }),
        ).pipe(
          Effect.provide(
            Chromium.layer({
              launch,
              pageControl: true,
              viewport: { width: 640, height: 480 },
              onCleanup: (result) =>
                Effect.sync(() => {
                  reports.push(result);
                }),
            }),
          ),
        );
        expect(reports).toHaveLength(1);
        expect(reports[0]!.ownership).toBe("owned");
        expect(reports[0]!.connection).toBe("closed");
        expect(reports[0]!.process).toBe("terminated");
        expect(reports[0]!.issues).toEqual([]);
        expect(site.requests).toContain("/");
      }),
    ),
);

it.live(
  "borrowed local attachments and failed target selection leave the external process usable",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const host = yield* externalChromium;
        const site = yield* localSite;
        const reports: ChromiumCleanupResult[] = [];

        yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* (yield* Chromium).attach(host.endpoint, { policy });

            yield* session.bind().navigate(NavigateRequest.make({ url: site.url }));
            yield* session.bind().click(ClickRequest.make({ selector: "#increment" }));
            yield* session.closeChecked;
          }),
        ).pipe(
          Effect.provide(
            Chromium.layer({
              onCleanup: (result) =>
                Effect.sync(() => {
                  reports.push(result);
                }),
            }),
          ),
        );
        expect(host.running()).toBe(true);
        expect(reports[0]!.ownership).toBe("borrowed");
        expect(reports[0]!.process).toBe("not-owned");
        expect(reports[0]!.connection).toBe("closed");

        const failed = yield* Effect.scoped(
          Effect.gen(function* () {
            return yield* (yield* Chromium).attach(host.endpoint, {
              policy,
              target: { targetId: "does-not-exist" },
            });
          }),
        ).pipe(Effect.provide(Chromium.layer()), Effect.result);

        expect(failed._tag).toBe("Failure");
        if (failed._tag === "Failure") expect(failed.failure.reason).toBe("not-found");
        expect(host.running()).toBe(true);
        // An independent controller observes the work after both library connections have closed.
        yield* Effect.promise(async () => {
          const client = await chromium.connectOverCDP(Redacted.value(host.endpoint));

          try {
            expect(await client.contexts()[0]!.pages()[0]!.locator("#count").textContent()).toBe(
              "1",
            );
          } finally {
            await client.close();
          }
        });
        expect(host.running()).toBe(true);
      }),
    ),
);
