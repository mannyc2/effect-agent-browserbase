import assert from "node:assert/strict";

import { NodeCrypto } from "@effect/platform-node";
import { expect, it, vi } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Redacted, Schedule } from "effect";
import type { AnySession } from "effect-browser/browser";
import {
  BrowserPolicy,
  type Observation,
  ObservedElement,
  WaitForElementRequest,
} from "effect-browser/browser-data";
import { Chromium } from "effect-browser/chromium";
import type { BrowserError } from "effect-browser/errors";
import * as PageControl from "effect-browser/page-control";
import { chromium, type ElementHandle, type Frame, type Page } from "playwright-core";

import { externalChromium, localSite } from "../fixtures/StandaloneBrowser.ts";

const content = `<!doctype html><title>Owned waits</title>
<style>button{margin:12px;padding:12px}</style>
<h1>Wait fixture</h1><button id=target aria-label=Target>Target</button>
<button id=act aria-label=Act onclick="count.textContent=Number(count.textContent)+1">Act</button>
<output id=count>0</output>`;

const fixture = Effect.fnUntraced(function* () {
  const site = yield* localSite;
  const host = yield* externalChromium;

  const operator = yield* Effect.acquireRelease(
    Effect.promise(() =>
      chromium.connectOverCDP(Redacted.value(host.endpoint), { noDefaults: true }),
    ),
    (browser) => Effect.promise(() => browser.close()),
  );

  const session = yield* Chromium.attach(host.endpoint, {
    policy: BrowserPolicy.unrestricted({ maxActions: 100, maxElapsedMillis: 60000 }),
  });

  yield* session.navigate({ url: site.url });
  const page = operator.contexts()[0]?.pages()[0];

  assert.ok(page);
  yield* Effect.promise(() => page.setContent(content));

  return { session, page, operator, site, host };
});

const layer = Chromium.layer({
  pageControl: true,
  actionTimeoutMillis: 15000,
  viewport: { width: 640, height: 480 },
}).pipe(Layer.provide(NodeCrypto.layer));

const reference = (observation: Observation, label = "Target") => {
  const control = observation.controls.find((control) => control.label === label);

  assert.ok(control, label);

  return ObservedElement.make({
    observationId: observation.observationId,
    elementId: control.elementId,
  });
};

const idle = (session: AnySession) =>
  session.status.pipe(
    Effect.repeat({ while: (status) => status.busy, schedule: Schedule.spaced("5 millis") }),
    Effect.timeout("5 seconds"),
  );

const forkWait = Effect.fnUntraced(function* (wait: Effect.Effect<void, BrowserError>) {
  const done = yield* Deferred.make<void>();
  let successes = 0;

  const fiber = yield* wait.pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        successes++;
      }),
    ),
    Effect.onExit(() => Deferred.succeed(done, undefined)),
    Effect.forkChild,
  );

  return { fiber, done, successes: () => successes };
});

/** Observe the installed native call, forwarding its actual receiver, state, timeout and signal. */
const watchElementWait = Effect.fnUntraced(function* (
  page: Page,
  afterFirstSettlement?: () => Promise<void>,
) {
  const sample = yield* Effect.promise(() => page.$("#target"));

  assert.ok(sample);
  const prototype: ElementHandle<Element> = Object.getPrototypeOf(sample);

  yield* Effect.promise(() => sample.dispose());
  // oxlint-disable-next-line typescript/unbound-method -- the spy calls it on each handle
  const native = prototype.waitForElementState;

  const entered = yield* Deferred.make<{
    readonly element: ElementHandle<Element>;
    readonly signal: AbortSignal | undefined;
    readonly timeout: number | undefined;
  }>();

  const settled = yield* Deferred.make<void>();
  let calls = 0;
  const spy = vi.spyOn(prototype, "waitForElementState");

  yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
  spy.mockImplementation(async function (this: ElementHandle<Element>, state, options) {
    const first = calls++ === 0;
    const result = native.call(this, state, options);

    if (first)
      Deferred.doneUnsafe(
        entered,
        Effect.succeed({ element: this, signal: options?.signal, timeout: options?.timeout }),
      );
    try {
      await result;
    } finally {
      if (first) {
        Deferred.doneUnsafe(settled, Effect.void);
        await afterFirstSettlement?.();
      }
    }
  });

  return { entered, settled, calls: () => calls };
});

/** A returned selector handle belongs to the library; record when its real disposal completes. */
const watchSelectorWait = Effect.fnUntraced(function* (
  page: Page,
  afterFirstResult?: () => Promise<void>,
) {
  const prototype: Frame = Object.getPrototypeOf(page.mainFrame());
  // oxlint-disable-next-line typescript/unbound-method -- the spy calls it on each frame
  const native = prototype.waitForSelector;
  const entered = yield* Deferred.make<void>();
  const returned = yield* Deferred.make<void>();
  const disposed = yield* Deferred.make<void>();
  const restores: Array<() => void> = [];
  let calls = 0;
  let disposals = 0;
  const spy = vi.spyOn(prototype, "waitForSelector");

  restores.push(() => spy.mockRestore());
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const restore of restores.reverse()) restore();
    }),
  );
  spy.mockImplementation(async function (this: Frame, selector, options) {
    const first = calls++ === 0;
    const result = native.call(this, selector, options);

    if (first) Deferred.doneUnsafe(entered, Effect.void);
    const node = await result;

    if (first) {
      if (node !== null) {
        const release = node.dispose.bind(node);
        const disposal = vi.spyOn(node, "dispose");

        restores.push(() => disposal.mockRestore());
        disposal.mockImplementation(async () => {
          disposals++;
          await release();
          Deferred.doneUnsafe(disposed, Effect.void);
        });
      }
      Deferred.doneUnsafe(returned, Effect.void);
      await afterFirstResult?.();
    }

    return node;
  });

  return { entered, returned, disposed, calls: () => calls, disposals: () => disposals };
});

const busy = { _tag: "Failure", failure: { reason: { _tag: "Busy" }, outcome: "undispatched" } };
const stale = { _tag: "Failure", failure: { reason: { _tag: "Stale" }, outcome: "undispatched" } };

it.live(
  "a pending selector wait permits host reads and other pages, while its page and observation stay protected",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { session, page, site } = yield* fixture();
        const stage = (yield* session.pages).find((candidate) => candidate.selected)!;
        const stageTarget = yield* session.pinPage(stage);
        const scout = yield* session.createPage;
        const scoutTarget = yield* session.pinPage(scout);

        yield* scoutTarget.navigate({ url: `${site.url}?scout` });
        const seen = yield* session.observe();
        const act = reference(seen, "Act");
        const watch = yield* watchSelectorWait(page);

        const pending = yield* forkWait(
          session.waitFor({ selector: "#arrived", state: "visible" }),
        );

        yield* Deferred.await(watch.entered).pipe(Effect.timeout("5 seconds"));
        // Round trip through the independent operator while the requested node still does not exist.
        expect(yield* Effect.promise(() => page.locator("#arrived").count())).toBe(0);
        expect(yield* Deferred.isDone(pending.done)).toBe(false);
        expect(
          (yield* session.checkpoint({ picture: true })).picture?.bytes.length,
        ).toBeGreaterThan(0);
        expect(yield* session.pages).toHaveLength(2);
        expect(yield* session.status).toMatchObject({
          phase: "open",
          busy: true,
          unresolvedDispatch: false,
        });

        expect(yield* Effect.result(session.clickElement(act))).toMatchObject(busy);
        expect(yield* Effect.result(stageTarget.navigate({ url: site.url }))).toMatchObject(busy);
        expect(yield* Effect.result(PageControl.suspend(session, stage))).toMatchObject(busy);
        expect(yield* Effect.result(session.observe())).toMatchObject(busy);
        expect(
          yield* Effect.result(session.waitFor({ selector: "#target", state: "attached" })),
        ).toMatchObject(busy);
        expect(yield* Effect.promise(() => page.locator("#count").textContent())).toBe("0");

        yield* scoutTarget.click({ selector: "#increment" });
        expect((yield* scoutTarget.readText({ selector: "#count" })).text).toBe("1");
        yield* session.selectPage(scout);
        expect((yield* session.checkpoint()).target.pageId).toBe(scout.pageId);
        expect(yield* Effect.result(stageTarget.click({ selector: "#act" }))).toMatchObject(busy);
        expect(yield* Effect.result(session.observe())).toMatchObject(busy);
        yield* session.selectPage(stage);
        yield* session.selectPage(scout);
        expect(yield* Deferred.isDone(pending.done)).toBe(false);
        yield* Effect.promise(() =>
          page.evaluate(() => {
            const node = document.createElement("div");

            node.id = "arrived";
            node.textContent = "Arrived on the original page";
            document.body.append(node);
          }),
        );
        yield* Fiber.join(pending.fiber);
        expect(pending.successes()).toBe(1);
        expect(watch.disposals()).toBe(1);
        expect((yield* session.target).pageId).toBe(scout.pageId);
        yield* session.selectPage(stage);
        expect((yield* session.controlFacts(act)).label).toBe("Act");
        yield* session.waitFor({ selector: "#arrived", state: "attached" });
        expect(watch.calls()).toBe(2);
        const held = yield* PageControl.suspend(session, stage);

        expect(
          yield* Effect.result(session.waitFor({ selector: "#arrived", state: "visible" })),
        ).toMatchObject(busy);
        expect(watch.calls()).toBe(2);
        yield* PageControl.resume(session, held);
        expect(yield* idle(session)).toMatchObject({ phase: "open", unresolvedDispatch: false });
      }),
    ).pipe(Effect.provide(layer)),
);

it.live.each(["enabled", "disabled", "visible", "hidden"] as const)(
  "an exact-node %s wait observes the original node changing state without input",
  (state) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { session, page } = yield* fixture();
        const scout = state === "enabled" ? yield* session.createPage : undefined;

        yield* Effect.promise(() =>
          page.locator("#target").evaluate((node, state) => {
            if (node instanceof HTMLButtonElement) {
              node.disabled = state === "enabled";
              node.hidden = state === "visible";
            }
          }, state),
        );
        const target = reference(yield* session.observe());
        const watch = yield* watchElementWait(page);

        const pending = yield* forkWait(
          session.waitForElement(
            WaitForElementRequest.make({ reference: target, state, timeoutMillis: 10000 }),
          ),
        );

        const native = yield* Deferred.await(watch.entered).pipe(Effect.timeout("5 seconds"));

        expect(native.signal).toBeDefined();
        yield* Effect.promise(() => page.evaluate(() => true));
        expect(yield* Deferred.isDone(pending.done)).toBe(false);
        expect((yield* session.checkpoint()).text).toContain("Wait fixture");
        expect(yield* Effect.result(session.observe())).toMatchObject(busy);
        if (scout !== undefined) yield* session.selectPage(scout);
        yield* Effect.promise(() =>
          page.locator("#target").evaluate((node, state) => {
            if (node instanceof HTMLButtonElement) {
              if (state === "hidden") node.remove();
              else if (state === "visible") node.hidden = false;
              else node.disabled = state === "disabled";
            }
          }, state),
        );
        yield* Fiber.join(pending.fiber);
        expect(pending.successes()).toBe(1);
        expect(watch.calls()).toBe(1);
        if (scout !== undefined) expect((yield* session.target).pageId).toBe(scout.pageId);
        expect(yield* Effect.promise(() => page.locator("#count").textContent())).toBe("0");
        expect(yield* idle(session)).toMatchObject({ phase: "open", unresolvedDispatch: false });
      }),
    ).pipe(Effect.provide(layer)),
);

it.live(
  "an exact native wait timeout sends no input and releases capacity for a satisfied condition",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { session, page } = yield* fixture();
        const target = reference(yield* session.observe());
        const watch = yield* watchElementWait(page);

        const pending = yield* forkWait(
          session.waitForElement({ reference: target, state: "hidden", timeoutMillis: 250 }),
        );

        const native = yield* Deferred.await(watch.entered).pipe(Effect.timeout("5 seconds"));

        expect(native.timeout).toBeGreaterThan(0);
        expect(native.timeout).toBeLessThanOrEqual(250);
        expect(yield* Effect.result(Fiber.join(pending.fiber))).toMatchObject({
          _tag: "Failure",
          failure: { operation: "wait", reason: { _tag: "Timeout" }, outcome: "undispatched" },
        });
        yield* Deferred.await(watch.settled).pipe(Effect.timeout("5 seconds"));
        expect(yield* idle(session)).toMatchObject({ phase: "open", unresolvedDispatch: false });
        yield* session.waitForElement({ reference: target, state: "visible" });
        expect(watch.calls()).toBe(2);
        expect(pending.successes()).toBe(0);
        expect(yield* Effect.promise(() => page.locator("#count").textContent())).toBe("0");
      }),
    ).pipe(Effect.provide(layer)),
);

it.live.each(["enabled", "visible"] as const)(
  "an exact %s wait never follows a replacement that already satisfies its condition",
  (state) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { session, page } = yield* fixture();

        yield* Effect.promise(() =>
          page.locator("#target").evaluate((node, state) => {
            if (node instanceof HTMLButtonElement) {
              node.disabled = state === "enabled";
              node.hidden = state === "visible";
            }
          }, state),
        );
        const target = reference(yield* session.observe());
        const watch = yield* watchElementWait(page);

        const pending = yield* forkWait(
          session.waitForElement({ reference: target, state, timeoutMillis: 10000 }),
        );

        yield* Deferred.await(watch.entered).pipe(Effect.timeout("5 seconds"));
        yield* Effect.promise(() =>
          page.locator("#target").evaluate((node) => {
            const replacement = document.createElement("button");

            replacement.id = "target";
            replacement.setAttribute("aria-label", "Target");
            replacement.textContent = "Target";
            node.replaceWith(replacement);
          }),
        );
        expect(yield* Effect.result(Fiber.join(pending.fiber))).toMatchObject(stale);
        expect(pending.successes()).toBe(0);
        expect(yield* idle(session)).toMatchObject({ phase: "open", unresolvedDispatch: false });
        yield* session.waitForElement({ reference: reference(yield* session.observe()), state });
        expect(watch.calls()).toBe(2);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live.each(["page-navigation", "frame-navigation", "frame-removal"] as const)(
  "%s makes a pending hidden wait stale, even after selection leaves its frame",
  (change) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { session, page, site } = yield* fixture();
        let frame = page.mainFrame();
        const stage = (yield* session.pages).find((candidate) => candidate.selected)!;

        if (change !== "page-navigation") {
          yield* Effect.promise(() =>
            page.setContent(
              `${content}<iframe name=wait-child src="${site.url}pinned-frame"></iframe>`,
            ),
          );
          const child = page.frame({ name: "wait-child" });

          assert.ok(child);
          frame = child;
          yield* Effect.promise(() => frame.setContent(content));
          const info = (yield* session.frames).find((candidate) => candidate.name === "wait-child");

          assert.ok(info);
          yield* session.selectFrame(info.frameId);
        }
        const target = reference(yield* session.observe());
        const watch = yield* watchElementWait(page);

        const pending = yield* forkWait(
          session.waitForElement({ reference: target, state: "hidden", timeoutMillis: 10000 }),
        );

        yield* Deferred.await(watch.entered).pipe(Effect.timeout("5 seconds"));
        // Native entry precedes return from the short owner guard. Prove that admission has
        // retired before changing selection or the waited document.
        yield* session.pages.pipe(
          Effect.retry({
            times: 100,
            schedule: Schedule.spaced("5 millis"),
            while: (error) => error.reason._tag === "Busy" && error.outcome === "undispatched",
          }),
          Effect.timeout("5 seconds"),
        );
        if (change !== "page-navigation") {
          yield* session.selectPage(stage);
        }
        yield* Effect.promise(() => page.evaluate(() => true));
        expect(yield* Deferred.isDone(pending.done)).toBe(false);
        if (change === "frame-removal")
          yield* Effect.promise(() => page.locator("iframe").evaluate((node) => node.remove()));
        else yield* Effect.promise(() => frame.goto(`${site.url}?replacement`));
        expect(yield* Effect.result(Fiber.join(pending.fiber))).toMatchObject(stale);
        expect(pending.successes()).toBe(0);
        expect(yield* idle(session)).toMatchObject({ phase: "open", unresolvedDispatch: false });
        expect(yield* session.pages).toHaveLength(1);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live(
  "cancelling an exact wait retains its leased node and capacity through native acknowledgement",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { session, page } = yield* fixture();

        yield* Effect.promise(() =>
          page.locator("#target").evaluate((node) => {
            if (node instanceof HTMLButtonElement) node.disabled = true;
          }),
        );
        const target = reference(yield* session.observe());
        let release: () => void = () => {};

        const acknowledgement = new Promise<void>((resolve) => {
          release = resolve;
        });

        yield* Effect.addFinalizer(() => Effect.sync(release));
        const watch = yield* watchElementWait(page, () => acknowledgement);

        const pending = yield* forkWait(
          session.waitForElement({ reference: target, state: "enabled", timeoutMillis: 10000 }),
        );

        const native = yield* Deferred.await(watch.entered).pipe(Effect.timeout("5 seconds"));
        const disposed = yield* Deferred.make<void>();
        const dispose = native.element.dispose.bind(native.element);
        const disposal = vi.spyOn(native.element, "dispose");
        let disposals = 0;

        yield* Effect.addFinalizer(() => Effect.sync(() => disposal.mockRestore()));
        disposal.mockImplementation(async () => {
          disposals++;
          await dispose();
          Deferred.doneUnsafe(disposed, Effect.void);
        });
        yield* Fiber.interrupt(pending.fiber);
        const exit = yield* Fiber.await(pending.fiber);

        assert.ok(Exit.isFailure(exit));
        expect(Cause.hasInterrupts(exit.cause)).toBe(true);
        expect(native.signal?.aborted).toBe(true);
        yield* Deferred.await(watch.settled).pipe(Effect.timeout("5 seconds"));
        expect((yield* session.checkpoint()).text).toContain("Wait fixture");
        const fresh = yield* session.observe();
        const freshAct = reference(fresh, "Act");

        expect(disposals).toBe(0);
        for (let i = 0; i < 2; i++)
          expect(
            yield* Effect.result(
              session.waitForElement({ reference: reference(fresh), state: "disabled" }),
            ),
          ).toMatchObject(busy);
        expect(watch.calls()).toBe(1);
        expect(yield* session.status).toMatchObject({
          phase: "open",
          busy: true,
          unresolvedDispatch: false,
        });
        expect((yield* session.controlFacts(freshAct)).label).toBe("Act");
        release();
        yield* Deferred.await(disposed).pipe(Effect.timeout("5 seconds"));
        expect(yield* idle(session)).toMatchObject({ phase: "open", unresolvedDispatch: false });
        expect(disposals).toBe(1);
        expect((yield* session.controlFacts(freshAct)).label).toBe("Act");
        yield* session.waitForElement({ reference: reference(fresh), state: "disabled" });
        yield* session.clickElement(freshAct);
        expect(yield* Effect.promise(() => page.locator("#count").textContent())).toBe("1");
        expect(pending.successes()).toBe(0);
        expect(disposals).toBe(1);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live(
  "a selector handle returned after caller cancellation is disposed before another wait is admitted",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { session, page } = yield* fixture();
        let release: () => void = () => {};

        const acknowledgement = new Promise<void>((resolve) => {
          release = resolve;
        });

        yield* Effect.addFinalizer(() => Effect.sync(release));
        const watch = yield* watchSelectorWait(page, () => acknowledgement);

        const pending = yield* forkWait(
          session.waitFor({ selector: "#arrived", state: "visible" }),
        );

        yield* Deferred.await(watch.entered).pipe(Effect.timeout("5 seconds"));
        yield* Effect.promise(() =>
          page.evaluate(() => {
            const node = document.createElement("div");

            node.id = "arrived";
            node.textContent = "Arrived";
            document.body.append(node);
          }),
        );
        yield* Deferred.await(watch.returned).pipe(Effect.timeout("5 seconds"));
        yield* Fiber.interrupt(pending.fiber);
        expect(watch.disposals()).toBe(0);
        expect(
          yield* Effect.result(session.waitFor({ selector: "#arrived", state: "visible" })),
        ).toMatchObject(busy);
        expect(watch.calls()).toBe(1);
        expect((yield* session.checkpoint()).text).toContain("Arrived");
        release();
        yield* Deferred.await(watch.disposed).pipe(Effect.timeout("5 seconds"));
        expect(yield* idle(session)).toMatchObject({ phase: "open", unresolvedDispatch: false });
        expect(watch.disposals()).toBe(1);
        yield* session.waitFor({ selector: "#arrived", state: "visible" });
        expect(watch.calls()).toBe(2);
        expect(pending.successes()).toBe(0);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live.each(["page", "session"] as const)(
  "closing the %s cancels its pending wait without late success or mutation uncertainty",
  (closing) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { session, page, site, host } = yield* fixture();
        const original = (yield* session.pages).find((candidate) => candidate.selected)!;
        const survivor = closing === "page" ? yield* session.createPage : undefined;

        if (survivor !== undefined) {
          const pinned = yield* session.pinPage(survivor);

          yield* pinned.navigate({ url: `${site.url}?survivor` });
        }
        const target = reference(yield* session.observe());
        const watch = yield* watchElementWait(page);

        const pending = yield* forkWait(
          session.waitForElement({ reference: target, state: "hidden", timeoutMillis: 10000 }),
        );

        yield* Deferred.await(watch.entered).pipe(Effect.timeout("5 seconds"));
        yield* Effect.promise(() => page.evaluate(() => true));
        expect(yield* Deferred.isDone(pending.done)).toBe(false);
        if (survivor !== undefined) {
          yield* session.selectPage(survivor);
          yield* session.closePage(original);
          expect(yield* Effect.result(Fiber.join(pending.fiber))).toMatchObject(stale);
          expect(yield* idle(session)).toMatchObject({ phase: "open", unresolvedDispatch: false });
          yield* session.click({ selector: "#increment" });
          expect((yield* session.readText({ selector: "#count" })).text).toBe("1");
        } else {
          const receipt = yield* session.closeChecked;

          expect(receipt).toMatchObject({ connection: "closed", process: "not-owned", issues: [] });
          expect(yield* Effect.result(Fiber.join(pending.fiber))).toMatchObject({
            _tag: "Failure",
            failure: { outcome: "undispatched" },
          });
          yield* Effect.promise(() => page.locator("#target").evaluate((node) => node.remove()));
          expect(yield* session.status).toMatchObject({
            phase: "closed",
            unresolvedDispatch: false,
          });
          expect(
            yield* Effect.result(session.waitFor({ selector: "#act", state: "visible" })),
          ).toMatchObject({
            _tag: "Failure",
            failure: { reason: { _tag: "Closed" }, outcome: "undispatched" },
          });
        }
        yield* Deferred.await(watch.settled).pipe(Effect.timeout("5 seconds"));
        expect(pending.successes()).toBe(0);
        expect(host.running()).toBe(true);
      }),
    ).pipe(Effect.provide(layer)),
);
