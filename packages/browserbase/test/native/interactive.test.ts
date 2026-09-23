import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "@effect/vitest";
import { Clock, Effect, Fiber, Schema, Stream } from "effect";
import {
  ObservedElement,
  Viewport,
  ClickRequest,
  FillRequest,
  NavigateRequest,
  ReadTextRequest,
  ScreenshotRequest,
  ScrollRequest,
} from "effect-browser/browser-data";
import * as Capture from "effect-browser/capture";
import { BrowserbaseBrowser } from "effect-browserbase/browser";

import {
  localBrowser,
  localLaunch,
  policy,
  settle,
  withProvider,
} from "../fixtures/LocalBrowser.ts";

it.live("real CDP: exact-node interaction, frames, full-page PNG and navigation observers", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* localBrowser;

      yield* withProvider(
        f,
        Effect.gen(function* () {
          const host = yield* BrowserbaseBrowser;
          const session = yield* host.open(policy);
          const h = session;

          yield* h.navigate(NavigateRequest.make({ url: f.url }));
          yield* h.fill(FillRequest.make({ selector: "#name", value: "typed from real CDP" }));
          expect((yield* h.readText(ReadTextRequest.make({ selector: "#echo" }))).text).toBe(
            "typed from real CDP",
          );
          const before = yield* session.observe();
          const button = before.controls.find((control) => control.label === "Increment")!;

          const ref = ObservedElement.make({
            observationId: before.observationId,
            elementId: button.elementId,
          });

          yield* session.clickElement(ref);
          expect((yield* h.readText(ReadTextRequest.make({ selector: "#count" }))).text).toBe("1");
          const stale = yield* session.clickElement(ref).pipe(Effect.result);

          expect(stale._tag).toBe("Failure");
          if (stale._tag === "Failure") expect(stale.failure.outcome).toBe("undispatched");

          const duplicate = yield* h
            .click(ClickRequest.make({ selector: ".duplicate" }))
            .pipe(Effect.result);

          expect(duplicate._tag).toBe("Failure");

          const viewportPng = yield* h.screenshot(ScreenshotRequest.make({ fullPage: false }));

          const viewportView = new DataView(
            viewportPng.bytes.buffer,
            viewportPng.bytes.byteOffset,
            viewportPng.bytes.byteLength,
          );

          expect(viewportView.getUint32(16)).toBe(640);
          expect(viewportView.getUint32(20)).toBe(480);
          const png = yield* h.screenshot(ScreenshotRequest.make({ fullPage: true }));
          const view = new DataView(png.bytes.buffer, png.bytes.byteOffset, png.bytes.byteLength);

          // Full-page width follows Chromium's document geometry; a vertical scrollbar
          // may make it narrower than the configured viewport. Height proves full-page capture.
          expect(view.getUint32(16)).toBeGreaterThan(0);
          expect(view.getUint32(20)).toBeGreaterThan(1600);
          yield* h.scroll(ScrollRequest.make({ deltaX: 0, deltaY: 120 }));
          const frames = yield* session.frames;
          const child = frames.find((frame) => frame.name === "child")!;

          yield* session.selectFrame(child.frameId);
          const frameHandle = session;

          expect((yield* frameHandle.readText(ReadTextRequest.make({}))).text).toContain(
            "frame text",
          );
          yield* frameHandle.click(ClickRequest.make({ selector: "#inner" }));
          expect((yield* frameHandle.readText(ReadTextRequest.make({}))).text).toContain(
            "frame clicked",
          );
          const main = frames.find((frame) => frame.parentFrameId === null)!;

          yield* session.selectFrame(main.frameId);
          expect((yield* session.clickAndWait(ClickRequest.make({ selector: "#next" }))).url).toBe(
            new URL("next", f.url).href,
          );
          expect(f.requests.filter((path) => path === "/next")).toHaveLength(1);
          expect((yield* session.close).remote).toBe("confirmed");
        }),
      );
      expect(f.createBodies).toHaveLength(1);
      expect(f.releaseIds).toEqual(["session-1"]);
    }),
  ),
);

it.live(
  "real CDP: DOM replacement invalidates a retained node without clicking its replacement",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* localBrowser;

        yield* withProvider(
          f,
          Effect.gen(function* () {
            const session = yield* (yield* BrowserbaseBrowser).open(policy);

            yield* session.navigate(NavigateRequest.make({ url: f.url }));
            // This test needs a stable original document, not a read racing the child's commit.
            const childUrl = new URL("/frame", f.url).href;

            const frames = yield* settle(session.frames, (listed) =>
              listed.some((frame) => frame.name === "child" && frame.url === childUrl),
            );

            expect(frames.some((frame) => frame.name === "child" && frame.url === childUrl)).toBe(
              true,
            );
            const observation = yield* session.observe();
            const control = observation.controls.find((c) => c.label === "Increment")!;

            yield* Effect.promise(() =>
              f.human(session.reference.sessionId, (page) =>
                page.evaluate(() => {
                  const old = document.querySelector("#increment")!;

                  old.replaceWith(old.cloneNode(true));
                }),
              ),
            );

            const rejected = yield* session
              .clickElement(
                ObservedElement.make({
                  observationId: observation.observationId,
                  elementId: control.elementId,
                }),
              )
              .pipe(Effect.result);

            expect(rejected._tag).toBe("Failure");
            if (rejected._tag === "Failure") expect(rejected.failure.outcome).toBe("undispatched");
            expect(
              (yield* session.readText(ReadTextRequest.make({ selector: "#count" }))).text,
            ).toBe("0");
          }),
        );
      }),
    ),
);

it.live("real CDP: popup identity, explicit tab selection, downloads and dialog dismissal", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* localBrowser;

      yield* withProvider(
        f,
        Effect.gen(function* () {
          const session = yield* (yield* BrowserbaseBrowser).open(policy);
          const h = yield* session.retain;

          yield* h.navigate(NavigateRequest.make({ url: f.url }));
          const target = yield* session.target;

          const download = yield* session.clickForDownload(
            ClickRequest.make({ selector: "#download" }),
          );

          expect(download.state).toBe("completed");
          expect(download.filename).toBe("fixture.txt");
          expect(f.fileRequests()).toBe(1);

          const bytes = yield* Effect.promise(() =>
            readFile(join(f.directory, session.reference.sessionId, "downloads", "fixture.txt")),
          );

          expect(bytes.toString("utf8")).toBe("real browser download\n");
          // Native event IDs are not asserted equal to Browserbase's separate file IDs.
          yield* h.click(ClickRequest.make({ selector: "#dialog" }));
          expect((yield* h.readText(ReadTextRequest.make({ selector: "#echo" }))).text).toBe(
            "dialog completed",
          );
          yield* h.click(ClickRequest.make({ selector: "#popup" }));
          // A dispatched click is not a registered target: the popup reaches the
          // session only once Chromium reports it and the owner registers it.
          const pages = yield* settle(session.pages, (open) => open.length === 2);

          expect(pages).toHaveLength(2);
          expect((yield* session.target).pageId).toBe(target.pageId);
          const original = pages.find((page) => page.pageId === target.pageId)!;
          const popup = pages.find((page) => !page.selected)!;

          yield* session.selectPage(popup);
          const selected = yield* session.retain;

          expect((yield* h.readText(ReadTextRequest.make({})).pipe(Effect.result))._tag).toBe(
            "Failure",
          );
          expect((yield* selected.readText(ReadTextRequest.make({}))).text).toContain("next page");
          const added = yield* session.createPage;

          expect((yield* session.target).pageId).toBe(popup.pageId);
          yield* session.closePage(added);
          yield* session.closePage(popup);
          yield* session.selectPage(original);
        }),
      );
    }),
  ),
);

it.live(
  "real CDP: human takeover, atomic fresh observation and explicit keep-alive reconnect",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* localBrowser;

        yield* withProvider(
          f,
          Effect.gen(function* () {
            const session = yield* (yield* BrowserbaseBrowser).open(policy);
            const old = yield* session.retain;

            yield* old.navigate(NavigateRequest.make({ url: f.url }));
            const handoff = yield* session.beginHandoff();

            expect(JSON.stringify(handoff)).not.toContain("token=fixture");
            expect(
              (yield* old.click(ClickRequest.make({ selector: "#increment" })).pipe(Effect.result))
                ._tag,
            ).toBe("Failure");
            // A separate native client stands in for an operator, not provider Live View.
            yield* Effect.promise(() =>
              f.human(session.reference.sessionId, (page) =>
                page.locator("#name").fill("human result"),
              ),
            );
            const resumed = yield* session.resume(handoff.token, true);

            expect(resumed.text).toContain("human result");
            expect((yield* old.readText(ReadTextRequest.make({})).pipe(Effect.result))._tag).toBe(
              "Failure",
            );
            yield* session.detach;
            yield* Effect.promise(() =>
              f.human(session.reference.sessionId, (page) =>
                page.locator("#name").fill("detached result"),
              ),
            );
            const reconnected = yield* session.reconnect(true);

            expect(reconnected.text).toContain("detached result");
            expect(f.connections).toEqual(["session-1", "session-1"]);
            yield* session.click(ClickRequest.make({ selector: "#increment" }));
          }),
          { launch: { ...localLaunch, keepAlive: true } },
        );
        expect(f.releaseIds).toEqual(["session-1"]);
      }),
    ),
);

it.live(
  "real CDP: reconnect preserves selected B after A closes and refuses old page and frame identities",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* localBrowser;

        yield* withProvider(
          f,
          Effect.gen(function* () {
            const session = yield* BrowserbaseBrowser.open(policy);

            yield* session.navigate(NavigateRequest.make({ url: f.url }));
            const firstPage = (yield* session.pages).find((candidate) => candidate.selected)!;
            const page = yield* session.createPage;

            yield* session.selectPage(page);
            // Both pages have the same URL, so only their native identities can distinguish them.
            yield* session.navigate(NavigateRequest.make({ url: f.url }));

            const frames = yield* settle(session.framesOf(page), (listed) =>
              listed.some((frame) => frame.name === "child" && frame.url.endsWith("/frame")),
            );

            const oldFrame = frames.find(
              (frame) => frame.name === "child" && frame.parentFrameId !== null,
            )!;

            expect(
              (yield* (yield* session.pinFrame(page, oldFrame)).readText(
                ReadTextRequest.make({ selector: "#inner" }),
              )).text,
            ).toBe("Frame action");

            const detached = yield* session.detach;

            expect(detached.targetId).toBe(page.targetId);
            yield* Effect.promise(() =>
              f.human(session.reference.sessionId, async (nativePage) => {
                // The fixture's temporary operator connects only after the owner detached.
                const identified = await Promise.all(
                  nativePage
                    .context()
                    .pages()
                    .map(async (candidate) => {
                      const cdp = await candidate.context().newCDPSession(candidate);

                      try {
                        const { targetInfo } = await cdp.send("Target.getTargetInfo");

                        return { page: candidate, targetId: targetInfo.targetId };
                      } finally {
                        await cdp.detach();
                      }
                    }),
                );

                expect(identified).toHaveLength(2);

                const disappearing = identified.filter(
                  (entry) => entry.targetId === firstPage.targetId,
                );

                const surviving = identified.filter((entry) => entry.targetId === page.targetId);

                expect(disappearing).toHaveLength(1);
                expect(surviving).toHaveLength(1);
                const survivor = surviving[0]!.page;

                await disappearing[0]!.page.close();
                expect(disappearing[0]!.page.isClosed()).toBe(true);
                expect(survivor.context().pages()).toEqual([survivor]);

                const navigated = survivor.waitForEvent("framenavigated", {
                  predicate: (frame) =>
                    frame.name() === "replacement" && frame.url().endsWith("/keyframe"),
                  timeout: 5000,
                });

                await survivor.evaluate(() => {
                  document.querySelector("iframe")?.remove();
                  const replacement = document.createElement("iframe");

                  replacement.name = "replacement";
                  replacement.src = "/keyframe";
                  document.body.append(replacement);
                });
                await navigated;
              }),
            );
            yield* session.reconnect(true);

            const reconnected = yield* session.pages;

            expect(reconnected).toHaveLength(1);
            expect(reconnected.some((fresh) => fresh.targetId === firstPage.targetId)).toBe(false);
            const matching = reconnected.filter((fresh) => fresh.targetId === page.targetId);

            expect(matching).toHaveLength(1);
            const freshPage = matching[0]!;

            expect(freshPage.selected).toBe(true);
            expect(freshPage.pageId).not.toBe(firstPage.pageId);
            expect(freshPage.pageId).not.toBe(page.pageId);
            for (const oldPage of [firstPage, page]) {
              for (const refused of [session.selectPage(oldPage), session.closePage(oldPage)]) {
                expect(yield* refused.pipe(Effect.result)).toMatchObject({
                  _tag: "Failure",
                  failure: { reason: { _tag: "NotFound" }, outcome: "undispatched" },
                });
              }
            }
            for (const unchecked of [
              // @ts-expect-error A saved string ID is not checked PageInfo.
              session.selectPage(firstPage.pageId),
              // @ts-expect-error The old first page's ID must never close the surviving page.
              session.closePage(firstPage.pageId),
            ]) {
              expect(yield* unchecked.pipe(Effect.result)).toMatchObject({
                _tag: "Failure",
                failure: { reason: { _tag: "Configuration" }, outcome: "undispatched" },
              });
            }
            expect(yield* session.pinPage(page).pipe(Effect.result)).toMatchObject({
              _tag: "Failure",
              failure: { reason: { _tag: "NotFound" }, outcome: "undispatched" },
            });
            yield* session.selectPage(freshPage);
            expect((yield* session.target).pageId).toBe(freshPage.pageId);
            expect((yield* session.pages).map((entry) => entry.targetId)).toEqual([page.targetId]);

            const stale = yield* session.pinFrame(freshPage, oldFrame).pipe(Effect.result);

            expect(stale._tag).toBe("Failure");
            if (stale._tag === "Failure") {
              expect(stale.failure.reason._tag).toBe("NotFound");
              expect(stale.failure.outcome).toBe("undispatched");
            }

            const freshFrame = (yield* session.framesOf(freshPage)).find(
              (frame) => frame.parentFrameId !== null,
            )!;

            expect(freshFrame.frameId).not.toBe(oldFrame.frameId);
            expect(
              (yield* (yield* session.pinFrame(freshPage, freshFrame)).readText(
                ReadTextRequest.make({ selector: "#inside" }),
              )).text,
            ).toBe("");
          }),
          { launch: { ...localLaunch, keepAlive: true } },
        );
      }),
    ),
);

it.live(
  "real CDP: maintained screencast supports interval stop, restart, resize and parent close",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* localBrowser;

        yield* withProvider(
          f,
          Effect.gen(function* () {
            const session = yield* (yield* BrowserbaseBrowser).open(policy);

            yield* session.navigate(NavigateRequest.make({ url: f.url }));

            const interval = yield* Capture.start(session, {
              maxFrames: 2,
              maxDurationMillis: 2000,
            });

            const collected = yield* interval.frames.pipe(
              Stream.take(5),
              Stream.runCollect,
              Effect.forkChild,
            );

            yield* session.click(ClickRequest.make({ selector: "#increment" }));
            const frames = yield* Fiber.join(collected);

            expect(frames.length).toBe(5);

            const firstFrame = frames[0]!,
              lastFrame = frames[4]!,
              now = yield* Clock.currentTimeMillis;

            expect(firstFrame.sourceClock).toBe("presentation-unix-millis");
            expect(lastFrame.sourceTimeMillis).toBeGreaterThan(firstFrame.sourceTimeMillis);
            expect(Math.abs(lastFrame.sourceTimeMillis - now)).toBeLessThan(10000);
            expect((yield* interval.completed).nativeStop).toBe("confirmed");
            const next = yield* Capture.start(session);

            yield* session.resizeViewport(Viewport.make({ width: 800, height: 600 }));
            expect((yield* next.completed).error?.reason._tag).toBe("Resized");
            const last = yield* Capture.start(session);

            yield* session.close;
            expect((yield* last.completed).error?.reason._tag).toBe("TargetChanged");
            expect((yield* session.retain.pipe(Effect.result))._tag).toBe("Failure");
          }),
        );
      }),
    ),
);

it.live("real CDP: finite native action timeout is unknown, fenced and never replayed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* localBrowser;

      yield* withProvider(
        f,
        Effect.gen(function* () {
          const session = yield* (yield* BrowserbaseBrowser).open(policy);

          yield* session.navigate(NavigateRequest.make({ url: f.url }));

          const failed = yield* session
            .click(ClickRequest.make({ selector: "#disabled" }))
            .pipe(Effect.result);

          expect(failed._tag).toBe("Failure");
          expect((yield* session.retain.pipe(Effect.result))._tag).toBe("Failure");
          expect((yield* session.close).remote).toBe("confirmed");
        }),
        { actionTimeoutMillis: 2000 },
      );
      expect(f.releaseIds).toHaveLength(1);
    }),
  ),
);

// Inferred host requirements remain real framework services; no declaration stubs.
type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const expectedCaptureError: Same<
  Effect.Error<ReturnType<typeof Capture.start>>,
  typeof import("effect-browser/errors").BrowserError.Type
> = true;

const encodedObservation = Schema.toCodecJson(ObservedElement);

it("keeps public typed capture errors and element-reference schemas", () => {
  expect(expectedCaptureError).toBe(true);
  expect(
    Schema.decodeSync(encodedObservation)({
      observationId: "observation-1",
      elementId: "element-0",
    }).elementId,
  ).toBe("element-0");
});
