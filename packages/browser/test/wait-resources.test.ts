import { expect, it } from "@effect/vitest";
import { Effect, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";
import type { BrowserContext, ElementHandle, Frame } from "playwright-core";

import { ControlFacts, WaitForElementRequest } from "../src/BrowserData.ts";
import { makeActions } from "../src/internal/browser/Actions.ts";
import { makeObservation } from "../src/internal/browser/Observation.ts";
import { makeOwner, native, type OwnedWait } from "../src/internal/browser/Owner.ts";
import type { Entry, Targets } from "../src/internal/browser/Targets.ts";

const gate = <A>() => {
  let resolve: (value: A) => void = () => {};
  let reject: (error: Error) => void = () => {};

  const promise = new Promise<A>((yes, no) => {
    resolve = yes;
    reject = no;
  });

  return { promise, resolve, reject };
};

/** Only native page/handle work is scripted. The owner, wait bridge and observation leases are real. */
const fixture = Effect.fnUntraced(function* () {
  const owner = yield* makeOwner({
    maxActions: 20,
    maxHostReads: 20,
    actionTimeoutMillis: 1000,
    maxElapsedMillis: 5000,
  });

  owner.transition("open");
  const connection = {};
  const target = { pageId: "stage", frameId: "main" };
  let epoch = 0;
  let selected = { ...target };
  const records: Array<ReturnType<typeof node>> = [];

  const viewport = {
    width: 640,
    height: 480,
    clippedText: 0,
    coveredText: 0,
    uncertainText: 0,
    unreachableControls: 0,
    exhausted: false,
  };

  const node = () => {
    const entered = gate<void>();
    const finish = gate<void>();
    const disposalEntered = gate<void>();

    const record = {
      entered,
      finish,
      disposalEntered,
      connected: true,
      documentGone: false,
      disabled: true,
      disposals: 0,
      waits: 0,
      dispose: async () => {},
      signal: undefined as AbortSignal | undefined,
    };

    const handle = {
      evaluate: async () => {
        if (record.documentGone) throw new Error("PRIVATE-CONTEXT-DESTROYED");

        return record.connected;
      },
      waitForElementState: async (_state: string, options: { signal?: AbortSignal }) => {
        record.waits++;
        record.signal = options.signal;
        entered.resolve();
        await finish.promise;
      },
      dispose: async () => {
        record.disposals++;
        disposalEntered.resolve();
        await record.dispose();
      },
      asElement: (): ElementHandle<Element> => handle as unknown as ElementHandle<Element>,
    };

    return { ...record, native: record, handle: handle as unknown as ElementHandle<Element> };
  };

  const facts = (record: ReturnType<typeof node>) =>
    ControlFacts.make({
      kind: "button",
      label: "Ready",
      disabled: record.native.disabled,
      editable: false,
      box: { x: 0, y: 0, width: 20, height: 20 },
      placement: "inside",
      hitTest: "self",
      mainFrame: true,
    });

  const selectorEntered = gate<void>();
  const selectorResult = gate<ElementHandle<Element> | null>();

  const frame = {
    isDetached: () => false,
    waitForSelector: async () => {
      selectorEntered.resolve();

      return selectorResult.promise;
    },
    evaluateHandle: async (_run: unknown, request: { only?: ElementHandle<Element> }) => {
      if (request.only !== undefined) {
        const record = records.find((record) => record.handle === request.only);

        if (record === undefined) throw new Error("Unknown native node");

        return {
          evaluate: async () => ({ facts: facts(record) }),
          dispose: async () => {},
        };
      }
      const sampled = [node(), node()];

      records.push(...sampled);

      return {
        evaluateHandle: async () => ({
          getProperties: async () =>
            new Map(sampled.map((record, i) => [String(i), record.handle] as const)),
          dispose: async () => {},
        }),
        evaluate: async () => ({
          text: "Ready",
          controls: sampled.map(facts),
          textTruncated: false,
          controlsTruncated: false,
          viewport,
        }),
        dispose: async () => {},
      };
    },
  } as unknown as Frame;

  const entry = { id: "stage", page: { mainFrame: () => frame } } as unknown as Entry;

  const targets = {
    selected: () => ({ ...selected }),
    current: () => ({ entry, frame }),
    epochOf: () => epoch,
    url: () => "https://example.test/",
    navigating: { has: () => false },
  } as unknown as Targets;

  const observation = makeObservation(targets, "connection", {
    invalidate: owner.invalidate,
    disconnected: () => {},
    pause: () => {},
    fault: () => {},
  });

  const actions = makeActions({} as BrowserContext, targets, observation, () => false);

  const observe = owner.guard("observe", (ticket) =>
    native("observe", ticket, () => observation.observe("document", 1024, 2, ticket)),
  );

  const begin = (run: (wait: OwnedWait) => Promise<void>, connectionId = connection) =>
    owner.guard("wait", (ticket) =>
      Effect.sync(() => {
        const wait = owner.beginWait(ticket, target, connectionId);

        wait.start(() => run(wait));

        return wait;
      }),
    );

  return {
    owner,
    connection,
    target,
    entry,
    frame,
    actions,
    observation,
    records,
    node,
    selectorEntered,
    selectorResult,
    observe,
    begin,
    selectElsewhere: () => {
      selected = { pageId: "scout", frameId: "scout-main" };
    },
    selectOriginal: () => {
      selected = { ...target };
    },
    replaceDocument: () => {
      epoch++;
      actions.waitChanged(entry, frame);
    },
  };
});

it.effect(
  "an exact wait tolerates changed state and selection without authorizing stale input",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const seen = yield* f.observe;

      const reference = {
        observationId: seen.observationId,
        elementId: seen.controls[0]!.elementId,
      };

      const original = f.records[0]!;

      const wait = yield* f.begin((wait) =>
        f.actions.waitForElement(reference, "enabled", wait.ticket, f.target),
      );

      yield* Effect.promise(() => original.entered.promise);
      expect(wait.ticket.signal.aborted).toBe(false);
      original.native.disabled = false;
      f.selectElsewhere();
      original.finish.resolve();
      yield* wait.completed;
      expect(original.native.waits).toBe(1);
      expect(original.native.disposals).toBe(0);
      f.selectOriginal();
      expect(
        yield* f.owner
          .guard("control-facts", (ticket) =>
            native("control-facts", ticket, () => f.observation.controlFacts(reference, ticket)),
          )
          .pipe(Effect.result),
      ).toMatchObject({
        _tag: "Failure",
        failure: { reason: { _tag: "Stale" }, outcome: "undispatched" },
      });
      expect(yield* f.owner.status).toMatchObject({
        phase: "open",
        busy: false,
        unresolvedDispatch: false,
      });
      yield* Effect.promise(() => f.observation.dispose());
      expect(f.records.map((record) => record.native.disposals)).toEqual([1, 1]);
    }),
);

it.effect(
  "a canceled exact wait keeps its old node alive while a successor observation is issued",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const seen = yield* f.observe;

      const reference = {
        observationId: seen.observationId,
        elementId: seen.controls[0]!.elementId,
      };

      const original = f.records[0]!;
      const disposal = gate<void>();

      original.native.dispose = () => disposal.promise;

      const wait = yield* f.begin((wait) =>
        f.actions.waitForElement(reference, "hidden", wait.ticket, f.target),
      );

      yield* Effect.promise(() => original.entered.promise);
      wait.cancel();
      expect((yield* Effect.result(wait.completed))._tag).toBe("Failure");
      const successor = yield* f.observe;

      expect(successor.observationId).not.toBe(seen.observationId);
      expect(f.records.map((record) => record.native.disposals)).toEqual([0, 1, 0, 0]);
      original.finish.resolve();
      yield* Effect.promise(() => original.disposalEntered.promise);
      expect(f.owner.waitAvailable()).toBe(false);
      expect(f.owner.waitPending()).toBe(false);
      disposal.resolve();
      yield* Effect.promise(() => disposal.promise);
      yield* Effect.yieldNow;
      expect(f.owner.waitAvailable()).toBe(true);

      const current = {
        observationId: successor.observationId,
        elementId: successor.controls[0]!.elementId,
      };

      yield* f.owner.guard("control-facts", (ticket) =>
        native("control-facts", ticket, () => f.observation.controlFacts(current, ticket)),
      );
      yield* Effect.promise(() => f.observation.dispose());
      expect(f.records.map((record) => record.native.disposals)).toEqual([1, 1, 1, 1]);
    }),
);

it.effect(
  "late selector handles are disposed once and a rejected disposal keeps wait capacity",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const returned = f.node();
      const disposal = gate<void>();

      returned.native.dispose = () => disposal.promise;

      const wait = yield* f.begin((wait) =>
        f.actions.waitFor("#ready", "visible", wait.ticket, f.target),
      );

      yield* Effect.promise(() => f.selectorEntered.promise);
      const outcome = yield* Effect.forkChild(wait.completed.pipe(Effect.result));

      yield* TestClock.adjust(1000);
      expect(yield* Fiber.join(outcome)).toMatchObject({
        _tag: "Failure",
        failure: { reason: { _tag: "Timeout" }, outcome: "undispatched" },
      });
      f.selectorResult.resolve(returned.handle);
      yield* Effect.promise(() => returned.disposalEntered.promise);
      expect(f.owner.waitAvailable()).toBe(false);
      disposal.reject(new Error("PRIVATE-DISPOSAL"));
      yield* Effect.yieldNow;
      expect(f.owner.waitAvailable()).toBe(false);
      expect(returned.native.disposals).toBe(1);
      expect(yield* f.owner.status).toMatchObject({ phase: "open", unresolvedDispatch: false });
      f.owner.retireWait({});
      expect(f.owner.waitAvailable()).toBe(false);
      f.owner.retireWait(f.connection);
      expect(f.owner.waitAvailable()).toBe(true);
    }),
);

it.effect("a retired connection and a late predecessor cannot release a successor's capacity", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const oldRaw = gate<void>();
    const currentRaw = gate<void>();

    const old = yield* f.begin(async (wait) => {
      await oldRaw.promise;
      wait.ticket.retire();
    });

    f.owner.fence("detached", "disconnected", "detached");
    expect(f.owner.waitAvailable()).toBe(false);
    f.owner.retireWait(f.connection);
    f.owner.transition("open");

    const current = yield* f.begin(async (wait) => {
      await currentRaw.promise;
      wait.ticket.retire();
    }, {});

    oldRaw.resolve();
    yield* Effect.yieldNow;
    f.owner.retireWait(f.connection);
    expect(f.owner.waitAvailable()).toBe(false);
    expect(current.ticket.signal.aborted).toBe(false);
    expect((yield* Effect.result(old.completed))._tag).toBe("Failure");
    currentRaw.resolve();
    yield* current.completed;
    expect(f.owner.waitAvailable()).toBe(true);
  }),
);

it.effect(
  "document replacement invalidates hidden waits even when the native result arrives later",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const seen = yield* f.observe;
      const original = f.records[0]!;

      const wait = yield* f.begin((wait) =>
        f.actions.waitForElement(
          { observationId: seen.observationId, elementId: seen.controls[0]!.elementId },
          "hidden",
          wait.ticket,
          f.target,
        ),
      );

      yield* Effect.promise(() => original.entered.promise);
      f.replaceDocument();
      expect(yield* Effect.result(wait.completed)).toMatchObject({
        _tag: "Failure",
        failure: { reason: { _tag: "Stale" }, outcome: "undispatched" },
      });
      expect(original.native.signal?.aborted).toBe(true);
      original.finish.resolve();
      yield* Effect.yieldNow;
      yield* Effect.promise(() => f.observation.dispose());
      expect(f.records.map((record) => record.native.disposals)).toEqual([1, 1]);
    }),
);

it.effect(
  "document replacement makes a hidden wait stale even when the native failure arrives first",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const seen = yield* f.observe;
      const original = f.records[0]!;

      const wait = yield* f.begin((wait) =>
        f.actions.waitForElement(
          { observationId: seen.observationId, elementId: seen.controls[0]!.elementId },
          "hidden",
          wait.ticket,
          f.target,
        ),
      );

      yield* Effect.promise(() => original.entered.promise);
      // Playwright fails the wait for a node whose document went away, then reports the navigation.
      original.native.documentGone = true;
      original.finish.reject(new Error("PRIVATE-ELEMENT-NOT-ATTACHED"));
      expect(yield* Effect.result(wait.completed)).toMatchObject({
        _tag: "Failure",
        failure: { reason: { _tag: "Stale" }, outcome: "undispatched" },
      });
      f.replaceDocument();
      yield* Effect.promise(() => f.observation.dispose());
      expect(f.records.map((record) => record.native.disposals)).toEqual([1, 1]);
    }),
);

it.effect("a native wait failure in a live document keeps its own classification", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const seen = yield* f.observe;
    const original = f.records[0]!;

    const wait = yield* f.begin((wait) =>
      f.actions.waitForElement(
        { observationId: seen.observationId, elementId: seen.controls[0]!.elementId },
        "hidden",
        wait.ticket,
        f.target,
      ),
    );

    yield* Effect.promise(() => original.entered.promise);
    original.finish.reject(new Error("PRIVATE-NATIVE-FAILURE"));
    expect(yield* Effect.result(wait.completed)).toMatchObject({
      _tag: "Failure",
      failure: { reason: { _tag: "Provider" }, outcome: "undispatched" },
    });
    yield* Effect.promise(() => f.observation.dispose());
    expect(f.records.map((record) => record.native.disposals)).toEqual([1, 1]);
  }),
);

it.effect("remaining lifetime expires a pure wait without inventing unresolved input", () =>
  Effect.gen(function* () {
    const f = yield* fixture();

    yield* TestClock.adjust(4800);
    const finish = gate<void>();

    const wait = yield* f.begin(async (wait) => {
      await finish.promise;
      wait.ticket.retire();
    });

    expect(wait.ticket.remainingMillis()).toBe(200);
    const waiting = yield* Effect.forkChild(wait.completed.pipe(Effect.result));

    yield* TestClock.adjust(200);
    expect(yield* Fiber.join(waiting)).toMatchObject({
      _tag: "Failure",
      failure: { reason: { _tag: "Expired" }, outcome: "undispatched" },
    });
    expect(yield* f.owner.status).toMatchObject({
      phase: "faulted",
      reason: "expired",
      unresolvedDispatch: false,
    });
    finish.resolve();
    yield* Effect.yieldNow;
    expect(f.owner.waitAvailable()).toBe(true);
  }),
);

it("exact wait requests admit only bounded states and issued-reference shapes", () => {
  const decode = Schema.decodeUnknownSync(WaitForElementRequest, { onExcessProperty: "error" });
  const reference = { observationId: "original", elementId: "control" };

  for (const state of ["visible", "hidden", "enabled", "disabled"])
    expect(decode({ reference, state, timeoutMillis: 60000 }).state).toBe(state);
  for (const extra of [
    { timeoutMillis: 0 },
    { timeoutMillis: 60001 },
    { timeoutMillis: 1.5 },
    { timeoutMillis: null },
    { selector: "#replacement" },
    { expression: "true" },
    { state: "stable" },
  ])
    expect(() => decode({ reference, state: "visible", ...extra })).toThrow(Error);
});
