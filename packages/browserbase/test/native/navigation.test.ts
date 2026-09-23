import assert from "node:assert/strict";

import { expect, it } from "@effect/vitest";
import { Effect, Option, Schema, Stream } from "effect";
import {
  ClickRequest,
  NavigateRequest,
  ReadTextRequest,
  StartNavigationRequest,
} from "effect-browser/browser-data";
import * as Capture from "effect-browser/capture";
import * as PageControl from "effect-browser/page-control";
import { BrowserbaseBrowser, type BrowserbaseSession } from "effect-browserbase/browser";
import type { Page } from "playwright-core";

import { localBrowser, policy, settle, withProvider } from "../fixtures/LocalBrowser.ts";
import { decodePng } from "../fixtures/Png.ts";

const Counters = Schema.Struct({ ticks: Schema.Natural, chunks: Schema.Natural });

const Progress = Schema.Struct({
  ...Counters.fields,
  freezes: Schema.Array(Counters),
  resumes: Schema.Array(Counters),
  state: Schema.String,
});

const read = (page: Page) =>
  Effect.promise<unknown>(() => page.evaluate("window.read()")).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Progress)),
  );

const chunk = (index: number) => `<p class=chunk>chunk ${index}</p>`;

/**
 * Evidence of a page that is still loading. A read that straddles the document being replaced
 * fails `target-changed` and undispatched, which is the library saying "read again", so this does.
 */
const evidenceOf = <E>(
  session: BrowserbaseSession<E>,
  marker: string,
  options: { readonly picture?: boolean } = {},
) =>
  settle(
    session.checkpoint(options).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "TargetChanged" && error.outcome === "undispatched",
        () => Effect.void,
      ),
    ),
    (sampled) => sampled?.text.includes(marker) === true,
    5000,
  );

/** Observe the real owner connection; a lost acknowledgement never prevents the actual send. */
const countStops = (page: Page, loseAcknowledgement = false) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const context = page.context();
      const original = context.newCDPSession;
      let sent = 0;

      context.newCDPSession = async (subject) => {
        const cdp = await original.call(context, subject);
        const send = cdp.send.bind(cdp);

        cdp.send = async (method, params) => {
          if (method === "Page.stopLoading") sent++;
          const result = await send(method, params);

          if (method === "Page.stopLoading" && loseAcknowledgement)
            throw new Error("PRIVATE-LOST-STOP-ACKNOWLEDGEMENT");

          return result;
        };

        return cdp;
      };

      return {
        count: () => sent,
        restore: () => {
          context.newCDPSession = original;
        },
      };
    }),
    (probe) => Effect.sync(probe.restore),
  );

it.live("real CDP: acknowledged before-unload dismissal retires only its rejected navigation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* localBrowser;

      yield* withProvider(
        f,
        Effect.gen(function* () {
          const session = yield* BrowserbaseBrowser.open(policy);

          const previous = yield* session.startNavigation({ url: f.url });

          expect((yield* previous.completed).url).toBe(f.url);
          const [page] = f.nativePages(session.reference.sessionId);

          assert.ok(page);
          yield* session.click({ selector: "#increment" });

          const activated = yield* Effect.promise(() =>
            page.evaluate(() => {
              sessionStorage.setItem("fixture-before-unload", "0");
              // Keep the listener registered until dismissal. On the pinned Chromium a once-only
              // listener runs without producing the native prompt this regression requires.
              window.onbeforeunload = (event) => {
                sessionStorage.setItem("fixture-before-unload", "1");
                event.preventDefault();
              };

              return navigator.userActivation.hasBeenActive;
            }),
          );

          expect(
            activated,
            "the fixture must have user activation before requesting a leave prompt",
          ).toBe(true);
          let dialogs = 0;

          const observedDialog = () => {
            dialogs++;
          };

          yield* Effect.acquireRelease(
            Effect.sync(() => page.on("dialog", observedDialog)),
            () =>
              Effect.sync(() => {
                page.off("dialog", observedDialog);
              }),
          );
          const stops = yield* countStops(page);
          const original = yield* session.target;

          const cancelled = yield* session.startNavigation({
            url: `${f.url}next`,
            timeoutMillis: 5000,
          });

          expect(yield* cancelled.completed.pipe(Effect.result)).toMatchObject({
            _tag: "Failure",
            failure: {
              operation: "navigate",
              reason: { _tag: "Interrupted" },
              outcome: "unknown",
            },
          });

          const beforeUnloadRan = yield* Effect.promise(() =>
            page.evaluate(() => sessionStorage.getItem("fixture-before-unload")),
          );

          expect(
            beforeUnloadRan,
            "the actual old document must run its before-unload handler",
          ).toBe("1");
          expect(dialogs, "the native leave prompt must reach this owner").toBe(1);
          expect((yield* previous.completed).url).toBe(f.url);
          expect(page.isClosed()).toBe(false);
          expect(stops.count()).toBe(0);
          expect((yield* session.target).pageId).toBe(original.pageId);
          yield* session.click({ selector: "#increment" });
          expect((yield* session.readText({ selector: "#count" })).text).toBe("2");
          expect(yield* session.status).toMatchObject({
            phase: "open",
            reason: null,
            unresolvedDispatch: false,
          });

          yield* Effect.promise(() =>
            page.evaluate(() => {
              window.onbeforeunload = null;
            }),
          );

          // A successor is independent of both completed predecessors and their stop handles.
          const successor = yield* session.startNavigation({
            url: `${f.url}next`,
            timeoutMillis: 5000,
          });

          yield* previous.stop;
          yield* cancelled.stop;
          expect((yield* successor.completed).url).toBe(`${f.url}next`);
          expect(stops.count()).toBe(0);
          expect(dialogs).toBe(1);
          expect((yield* session.readText({})).text).toContain("next page");
        }),
      );
    }),
  ),
);

for (const phase of ["streaming", "precommit"] as const)
  it.live(`real CDP: ${phase} loading timeout sends one stop and preserves a usable page`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* localBrowser;

        yield* withProvider(
          f,
          Effect.gen(function* () {
            const session = yield* BrowserbaseBrowser.open(policy);

            yield* session.navigate({ url: f.url });
            const [page] = f.nativePages(session.reference.sessionId);

            assert.ok(page);
            const stops = yield* countStops(page);
            const path = phase === "streaming" ? "/slow" : "/precommit";

            const result = yield* session
              .navigate({ url: new URL(path, f.url).href, timeoutMillis: 500 })
              .pipe(Effect.result);

            expect(result).toMatchObject({
              _tag: "Failure",
              failure: { operation: "navigate", reason: { _tag: "Timeout" }, outcome: "unknown" },
            });
            expect(stops.count()).toBe(1);
            expect(f.requests.filter((request) => request === path)).toHaveLength(1);
            expect(f.connections).toEqual([session.reference.sessionId]);

            if (phase === "streaming") {
              expect((yield* session.readText({})).text).toContain("chunk 1");
              yield* session.click({ selector: "#act" });
              expect((yield* session.readText({ selector: "#act" })).text).toBe("clicked");
            } else {
              expect((yield* session.readText({})).text).toContain("Local browser fixture");
              yield* session.click({ selector: "#increment" });
              expect((yield* session.readText({ selector: "#count" })).text).toBe("1");
            }

            yield* session.navigate({ url: `${f.url}next` });
            expect((yield* session.observe()).text).toContain("next page");
            expect(stops.count()).toBe(1);
            const receipt = yield* session.closeChecked;

            expect(receipt.issues).toEqual([]);
            expect(receipt.remote).toBe("confirmed");
          }),
        );
      }),
    ),
  );

it.live("real CDP: a lost recovery stop acknowledgement fences without a second stop", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* localBrowser;

      yield* withProvider(
        f,
        Effect.gen(function* () {
          const session = yield* BrowserbaseBrowser.open(policy);
          const [page] = f.nativePages(session.reference.sessionId);

          assert.ok(page);
          const stops = yield* countStops(page, true);

          const operation = yield* session.startNavigation({
            url: `${f.url}slow`,
            timeoutMillis: 500,
          });

          expect(yield* operation.completed.pipe(Effect.result)).toMatchObject({
            _tag: "Failure",
            failure: { reason: { _tag: "Timeout" }, outcome: "unknown" },
          });
          // Completion may be awakened by the fence while the stop permit is still unwinding.
          // Join the recorded stop result before checking terminal admission; nothing is resent.
          for (let caller = 0; caller < 2; caller++)
            expect(yield* operation.stop.pipe(Effect.result)).toMatchObject({
              _tag: "Failure",
              failure: { outcome: "unknown" },
            });
          expect(yield* session.click({ selector: "#act" }).pipe(Effect.result)).toMatchObject({
            _tag: "Failure",
            failure: { reason: { _tag: "Closed" }, outcome: "undispatched" },
          });
          expect(stops.count()).toBe(1);
          expect(f.requests.filter((request) => request === "/slow")).toHaveLength(1);
          yield* session.close;
          expect(stops.count()).toBe(1);
        }),
      );
    }),
  ),
);

it.live("real CDP: a pinned child timeout never sends an automatic page-wide stop", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* localBrowser;

      yield* withProvider(
        f,
        Effect.gen(function* () {
          const session = yield* BrowserbaseBrowser.open(policy);

          yield* session.navigate({ url: f.url });
          const [page] = f.nativePages(session.reference.sessionId);
          const selected = (yield* session.pages).find((candidate) => candidate.selected);

          assert.ok(page);
          assert.ok(selected);

          const frames = yield* settle(session.framesOf(selected), (listed) =>
            listed.some((frame) => frame.name === "child" && frame.url.endsWith("/frame")),
          );

          const child = frames.find((frame) => frame.name === "child");

          assert.ok(child);
          const pinned = yield* session.pinFrame(selected, child);
          const stops = yield* countStops(page);

          expect(
            yield* pinned.navigate({ url: `${f.url}slow`, timeoutMillis: 500 }).pipe(Effect.result),
          ).toMatchObject({
            _tag: "Failure",
            failure: { reason: { _tag: "Timeout" }, outcome: "unknown" },
          });
          expect(stops.count()).toBe(0);
          expect(yield* session.readText({}).pipe(Effect.result)).toMatchObject({
            _tag: "Failure",
            failure: { reason: { _tag: "Closed" }, outcome: "undispatched" },
          });
          expect(f.requests.filter((request) => request === "/slow")).toHaveLength(1);
        }),
      );
    }),
  ),
);

it.live(
  "real CDP: a slow navigation is observed, held and resumed while it loads, then completes once",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* localBrowser;

        yield* withProvider(
          f,
          Effect.gen(function* () {
            const session = yield* (yield* BrowserbaseBrowser).open(policy);
            const handle = session;
            const [stage] = yield* session.pages;

            assert.ok(stage);

            const operation = yield* handle.startNavigation(
              StartNavigationRequest.make({ url: `${f.url}slow`, timeoutMillis: 30000 }),
            );

            // The response is still open, so the navigation has not completed. Giving up on a
            // wait is only that: the browser keeps loading and nothing is dispatched again.
            expect(Option.isNone(yield* operation.completed.pipe(Effect.timeoutOption(300)))).toBe(
              true,
            );

            // Intermediate evidence, read while the document is still arriving.
            const early = yield* evidenceOf(session, "chunk 1", { picture: true });

            assert.ok(early);
            expect(early.text).toContain("chunk 1");
            expect(early.text).not.toContain("chunk 2");
            expect(early.target).toEqual(operation.target);
            assert.ok(early.picture);
            const row = decodePng(early.picture.bytes);

            // The animated box is somewhere along the top row, as painted.
            expect(
              Array.from({ length: 260 }, (_, x) => row.rgb(x, 20)).some(
                ([red, green, blue]) => red > 150 && green < 60 && blue < 60,
              ),
            ).toBe(true);

            // Nothing else may change this page while it is in flight, and nothing was sent.
            for (const mutation of [
              handle.click(ClickRequest.make({ selector: "#act" })),
              handle.navigate(NavigateRequest.make({ url: `${f.url}next` })),
            ]) {
              const refused = yield* mutation.pipe(Effect.result);

              expect(refused._tag).toBe("Failure");
              if (refused._tag === "Failure")
                expect(refused.failure).toMatchObject({
                  reason: { _tag: "Busy" },
                  outcome: "undispatched",
                });
            }

            // Another page is independent: it navigates and reads while the first still loads.
            yield* session.selectPage(yield* session.createPage);

            yield* session.navigate(NavigateRequest.make({ url: `${f.url}next` }));
            expect((yield* session.readText(ReadTextRequest.make({}))).text).toContain("next page");
            yield* session.selectPage(stage);

            const native = f
              .nativePages(session.reference.sessionId)
              .find((page) => page.url().endsWith("/slow"));

            assert.ok(native);

            // Hold it mid-load. A chunk that arrives meanwhile is not parsed, and timers stop:
            // the page's own freeze and resume handlers saw the same counters.
            const receipt = yield* PageControl.suspend(session, stage);

            f.slow.send(chunk(2));
            yield* Effect.sleep(400);
            yield* PageControl.resume(session, receipt);
            const resumed = yield* settle(read(native), (progress) => progress.chunks === 2);

            expect(resumed.freezes).toHaveLength(1);
            expect(resumed.resumes).toEqual(resumed.freezes);
            expect(resumed.freezes[0]?.chunks).toBe(1);
            expect(resumed.chunks).toBe(2);
            expect(resumed.state).toBe("loading");
            // A receipt resumes once.
            expect((yield* PageControl.resume(session, receipt).pipe(Effect.result))._tag).toBe(
              "Failure",
            );

            f.slow.send(chunk(3));
            f.slow.end();
            const result = yield* operation.completed;

            // The page that navigated, not the one that happened to be selected meanwhile.
            expect(result.url).toBe(`${f.url}slow`);
            expect((yield* read(native)).chunks).toBe(3);
            // One dispatch, never replayed, and the page takes input again.
            expect(f.requests.filter((path) => path === "/slow")).toHaveLength(1);
            yield* session.click(ClickRequest.make({ selector: "#act" }));
            yield* session.close;
          }),
          { pageControl: true },
        );
      }),
    ),
);

it.live("real CDP: stopping a navigation is a known outcome, and the session stays usable", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* localBrowser;

      yield* withProvider(
        f,
        Effect.gen(function* () {
          const session = yield* (yield* BrowserbaseBrowser).open(policy);
          const handle = session;

          const operation = yield* handle.startNavigation(
            StartNavigationRequest.make({ url: `${f.url}slow`, timeoutMillis: 30000 }),
          );

          assert.ok(yield* evidenceOf(session, "chunk 1"));
          yield* operation.stop;
          const completed = yield* operation.completed.pipe(Effect.result);

          expect(completed._tag).toBe("Failure");
          if (completed._tag === "Failure")
            expect(completed.failure).toMatchObject({
              operation: "navigate",
              reason: { _tag: "Interrupted" },
            });

          // What had loaded is still there, and the page takes input again. Nothing was replayed.
          expect((yield* handle.readText(ReadTextRequest.make({}))).text).toContain("chunk 1");
          yield* handle.click(ClickRequest.make({ selector: "#act" }));
          expect(f.requests.filter((path) => path === "/slow")).toHaveLength(1);
          f.slow.end();
          yield* session.close;
        }),
      );
    }),
  ),
);

it.live("real CDP: a capture that follows its page covers the loading between two documents", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* localBrowser;

      yield* withProvider(
        f,
        Effect.gen(function* () {
          const session = yield* (yield* BrowserbaseBrowser).open(policy);
          const handle = session;

          yield* handle.navigate(NavigateRequest.make({ url: f.url }));

          // Started before the navigation it is meant to cover.
          const interval = yield* Capture.start(session, {
            lifetime: "page",
            maxFrames: 64,
            maxDurationMillis: 10000,
          });

          const documents: Array<number> = [];

          yield* Stream.runForEach(interval.frames, (frame) =>
            Effect.sync(() => {
              documents.push(frame.document);
            }),
          ).pipe(Effect.forkScoped);
          yield* settle(
            Effect.sync(() => documents.length),
            (count) => count > 0,
            5000,
          );
          yield* handle.navigate(NavigateRequest.make({ url: `${f.url}clocks` }));
          yield* settle(
            Effect.sync(() => documents.includes(1)),
            (seen) => seen,
            5000,
          );
          const live = yield* interval.snapshot;

          expect(live.phase).toBe("capturing");
          expect(live.reason).toBeNull();
          expect(live.nativeStop).toBeNull();
          expect(live.initialUrl).toBe(f.url);
          expect(live.documentBoundaries.map((boundary) => boundary.url)).toEqual([
            `${f.url}clocks`,
          ]);

          const [page] = yield* session.pages;

          assert.ok(page);
          const held = yield* PageControl.suspend(session, page);
          const whileHeld = yield* interval.snapshot;

          // This reads metadata already recorded by the capture, without touching the held DOM.
          expect(whileHeld.phase).toBe("capturing");
          expect(whileHeld.documentBoundaries).toEqual(live.documentBoundaries);
          expect((yield* session.checkpoint().pipe(Effect.result))._tag).toBe("Failure");
          yield* PageControl.resume(session, held);
          const summary = yield* interval.stop;

          // One native screencast the whole way: it was never restarted, so this package left no
          // gap of its own, and it ended because it was stopped, not because the page moved on.
          expect(summary.reason).toBe("stopped");
          expect(summary.error).toBeUndefined();
          expect(summary.nativeStop).toBe("confirmed");
          expect(summary.documentBoundaries.map((boundary) => boundary.document)).toEqual([1]);
          // An address for every document a frame names: enough to draw an address bar over the
          // finished reel without sampling the page between actions.
          expect(summary.initialUrl).toBe(f.url);
          expect(summary.documentBoundaries.map((boundary) => boundary.url)).toEqual([
            `${f.url}clocks`,
          ]);
          expect(summary.documentBoundaries).toEqual(live.documentBoundaries);
          expect(new Set(documents)).toEqual(new Set([0, 1]));
          // Receipt order is kept: no frame of the first document follows one of the second.
          expect(documents).toEqual([...documents].sort((left, right) => left - right));
          yield* session.close;
        }),
        { pageControl: true },
      );
    }),
  ),
);
