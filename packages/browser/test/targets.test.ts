import { EventEmitter } from "node:events";

import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { Browser, BrowserContext, Frame, Page } from "playwright-core";

import { makeOwner, native, type Ticket } from "../src/internal/browser/Owner.ts";
import { makeTargets, type TargetHooks } from "../src/internal/browser/Targets.ts";

const ticket = (): Ticket => {
  let dispatched = false;

  return {
    signal: new AbortController().signal,
    deadline: 10000,
    generation: 0,
    get dispatched() {
      return dispatched;
    },
    remainingMillis: () => 1000,
    check: () => {},
    dispatch: () => {
      dispatched = true;
    },
  };
};

/** Only the native registry boundary is scripted. Each registry owns its real identity checks. */
const registry = (
  options: { readonly failMetadata?: boolean; readonly maxPages?: number } = {},
) => {
  let serial = 0;
  const identities = new WeakMap<Page, string>();
  const calls = { created: 0, closed: 0, detached: 0, titles: [] as number[] };
  const changes: Array<Parameters<TargetHooks["changed"]>> = [];
  const overflows: Array<Parameters<TargetHooks["overflow"]>[0]> = [];

  const page = () => {
    const index = ++serial;
    let closed = false;

    const frame = {
      isDetached: () => closed,
      parentFrame: () => null,
      url: () => `https://example.test/${index}`,
      name: () => "main",
    } as Frame;

    const nativePage = Object.assign(new EventEmitter(), {
      frames: () => [frame],
      mainFrame: () => frame,
      url: () => `https://example.test/${index}`,
      isClosed: () => closed,
      title: async () => {
        calls.titles.push(index);
        if (options.failMetadata && index > 1) throw new Error("PRIVATE-METADATA-FAILURE");

        return `page ${index}`;
      },
      close: async () => {
        calls.closed++;
        closed = true;
        nativePage.emit("close");
      },
    });

    const result = nativePage as unknown as Page;

    identities.set(result, `native-${index}`);

    return result;
  };

  const targets = makeTargets(
    { isConnected: () => true } as Browser,
    {
      newPage: async () => {
        calls.created++;

        return page();
      },
      newCDPSession: async (page: Page) => ({
        send: async () => ({ targetInfo: { type: "page", targetId: identities.get(page) } }),
        detach: async () => {
          calls.detached++;
        },
      }),
    } as unknown as BrowserContext,
    {
      viewport: { width: 640, height: 480 },
      popupPolicy: "retain",
      dialogPolicy: "dismiss",
      maxPages: options.maxPages ?? 3,
    },
    () => false,
    {
      opened: () => {},
      overflow: (entry) => {
        overflows.push(entry);
      },
      closed: () => {},
      navigating: () => {},
      navigated: () => {},
      frameChanged: () => {},
      dialog: () => {},
      changed: (...change) => {
        changes.push(change);
      },
    },
  );

  const initial = targets.register(page());

  targets.selection.entry = initial;
  targets.selection.frame = initial.page.mainFrame();

  return { targets, calls, changes, overflows, popup: () => targets.register(page()) };
};

it("independent registries refuse foreign page metadata and mismatched native target IDs before close", async () => {
  const first = registry();
  const second = registry();
  const [foreign] = await first.targets.listPages(ticket());
  const [local] = await second.targets.listPages(ticket());

  expect(foreign!.targetId).toBe(local!.targetId);
  expect(foreign!.pageId).not.toBe(local!.pageId);
  for (const run of [second.targets.selectPage, second.targets.closePage]) {
    const admission = ticket();

    await expect(run(foreign!, admission)).rejects.toMatchObject({
      reason: { _tag: "NotFound" },
      outcome: "undispatched",
    });
    await expect(
      run({ ...local!, targetId: "other-native-target" }, admission),
    ).rejects.toMatchObject({ reason: { _tag: "Stale" }, outcome: "undispatched" });
    expect(admission.dispatched).toBe(false);
  }
  expect(second.calls.closed).toBe(0);
  expect(second.targets.selected().pageId).toBe(local!.pageId);
});

it("creation returns the exact new page without selecting it or rereading other titles", async () => {
  const f = registry();
  const [initial] = await f.targets.listPages(ticket());
  const admission = ticket();
  const created = await f.targets.newPage(admission);

  expect(created).toMatchObject({
    targetId: "native-2",
    title: "page 2",
    url: "https://example.test/2",
    selected: false,
  });
  expect(created.pageId).not.toBe(initial!.pageId);
  expect(f.targets.selected().pageId).toBe(initial!.pageId);
  expect(f.calls.titles).toEqual([1, 2]);
  expect(f.calls.created).toBe(1);
  expect(admission.dispatched).toBe(true);
});

it.effect(
  "metadata failure after creating a page retains unknown dispatch evidence and prevents replay",
  () =>
    Effect.gen(function* () {
      const f = registry({ failMetadata: true });

      const owner = yield* makeOwner({
        maxActions: 10,
        maxHostReads: 10_000,
        maxElapsedMillis: 10000,
        actionTimeoutMillis: 1000,
      });

      owner.state.phase = "open";

      const create = owner.guard(
        "new-page",
        (ticket) => native("new-page", ticket, () => f.targets.newPage(ticket)),
        { mutation: true, charge: false },
      );

      expect(yield* Effect.result(create)).toMatchObject({
        _tag: "Failure",
        failure: { operation: "new-page", reason: { _tag: "Provider" }, outcome: "unknown" },
      });
      expect(yield* Effect.result(create)).toMatchObject({
        _tag: "Failure",
        failure: { reason: { _tag: "Closed" }, outcome: "undispatched" },
      });
      expect(f.calls.created).toBe(1);
      expect(f.calls.detached).toBe(1);
      expect(f.calls.titles).toEqual([2]);
      expect(owner.state.phase).toBe("uncertain");
    }),
);

it("page capacity reports its actual count and configured maximum without dispatch", async () => {
  const f = registry({ maxPages: 1 });
  const admission = ticket();

  await expect(f.targets.newPage(admission)).rejects.toMatchObject({
    reason: { _tag: "Limit", dimension: "pages", maximum: 1, observed: 1 },
    outcome: "undispatched",
  });
  expect(admission.dispatched).toBe(false);
  expect(f.calls.created).toBe(0);
});

it("an excess native page is handed to its configured policy once without changing selection or silently closing it", () => {
  const f = registry({ maxPages: 1 });
  const original = f.targets.selected();
  const popup = f.popup();

  expect(f.targets.register(popup.page)).toBe(popup);
  expect(f.overflows).toEqual([popup]);
  expect(f.calls.closed).toBe(0);
  expect(f.targets.entries.size).toBe(1);
  expect(f.targets.selected()).toEqual(original);
});

it("selection notifications preserve retained nodes while a selected page close retires its own page", async () => {
  const f = registry();
  const page = await f.targets.newPage(ticket());
  const admission = ticket();

  await f.targets.selectPage(page, admission);
  const [frame] = await f.targets.listFrames(ticket());

  await f.targets.selectFrame(frame!.frameId, admission);
  expect(admission.dispatched).toBe(false);
  expect(f.changes).toEqual([
    ["target-changed", "none"],
    ["target-changed", "none"],
  ]);
  await f.targets.closePage(page, ticket());
  expect(f.changes[2]).toEqual(["target-changed", { pageId: page.pageId }]);
  expect(f.calls.closed).toBe(1);
});
