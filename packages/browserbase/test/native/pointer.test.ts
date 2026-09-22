import assert from "node:assert/strict";

import { expect, it } from "@effect/vitest";
import { Effect, Schema, Stream } from "effect";
import {
  HoverRequest,
  NavigateRequest,
  ObservedElement,
  PointerMoveRequest,
  ScreenshotRequest,
  ScrollRequest,
  WheelRequest,
} from "effect-browser/browser-data";
import * as Capture from "effect-browser/capture";
import { BrowserbaseBrowser } from "effect-browserbase/browser";
import type { Page } from "playwright-core";

import { localBrowser, policy, settle, withProvider } from "../fixtures/LocalBrowser.ts";
import { decodePng } from "../fixtures/Png.ts";
import { pointerFrameSite } from "../fixtures/PointerFrames.ts";

const Log = Schema.Struct({
  moves: Schema.Array(
    Schema.Struct({ x: Schema.Finite, y: Schema.Finite, trusted: Schema.Boolean }),
  ),
  entered: Schema.Array(Schema.Struct({ id: Schema.String, trusted: Schema.Boolean })),
  wheels: Schema.Array(
    Schema.Struct({ deltaY: Schema.Finite, trusted: Schema.Boolean, inside: Schema.Boolean }),
  ),
  pageY: Schema.Finite,
  outerTop: Schema.Finite,
});

const read = (page: Page) =>
  Effect.promise<unknown>(() => page.evaluate("window.read()")).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Log)),
  );

const Moves = Schema.Array(
  Schema.Struct({ x: Schema.Finite, y: Schema.Finite, trusted: Schema.Boolean }),
);

it.live("real CDP: hover reaches a nested cross-origin frame in main-viewport coordinates", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* localBrowser;
      const site = yield* pointerFrameSite;

      yield* withProvider(
        f,
        Effect.gen(function* () {
          const session = yield* (yield* BrowserbaseBrowser).open(policy);

          yield* session.navigate(NavigateRequest.make({ url: f.url }));
          const [page] = f.nativePages(session.reference.sessionId);

          assert.ok(page);
          yield* Effect.promise(() => page.setContent(site.page));

          const frames = yield* settle(session.frames, (listed) =>
            listed.some((frame) => frame.name === "leaf"),
          );

          const target = frames.find((frame) => frame.name === "leaf");
          const leaf = page.frame({ name: "leaf" });

          assert.ok(target);
          assert.ok(leaf);
          expect(new URL(leaf.url()).origin).toBe(site.origin);
          expect(site.origin).not.toBe(new URL(page.url()).origin);
          yield* session.selectFrame(target.frameId);
          const handle = session;
          const receipt = yield* handle.hover(HoverRequest.make({ selector: "#target" }));

          const events = yield* Effect.promise<unknown>(() => leaf.evaluate("window.moves")).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Moves)),
          );

          // Main clip offset + each iframe's border/offset + the button's center.
          expect(receipt.position).toEqual({ x: 137, y: 97 });
          expect(receipt.target.frameId).toBe(target.frameId);
          expect(events.at(-1)).toEqual({ x: 70, y: 40, trusted: true });
          yield* session.close;
        }),
      );
    }),
  ),
);

it.live("real CDP: a nested hover refuses clipping and occlusion in every ancestor", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* localBrowser;
      const site = yield* pointerFrameSite;

      yield* withProvider(
        f,
        Effect.gen(function* () {
          const session = yield* (yield* BrowserbaseBrowser).open(policy);

          yield* session.navigate(NavigateRequest.make({ url: f.url }));
          const [page] = f.nativePages(session.reference.sessionId);

          assert.ok(page);
          yield* Effect.promise(() => page.setContent(site.page));

          const frames = yield* settle(session.frames, (listed) =>
            listed.some((frame) => frame.name === "leaf"),
          );

          const target = frames.find((frame) => frame.name === "leaf");
          const outer = page.frame({ name: "outer" });
          const leaf = page.frame({ name: "leaf" });

          assert.ok(target);
          assert.ok(outer);
          assert.ok(leaf);
          yield* session.selectFrame(target.frameId);
          const handle = session;

          const counts = () =>
            Effect.promise<unknown>(() =>
              Promise.all(
                [page.mainFrame(), outer, leaf].map((frame) =>
                  frame.evaluate("window.moves.length"),
                ),
              ),
            ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Natural))));

          const cases = [
            {
              name: "main overlay",
              setup: () => page.evaluate("document.querySelector('#cover').hidden=false"),
            },
            {
              name: "parent overlay",
              setup: () => outer.evaluate("document.querySelector('#cover').hidden=false"),
            },
            {
              name: "ancestor clip",
              setup: () => page.evaluate("document.querySelector('#clip').style.width='80px'"),
            },
            {
              name: "unsupported frame rotation",
              setup: () =>
                page.evaluate("document.querySelector('iframe').style.transform='rotate(10deg)'"),
            },
          ];

          for (const test of cases) {
            yield* Effect.promise(() =>
              page.evaluate(
                "document.querySelector('#cover').hidden=true;document.querySelector('#clip').style.width='410px';document.querySelector('iframe').style.transform='none'",
              ),
            );
            yield* Effect.promise(() =>
              outer.evaluate("document.querySelector('#cover').hidden=true"),
            );
            yield* handle.pointerMove(PointerMoveRequest.make({ to: { x: 1, y: 1 } }));
            yield* Effect.promise(test.setup);
            const before = yield* counts();

            const result = yield* handle
              .hover(HoverRequest.make({ selector: "#target" }))
              .pipe(Effect.result);

            expect(result._tag, test.name).toBe("Failure");
            if (result._tag === "Failure")
              expect(result.failure, test.name).toMatchObject({
                reason: { _tag: "NotVisible" },
                outcome: "undispatched",
              });
            expect(yield* counts(), test.name).toEqual(before);
          }
          yield* session.close;
        }),
      );
    }),
  ),
);

it.live(
  "real CDP: pointer moves, hover and wheel are real input the browser hit-tests itself",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* localBrowser;

        yield* withProvider(
          f,
          Effect.gen(function* () {
            const session = yield* (yield* BrowserbaseBrowser).open(policy);
            const handle = session;

            yield* handle.navigate(NavigateRequest.make({ url: `${f.url}pointer` }));
            const [native] = f.nativePages(session.reference.sessionId);

            assert.ok(native);

            const padColor = Effect.gen(function* () {
              const shot = yield* handle.screenshot(ScreenshotRequest.make({ fullPage: false }));

              return decodePng(shot.bytes).rgb(140, 100);
            });

            expect(yield* padColor).toEqual([200, 0, 0]);

            const moved = yield* handle.pointerMove(
              PointerMoveRequest.make({ to: { x: 140, y: 100 } }),
            );

            expect(moved.kind).toBe("pointer-move");
            expect(moved.position).toEqual({ x: 140, y: 100 });
            expect(moved.target).toEqual(yield* session.target);
            expect(moved.completedMonotonicNanos).toBeGreaterThanOrEqual(
              moved.startedMonotonicNanos,
            );
            const afterMove = yield* read(native);

            // A trusted event at the commanded point, and the browser's own `:hover`, which a
            // scripted `dispatchEvent` can never produce. The pixels say so, not the page.
            expect(afterMove.moves.at(-1)).toEqual({ x: 140, y: 100, trusted: true });
            expect(afterMove.entered).toEqual([{ id: "pad", trusted: true }]);
            expect(yield* padColor).toEqual([0, 0, 200]);

            // The browser chooses what scrolls: a nested container under the pointer, not the page.
            const nested = yield* handle.wheel(
              WheelRequest.make({ deltaX: 0, deltaY: 200, at: { x: 420, y: 120 } }),
            );

            expect(nested.kind).toBe("wheel");
            expect(nested.position).toEqual({ x: 420, y: 120 });
            expect(nested.delta).toEqual({ x: 0, y: 200 });
            // A wheel event is dispatched, not awaited, so scrolling is waited for, never assumed.
            const scrolledNested = yield* settle(read(native), (log) => log.outerTop > 0);

            expect(scrolledNested.outerTop).toBeGreaterThan(0);
            expect(scrolledNested.pageY).toBe(0);
            expect(scrolledNested.wheels).toEqual([{ deltaY: 200, trusted: true, inside: true }]);

            // Without a point, the wheel lands wherever the pointer already is.
            yield* handle.pointerMove(PointerMoveRequest.make({ to: { x: 600, y: 400 } }));
            const page = yield* handle.wheel(WheelRequest.make({ deltaX: 0, deltaY: 150 }));

            expect(page.position).toEqual({ x: 600, y: 400 });
            const scrolledPage = yield* settle(read(native), (log) => log.pageY > 0);

            expect(scrolledPage.pageY).toBeGreaterThan(0);
            expect(scrolledPage.wheels.at(-1)).toEqual({
              deltaY: 150,
              trusted: true,
              inside: false,
            });

            // Scripted scrolling stays distinguishable: the page moves and no wheel event exists.
            const wheelsBefore = scrolledPage.wheels.length;

            yield* handle.scroll(ScrollRequest.make({ deltaX: 0, deltaY: -scrolledPage.pageY }));
            const scripted = yield* read(native);

            expect(scripted.pageY).toBe(0);
            expect(scripted.wheels).toHaveLength(wheelsBefore);
            yield* session.close;
          }),
        );
      }),
    ),
);

it.live("real CDP: hover places the pointer on one exact element, or sends nothing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* localBrowser;

      yield* withProvider(
        f,
        Effect.gen(function* () {
          const session = yield* (yield* BrowserbaseBrowser).open(policy);
          const handle = session;

          yield* handle.navigate(NavigateRequest.make({ url: `${f.url}pointer` }));
          const [native] = f.nativePages(session.reference.sessionId);

          assert.ok(native);
          const hovered = yield* handle.hover(HoverRequest.make({ selector: "#pad" }));

          // The centre of a 200x120 box at (40, 40): a point this owner chose and can report.
          expect(hovered.kind).toBe("hover");
          expect(hovered.position).toEqual({ x: 140, y: 100 });
          expect((yield* read(native)).entered).toEqual([{ id: "pad", trusted: true }]);

          // Covered, and below the fold. Hover never scrolls to reach an element, because that
          // would hide a scripted scroll inside a native-input operation.
          for (const selector of ["#covered", "#below"]) {
            const movesBefore = (yield* read(native)).moves.length;

            const refused = yield* handle
              .hover(HoverRequest.make({ selector }))
              .pipe(Effect.result);

            expect(refused._tag, selector).toBe("Failure");
            if (refused._tag === "Failure") {
              expect(refused.failure.operation).toBe("hover");
              expect(refused.failure.reason._tag, selector).toBe("NotVisible");
              expect(refused.failure.outcome).toBe("undispatched");
            }
            expect((yield* read(native)).moves, selector).toHaveLength(movesBefore);
          }

          // The exact node an observation named, not whatever a selector matches later.
          const observation = yield* session.observe();
          const plain = observation.controls.find((control) => control.label === "Plain");

          assert.ok(plain);

          const byNode = yield* session.hoverElement(
            ObservedElement.make({
              observationId: observation.observationId,
              elementId: plain.elementId,
            }),
          );

          expect(byNode.position).toEqual({ x: 100, y: 195 });
          expect((yield* read(native)).entered.at(-1)).toEqual({ id: "plain", trusted: true });
          yield* session.close;
        }),
      );
    }),
  ),
);

it.live("real CDP: input through a handle bound to another page reaches neither page", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* localBrowser;

      yield* withProvider(
        f,
        Effect.gen(function* () {
          const session = yield* (yield* BrowserbaseBrowser).open(policy);
          const first = yield* session.retain;

          yield* first.navigate(NavigateRequest.make({ url: `${f.url}pointer` }));
          yield* session.selectPage(yield* session.createPage);
          const second = yield* session.retain;

          yield* second.navigate(NavigateRequest.make({ url: `${f.url}pointer#second` }));
          const natives = f.nativePages(session.reference.sessionId);

          expect(natives).toHaveLength(2);

          const inputs = [
            first.pointerMove(PointerMoveRequest.make({ to: { x: 140, y: 100 } })),
            first.hover(HoverRequest.make({ selector: "#pad" })),
            first.wheel(WheelRequest.make({ deltaX: 0, deltaY: 200 })),
          ];

          for (const input of inputs) {
            const refused = yield* input.pipe(Effect.result);

            expect(refused._tag).toBe("Failure");
            if (refused._tag === "Failure") {
              expect(refused.failure.reason._tag).toBe("Stale");
              expect(refused.failure.outcome).toBe("undispatched");
            }
          }
          for (const native of natives) {
            const log = yield* read(native);

            expect(log.moves).toEqual([]);
            expect(log.wheels).toEqual([]);
          }
          // The page that is selected still takes input, through its own handle.
          yield* second.pointerMove(PointerMoveRequest.make({ to: { x: 140, y: 100 } }));
          const selected = natives.find((native) => native.url().endsWith("#second"));

          assert.ok(selected);
          expect((yield* read(selected)).entered).toEqual([{ id: "pad", trusted: true }]);
          yield* session.close;
        }),
      );
    }),
  ),
);

it.live("real CDP: a receipt and the frames it caused share one timeline", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* localBrowser;

      yield* withProvider(
        f,
        Effect.gen(function* () {
          const session = yield* (yield* BrowserbaseBrowser).open(policy);
          const handle = session;

          yield* handle.navigate(NavigateRequest.make({ url: `${f.url}pointer` }));
          const interval = yield* Capture.start(session, { maxDurationMillis: 8000 });
          const received: Array<bigint> = [];

          yield* Stream.runForEach(interval.frames, (frame) =>
            Effect.sync(() => {
              received.push(frame.receivedMonotonicNanos);
            }),
          ).pipe(Effect.forkScoped);

          // The page is static: it paints once on opening, and again only when input repaints it.
          yield* settle(
            Effect.sync(() => received.length),
            (count) => count > 0,
            5000,
          );
          const hovered = yield* handle.hover(HoverRequest.make({ selector: "#pad" }));
          const started = hovered.startedMonotonicNanos;

          const after = yield* settle(
            Effect.sync(() => received.filter((at) => at >= started)),
            (frames) => frames.length > 0,
            5000,
          );

          // One host monotonic clock stamps both. Were they different clocks, the opening frame
          // would not sort before the input, or the repaint would not land within moments of it.
          expect(received.some((at) => at < started)).toBe(true);
          const repaint = after[0];

          assert.ok(repaint !== undefined);
          expect(repaint - started).toBeLessThan(5_000_000_000n);
          yield* interval.stop;
          yield* session.close;
        }),
      );
    }),
  ),
);
