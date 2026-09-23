import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Redacted } from "effect";
import { TestClock } from "effect/testing";

import * as Bootstrap from "../src/Bootstrap.ts";
import { PageInfo } from "../src/BrowserData.ts";
import { makeBindings } from "../src/internal/browser/Bindings.ts";
import type { Driver } from "../src/internal/browser/Driver.ts";
import { makeSession } from "../src/internal/browser/PublicSession.ts";
import { acquireSession } from "../src/internal/browser/Session.ts";

/** Only the native calls exercised below are scripted; admission, scopes and navigation are real. */
const fixture = Effect.fnUntraced(function* (onRead?: () => Promise<void>) {
  const pages = ["a", "b"].map((id) =>
    PageInfo.make({
      pageId: `page-${id}`,
      targetId: `target-${id}`,
      title: id,
      url: `https://example.test/${id}`,
      selected: id === "a",
    }),
  );

  let selected = pages[0]!.pageId;
  let selectedReads = 0;
  let closes = 0;
  const reads: string[] = [];
  const navigations: Array<{ pageId: string; timeoutMillis: number }> = [];

  const driver = {
    selected: () => {
      selectedReads++;

      return { pageId: selected, frameId: `frame-${selected}` };
    },
    selectedTargetId: async () => selected,
    documentReadiness: async () => ({ _tag: "Ready" as const }),
    invalidateObservation: () => {},
    disconnect: async () => {
      closes++;
    },
    readText: async (_selector, _maximum, ticket, target) => {
      const pageId = target?.pageId ?? selected;

      reads.push(pageId);
      await onRead?.();
      ticket.check();

      return pageId;
    },
    selectPage: async (page, ticket) => {
      ticket.check();
      selected = page.pageId;
    },
    resolvePage: async (page, ticket) => {
      ticket.check();

      return { pageId: page.pageId, frameId: `frame-${page.pageId}` };
    },
    beginNavigation: async (url, timeoutMillis, ticket, target) => {
      ticket.dispatch();
      const pageId = target?.pageId ?? selected;

      navigations.push({ pageId, timeoutMillis });

      return {
        pageId,
        settled: Promise.resolve(url),
        stop: async () => {
          throw new Error("Unexpected stop for a completed fixture navigation");
        },
      };
    },
  } satisfies Pick<
    Driver,
    | "selected"
    | "selectedTargetId"
    | "documentReadiness"
    | "invalidateObservation"
    | "disconnect"
    | "readText"
    | "selectPage"
    | "resolvePage"
    | "beginNavigation"
  >;

  const bindings = yield* makeBindings(Bootstrap.empty);

  const acquired = yield* acquireSession(
    { maxActions: 20, maxHostReads: 10_000, maxElapsedMillis: 10000, actionTimeoutMillis: 400 },
    {
      implementation: "target-test",
      // Unexpected use of an unimplemented native method is a fixture defect.
      engine: {
        connect: (request) =>
          Effect.sync(() => {
            request.onSettled();

            return driver as unknown as Driver;
          }),
      },
      remote: (cleanup) =>
        Effect.gen(function* () {
          const release = yield* Effect.cached(
            cleanup.fence.pipe(
              Effect.andThen(cleanup.capture),
              Effect.andThen(cleanup.initialization),
              Effect.andThen(cleanup.disconnect),
              Effect.orDie,
              Effect.asVoid,
            ),
          );

          yield* Effect.addFinalizer(() => release);

          return {
            reference: "target-test",
            connection: () => Effect.succeed(Redacted.make("test:owned-connection")),
            release,
            cleanupResult: Effect.succeedNone,
            closeChecked: release,
          };
        }),
      keepAlive: false,
      connectBindings: bindings.connect,
      maxReturnedBytes: 65536,
      driver: {
        viewport: { width: 640, height: 480 },
        popupPolicy: "retain",
        dialogPolicy: "dismiss",
        maxPages: 2,
      },
    },
  ).pipe(Effect.provide(NodeCrypto.layer));

  const controls = yield* acquired.connect;

  return {
    session: makeSession(controls, bindings),
    pages,
    reads,
    navigations,
    selectedReads: () => selectedReads,
    closes: () => closes,
  };
});

it.effect(
  "direct selection is resolved at admission while retained and pinned targets keep their contracts",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const direct = f.session.readText({});
        const retained = yield* f.session.retain;
        const pinned = yield* f.session.pinPage(f.pages[0]!);

        yield* f.session.selectPage(f.pages[1]!);
        expect((yield* direct).text).toBe("page-b");
        expect(yield* Effect.result(retained.readText({}))).toMatchObject({
          _tag: "Failure",
          failure: { reason: { _tag: "Stale" }, outcome: "undispatched" },
        });
        expect((yield* pinned.readText({})).text).toBe("page-a");
        yield* f.session.selectPage(f.pages[0]!);
        expect(yield* Effect.result(retained.readText({}))).toMatchObject({
          _tag: "Failure",
          failure: { reason: { _tag: "Stale" }, outcome: "undispatched" },
        });
        expect(f.reads).toEqual(["page-b", "page-a"]);
        expect((yield* (yield* f.session.retain).readText({})).text).toBe("page-a");
      }),
    ),
);

it.effect("retain refuses busy and closed owners before reading native selection", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      let release: () => void = () => {};

      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });

      const f = yield* fixture(async () => {
        Deferred.doneUnsafe(entered, Effect.void);
        await gate;
      });

      const reading = yield* Effect.forkChild(f.session.readText({}));

      yield* Deferred.await(entered);
      const before = f.selectedReads();

      expect(yield* Effect.result(f.session.retain)).toMatchObject({
        _tag: "Failure",
        failure: { reason: { _tag: "Busy" }, outcome: "undispatched" },
      });
      expect(f.selectedReads()).toBe(before);
      release();
      yield* Fiber.join(reading);
      yield* f.session.retain;
      yield* f.session.closeChecked;
      const closed = f.selectedReads();

      expect(yield* Effect.result(f.session.retain)).toMatchObject({
        _tag: "Failure",
        failure: { reason: { _tag: "Closed" }, outcome: "undispatched" },
      });
      expect(f.selectedReads()).toBe(closed);
      expect(f.closes()).toBe(1);
    }),
  ),
);

it.effect(
  "all target modes propagate the loading timeout independently of admission and cap it by lifetime",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const views = [f.session, yield* f.session.retain, yield* f.session.pinPage(f.pages[0]!)];

        for (const view of views) yield* view.navigate({ url: "https://example.test/default" });
        for (const view of views)
          yield* view.navigate({ url: "https://example.test/long", timeoutMillis: 8000 });
        yield* TestClock.adjust(8500);
        for (const view of views)
          yield* view.navigate({ url: "https://example.test/capped", timeoutMillis: 8000 });
        expect(f.navigations.map((call) => call.timeoutMillis)).toEqual([
          400, 400, 400, 8000, 8000, 8000, 1500, 1500, 1500,
        ]);
        expect(f.navigations).toHaveLength(9);
      }),
    ),
);
