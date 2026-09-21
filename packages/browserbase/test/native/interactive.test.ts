import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "@effect/vitest";
import { Effect, Fiber, Schema, Stream } from "effect";
import { BrowserbaseBrowser } from "effect-browserbase/browser";
import {
  ObservedElement,
  Viewport,
  ClickRequest,
  FillRequest,
  NavigateRequest,
  ReadTextRequest,
  ScreenshotRequest,
  ScrollRequest,
} from "effect-browserbase/browser-data";
import * as Capture from "effect-browserbase/capture";

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
          const h = session.bind();

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
          const frameHandle = yield* session.selectFrame(child.frameId);

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

            yield* session.bind().navigate(NavigateRequest.make({ url: f.url }));
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
              (yield* session.bind().readText(ReadTextRequest.make({ selector: "#count" }))).text,
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
          const h = session.bind();

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
          const popup = pages.find((page) => !page.selected)!;
          const selected = yield* session.selectPage(popup.pageId);

          expect((yield* h.readText(ReadTextRequest.make({})).pipe(Effect.result))._tag).toBe(
            "Failure",
          );
          expect((yield* selected.readText(ReadTextRequest.make({}))).text).toContain("next page");
          const added = yield* session.createPage;

          expect((yield* session.target).pageId).toBe(popup.pageId);
          yield* session.closePage(added);
          yield* session.closePage(popup.pageId);
          yield* session.selectPage(target.pageId);
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
            const old = session.bind();

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
            yield* session.bind().click(ClickRequest.make({ selector: "#increment" }));
          }),
          { launch: { ...localLaunch, keepAlive: true } },
        );
        expect(f.releaseIds).toEqual(["session-1"]);
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

            yield* session.bind().navigate(NavigateRequest.make({ url: f.url }));

            const interval = yield* Capture.start(session, {
              maxFrames: 2,
              maxDurationMillis: 2000,
            });

            const collected = yield* interval.frames.pipe(
              Stream.take(5),
              Stream.runCollect,
              Effect.forkChild,
            );

            yield* session.bind().click(ClickRequest.make({ selector: "#increment" }));
            const frames = yield* Fiber.join(collected);

            expect(frames.length).toBe(5);
            expect(frames[0].sourceClock).toBe("presentation-unix-millis");
            expect(frames[4].sourceTimeMillis).toBeGreaterThan(frames[0].sourceTimeMillis);
            expect(Math.abs(frames[4].sourceTimeMillis - Date.now())).toBeLessThan(10000);
            expect((yield* interval.completed).nativeStop).toBe("confirmed");
            const next = yield* Capture.start(session);

            yield* session.resizeViewport(Viewport.make({ width: 800, height: 600 }));
            expect((yield* next.completed).error?.reason).toBe("resized");
            const last = yield* Capture.start(session);

            yield* session.close;
            expect((yield* last.completed).error?.reason).toBe("target-changed");
            expect((yield* session.currentTarget.pipe(Effect.result))._tag).toBe("Failure");
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

          yield* session.bind().navigate(NavigateRequest.make({ url: f.url }));

          const failed = yield* session
            .bind()
            .click(ClickRequest.make({ selector: "#disabled" }))
            .pipe(Effect.result);

          expect(failed._tag).toBe("Failure");
          expect((yield* session.currentTarget.pipe(Effect.result))._tag).toBe("Failure");
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
  typeof import("effect-browserbase/errors").BrowserError.Type
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
