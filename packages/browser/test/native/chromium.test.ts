import { expect, it } from "@effect/vitest";
import { Effect, Redacted, Stream } from "effect";
import {
  BrowserPolicy,
  ClickRequest,
  HoverRequest,
  NavigateRequest,
  ObservedElement,
  ReadTextRequest,
  StartNavigationRequest,
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
            yield* session.navigate(NavigateRequest.make({ url: site.url }));

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
            yield* session.click(ClickRequest.make({ selector: "#increment" }));
            expect(
              (yield* session.readText(ReadTextRequest.make({ selector: "#count" }))).text,
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

            yield* session.navigate(NavigateRequest.make({ url: site.url }));
            yield* session.click(ClickRequest.make({ selector: "#increment" }));
            yield* session.closeChecked;
            expect(yield* Effect.result(session.retain)).toMatchObject({
              _tag: "Failure",
              failure: { reason: { _tag: "Closed" }, outcome: "undispatched" },
            });
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

        expect(failed).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "BrowserError", reason: { _tag: "NotFound" } },
        });
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

it.live(
  "pinned pages and child frames stay explicit while direct commands follow live selection",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const site = yield* localSite;

        yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* (yield* Chromium).launch(policy);
            const stageUrl = new URL("/pinned?name=stage", site.url).href;
            const scoutUrl = new URL("/pinned?name=scout", site.url).href;

            yield* session.navigate(NavigateRequest.make({ url: stageUrl }));
            const stageInfo = (yield* session.pages).find((page) => page.selected)!;
            const selectedStage = yield* session.retain;
            const stage = yield* session.pinPage(stageInfo);

            const childInfo = (yield* session.framesOf(stageInfo)).find(
              (frame) => frame.parentFrameId !== null,
            )!;

            const child = yield* session.pinFrame(stageInfo, childInfo);

            expect(stage.target.pageId).toBe(stageInfo.pageId);
            expect(child.target).toEqual({
              generation: stage.target.generation,
              pageId: stageInfo.pageId,
              frameId: childInfo.frameId,
            });
            expect(
              (yield* child.readText(ReadTextRequest.make({ selector: "#frame-name" }))).text,
            ).toBe("stage-child");

            const scoutInfo = yield* session.createPage;

            expect(scoutInfo.selected).toBe(false);
            // Resolve selection when this Effect runs, not when it is constructed.
            const navigateScout = session.navigate(NavigateRequest.make({ url: scoutUrl }));

            expect(yield* session.selectPage(scoutInfo)).toBeUndefined();
            const scoutTarget = yield* session.target;

            yield* navigateScout;
            expect(
              (yield* session.readText(ReadTextRequest.make({ selector: "#page-name" }))).text,
            ).toBe("scout");

            const staleSelected = yield* selectedStage
              .readText(ReadTextRequest.make({ selector: "#page-name" }))
              .pipe(Effect.result);

            expect(staleSelected._tag).toBe("Failure");
            if (staleSelected._tag === "Failure")
              expect(staleSelected.failure.reason._tag).toBe("Stale");

            const retainedScout = yield* session.retain;

            yield* session.selectPage(stageInfo);
            yield* session.selectPage(scoutInfo);
            expect(yield* Effect.result(retainedScout.readText({}))).toMatchObject({
              _tag: "Failure",
              failure: { reason: { _tag: "Stale" }, outcome: "undispatched" },
            });

            expect(
              (yield* stage.readText(ReadTextRequest.make({ selector: "#page-name" }))).text,
            ).toBe("stage");
            expect(
              (yield* child.readText(ReadTextRequest.make({ selector: "#frame-name" }))).text,
            ).toBe("stage-child");
            expect((yield* session.target).pageId).toBe(scoutTarget.pageId);

            const hovered = yield* child.hover(HoverRequest.make({ selector: "#frame-increment" }));

            expect(hovered.target).toEqual(child.target);
            expect((yield* session.target).pageId).toBe(scoutTarget.pageId);

            const observation = yield* session.observe();

            const increment = observation.controls.find(
              (control) => control.label === "Increment",
            )!;

            // A pinned read is passive and must not retire the selected page's exact-node receipt.
            yield* stage.readText(ReadTextRequest.make({ selector: "#count" }));
            yield* session.clickElement(
              ObservedElement.make({
                observationId: observation.observationId,
                elementId: increment.elementId,
              }),
            );
            expect(
              (yield* session.readText(ReadTextRequest.make({ selector: "#count" }))).text,
            ).toBe("1");

            yield* stage.click(ClickRequest.make({ selector: "#increment" }));
            expect((yield* stage.readText(ReadTextRequest.make({ selector: "#count" }))).text).toBe(
              "1",
            );
            expect((yield* session.target).pageId).toBe(scoutTarget.pageId);

            const held = yield* PageControl.suspend(session, stageInfo);

            const heldRead = yield* stage
              .readText(ReadTextRequest.make({ selector: "#count" }))
              .pipe(Effect.result);

            expect(heldRead._tag).toBe("Failure");
            if (heldRead._tag === "Failure") expect(heldRead.failure.reason._tag).toBe("Busy");
            expect(
              (yield* session.readText(ReadTextRequest.make({ selector: "#page-name" }))).text,
            ).toBe("scout");
            yield* PageControl.resume(session, held);

            yield* child.click(ClickRequest.make({ selector: "#frame-increment" }));
            expect(
              (yield* child.readText(ReadTextRequest.make({ selector: "#frameCount" }))).text,
            ).toBe("1");
            expect((yield* session.target).pageId).toBe(scoutTarget.pageId);

            yield* stage.click(ClickRequest.make({ selector: "#remove-frame" }));

            const detached = yield* child
              .readText(ReadTextRequest.make({ selector: "#frame-name" }))
              .pipe(Effect.result);

            expect(detached._tag).toBe("Failure");
            if (detached._tag === "Failure") {
              expect(detached.failure.reason._tag).toBe("Stale");
              expect(detached.failure.outcome).toBe("undispatched");
            }
            const detachedPin = yield* session.pinFrame(stageInfo, childInfo).pipe(Effect.result);

            expect(detachedPin._tag).toBe("Failure");
            if (detachedPin._tag === "Failure") {
              expect(detachedPin.failure.reason._tag).toBe("NotFound");
              expect(detachedPin.failure.outcome).toBe("undispatched");
            }

            const closedInfo = yield* session.createPage;

            yield* session.closePage(closedInfo);
            const closedPin = yield* session.pinPage(closedInfo).pipe(Effect.result);

            expect(closedPin._tag).toBe("Failure");
            if (closedPin._tag === "Failure") {
              expect(closedPin.failure.reason._tag).toBe("NotFound");
              expect(closedPin.failure.outcome).toBe("undispatched");
            }

            const completed = yield* stage.startNavigation(
              StartNavigationRequest.make({
                url: new URL("/pinned?name=completed", site.url).href,
                timeoutMillis: 3000,
              }),
            );

            yield* completed.completed;
            const delayedUrl = new URL("/pinned-delayed", site.url).href;

            const successor = yield* stage.startNavigation(
              StartNavigationRequest.make({ url: delayedUrl, timeoutMillis: 3000 }),
            );

            // A completed predecessor owns no stop authority over this successor.
            yield* completed.stop;
            expect((yield* successor.completed).url).toBe(delayedUrl);

            const slowUrl = new URL("/pinned-slow", site.url).href;

            const operation = yield* stage.startNavigation(
              StartNavigationRequest.make({ url: slowUrl, timeoutMillis: 10000 }),
            );

            expect(operation.target).toEqual(stage.target);

            const reserved = yield* stage
              .click(ClickRequest.make({ selector: "#increment" }))
              .pipe(Effect.result);

            expect(reserved._tag).toBe("Failure");
            if (reserved._tag === "Failure") {
              expect(reserved.failure.reason._tag).toBe("Busy");
              expect(reserved.failure.outcome).toBe("undispatched");
            }

            const scoutBefore = Number(
              (yield* session.readText(ReadTextRequest.make({ selector: "#count" }))).text,
            );

            yield* session.click(ClickRequest.make({ selector: "#increment" }));
            expect(
              (yield* session.readText(ReadTextRequest.make({ selector: "#count" }))).text,
            ).toBe(String(scoutBefore + 1));

            yield* operation.stop;
            const completion = yield* operation.completed.pipe(Effect.result);

            expect(completion._tag).toBe("Failure");
            if (completion._tag === "Failure")
              expect(completion.failure.reason._tag).toBe("Interrupted");
            expect((yield* session.target).pageId).toBe(scoutTarget.pageId);
          }),
        ).pipe(
          Effect.provide(
            Chromium.layer({
              launch,
              pageControl: true,
              viewport: { width: 640, height: 480 },
            }),
          ),
        );
      }),
    ),
);
