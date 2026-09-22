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
        (error) => error.reason === "target-changed" && error.outcome === "undispatched",
        () => Effect.succeed(undefined),
      ),
    ),
    (sampled) => sampled?.text.includes(marker) === true,
    5000,
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
            const handle = session.bind();
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
                expect(refused.failure).toMatchObject({ reason: "busy", outcome: "undispatched" });
            }

            // Another page is independent: it navigates and reads while the first still loads.
            const scout = yield* session.selectPage(yield* session.createPage);

            yield* scout.navigate(NavigateRequest.make({ url: `${f.url}next` }));
            expect((yield* scout.readText(ReadTextRequest.make({}))).text).toContain("next page");
            yield* session.selectPage(stage.pageId);

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
            yield* session.bind().click(ClickRequest.make({ selector: "#act" }));
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
          const handle = session.bind();

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
              reason: "interrupted",
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
          const handle = session.bind();

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
          expect(documents).toEqual([...documents].sort());
          yield* session.close;
        }),
        { pageControl: true },
      );
    }),
  ),
);
