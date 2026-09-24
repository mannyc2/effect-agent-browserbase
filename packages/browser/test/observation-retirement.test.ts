import { expect, it } from "@effect/vitest";
import { ControlFacts } from "effect-browser/browser-data";
import { Reasons } from "effect-browser/errors";
import type { BrowserContext, ElementHandle, Frame, JSHandle } from "playwright-core";

import { makeActions } from "../src/internal/browser/Actions.ts";
import { failure } from "../src/internal/browser/NativeCalls.ts";
import { makeObservation } from "../src/internal/browser/Observation.ts";
import type { Ticket } from "../src/internal/browser/Owner.ts";
import type { Targets } from "../src/internal/browser/Targets.ts";

const gate = () => {
  let release: () => void = () => {};

  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });

  return { promise, release: () => release() };
};

const ticket = (generation = 1) => {
  const controller = new AbortController();

  const admission: Ticket = {
    signal: controller.signal,
    deadline: 10000,
    generation,
    dispatched: false,
    remainingMillis: () => 1000,
    check: () => {
      if (controller.signal.aborted) throw failure(Reasons.Stale.make({}), "undispatched");
    },
    dispatch: () => {
      throw new Error("Observation tests must not dispatch input");
    },
  };

  return { admission, abort: () => controller.abort() };
};

/** Only the native handle boundary is scripted; snapshot publication, retirement and facts are real. */
const fixture = (
  finishFirstRead: () => Promise<void> = async () => {},
  hooks: {
    readonly extractFirstNode?: () => Promise<void>;
    readonly readFacts?: () => Promise<void>;
  } = {},
) => {
  const records: Array<{ disposed: number }> = [];
  const target = { pageId: "stage", frameId: "main" };
  const calls = { facts: 0, factsProperties: 0 };
  let documentEpoch = 0;

  const facts = ControlFacts.make({
    kind: "button",
    label: "Action",
    disabled: false,
    editable: false,
    box: { x: 0, y: 0, width: 10, height: 10 },
    placement: "inside",
    hitTest: "self",
    mainFrame: true,
  });

  const frame = {
    evaluateHandle: async (_run: unknown, request: { readonly only?: unknown }) => {
      if (request.only !== undefined) {
        calls.facts++;
        await hooks.readFacts?.();

        return {
          evaluate: async () => {
            calls.factsProperties++;

            return { facts };
          },
          dispose: async () => {},
        };
      }

      const record = { disposed: 0 };

      records.push(record);
      const first = records.length === 1;

      const handle = {
        asElement: (): ElementHandle<Element> => handle as unknown as ElementHandle<Element>,
        evaluate: async () => true,
        dispose: async () => {
          record.disposed++;
        },
      };

      return {
        evaluateHandle: async () => ({
          getProperties: async () => {
            if (first) await hooks.extractFirstNode?.();

            return new Map([["0", handle]]);
          },
          dispose: async () => {},
        }),
        evaluate: async () => ({
          text: "Action",
          textTruncated: false,
          controlsTruncated: false,
          controls: [facts],
          viewport: {
            width: 640,
            height: 480,
            clippedText: 0,
            coveredText: 0,
            uncertainText: 0,
            unreachableControls: 0,
            exhausted: false,
          },
        }),
        // The read checked its ticket before releasing this native holder. Cancellation and
        // replacement can happen while that release is still pending.
        dispose: async () => {
          if (first) await finishFirstRead();
        },
      } as unknown as JSHandle;
    },
  } as unknown as Frame;

  const targets = {
    selected: () => ({ ...target }),
    current: (requested = target) => ({ entry: { id: requested.pageId }, frame }),
    epochOf: () => documentEpoch,
    url: () => "https://example.test/stage",
    navigating: { has: () => false },
  } as unknown as Targets;

  const observation = makeObservation(targets, "connection", {
    invalidate: () => {},
    pause: () => {},
    fault: () => {},
    disconnected: () => {},
  });

  return {
    observation,
    records,
    calls,
    targets,
    target,
    replaceDocument: () => {
      documentEpoch++;
    },
  };
};

it.each(["mutation", "hold"] as const)(
  "an own-page %s during native holder release retires the pending observation and releases its nodes",
  async (event) => {
    const entered = gate();
    const finish = gate();

    const f = fixture(async () => {
      entered.release();
      await finish.promise;
    });

    const reading = f.observation.observe("document", 1024, 1, ticket().admission);

    await entered.promise;
    if (event === "mutation") f.observation.invalidate({ pageId: "stage" });
    else f.observation.held("stage");
    finish.release();
    await expect(reading).rejects.toMatchObject({
      reason: { _tag: "Stale" },
      outcome: "undispatched",
    });
    expect(f.records).toEqual([{ disposed: 1 }]);
    await observeFresh(f);
    await f.observation.dispose();
    expect(f.records).toEqual([{ disposed: 1 }, { disposed: 1 }]);
  },
);

const observeFresh = async (f: ReturnType<typeof fixture>) => {
  const fresh = await f.observation.observe("document", 1024, 1, ticket().admission);
  const reference = { observationId: fresh.observationId, elementId: fresh.controls[0]!.elementId };

  expect((await f.observation.controlFacts(reference, ticket().admission)).label).toBe("Action");

  return fresh;
};

it("an unrelated page event leaves a pending observation usable", async () => {
  const entered = gate();
  const finish = gate();

  const f = fixture(async () => {
    entered.release();
    await finish.promise;
  });

  const reading = f.observation.observe("document", 1024, 1, ticket().admission);

  await entered.promise;
  f.observation.invalidate({ pageId: "scout" });
  finish.release();
  const result = await reading;

  expect(
    (
      await f.observation.controlFacts(
        {
          observationId: result.observationId,
          elementId: result.controls[0]!.elementId,
        },
        ticket().admission,
      )
    ).label,
  ).toBe("Action");
  expect(f.records).toEqual([{ disposed: 0 }]);
  await f.observation.dispose();
  expect(f.records).toEqual([{ disposed: 1 }]);
});

it.each(["node extraction", "holder release"])(
  "a read cancelled during %s cannot replace its successor or release its nodes",
  async (stage) => {
    const entered = gate();
    const finish = gate();

    const pause = async () => {
      entered.release();
      await finish.promise;
    };

    const f =
      stage === "holder release" ? fixture(pause) : fixture(undefined, { extractFirstNode: pause });

    const oldTicket = ticket();
    const reading = f.observation.observe("document", 1024, 1, oldTicket.admission);

    await entered.promise;
    oldTicket.abort();
    const fresh = await observeFresh(f);

    finish.release();
    await expect(reading).rejects.toMatchObject({
      reason: { _tag: "Stale" },
      outcome: "undispatched",
    });
    expect(f.records).toEqual([{ disposed: 1 }, { disposed: 0 }]);
    expect(
      (
        await f.observation.controlFacts(
          {
            observationId: fresh.observationId,
            elementId: fresh.controls[0]!.elementId,
          },
          ticket().admission,
        )
      ).label,
    ).toBe("Action");
    await f.observation.dispose();
    expect(f.records).toEqual([{ disposed: 1 }, { disposed: 1 }]);
  },
);

it("a failed native holder release still disposes extracted nodes and does not publish a snapshot", async () => {
  const f = fixture(async () => {
    throw new Error("PRIVATE-RELEASE-FAILURE");
  });

  await expect(
    f.observation.observe("document", 1024, 1, ticket().admission),
  ).rejects.toMatchObject({
    reason: { _tag: "Provider" },
  });
  expect(f.records).toEqual([{ disposed: 1 }]);
  await observeFresh(f);
  await f.observation.dispose();
  expect(f.records).toEqual([{ disposed: 1 }, { disposed: 1 }]);
});

const changeSnapshot: ReadonlyArray<readonly [string, (f: ReturnType<typeof fixture>) => void]> = [
  [
    "selected page",
    (f) => {
      f.target.pageId = "scout";
    },
  ],
  [
    "selected frame",
    (f) => {
      f.target.frameId = "child";
    },
  ],
  [
    "document epoch",
    (f) => {
      f.replaceDocument();
    },
  ],
  [
    "observation retirement",
    (f) => {
      f.observation.invalidate({ pageId: "stage" });
    },
  ],
];

it.each(changeSnapshot)(
  "a changed %s during native facts acquisition refuses further reads",
  async (_name, change) => {
    const entered = gate();
    const finish = gate();

    const f = fixture(undefined, {
      readFacts: async () => {
        entered.release();
        await finish.promise;
      },
    });

    const observed = await f.observation.observe("document", 1024, 1, ticket().admission);

    const reference = {
      observationId: observed.observationId,
      elementId: observed.controls[0]!.elementId,
    };

    const reading = f.observation.controlFacts(reference, ticket().admission);

    await entered.promise;
    change(f);
    finish.release();
    await expect(reading).rejects.toMatchObject({
      reason: { _tag: "Stale" },
      outcome: "undispatched",
    });
    expect(f.calls).toEqual({ facts: 1, factsProperties: 0 });
    await f.observation.dispose();
    expect(f.records).toEqual([{ disposed: 1 }]);
  },
);

it("an observation from a different connection generation refuses before reading native facts", async () => {
  const f = fixture();
  const observed = await f.observation.observe("document", 1024, 1, ticket().admission);

  const reference = {
    observationId: observed.observationId,
    elementId: observed.controls[0]!.elementId,
  };

  await expect(f.observation.controlFacts(reference, ticket(2).admission)).rejects.toMatchObject({
    reason: { _tag: "Stale" },
    outcome: "undispatched",
  });
  expect(f.calls).toEqual({ facts: 0, factsProperties: 0 });
  await f.observation.dispose();
});

it("an action rechecks the resolved snapshot after asynchronous admission and sends no input to a changed target", async () => {
  const f = fixture();
  const observed = await f.observation.observe("document", 1024, 1, ticket().admission);

  const reference = {
    observationId: observed.observationId,
    elementId: observed.controls[0]!.elementId,
  };

  const actions = makeActions({} as BrowserContext, f.targets, f.observation, () => false);
  const entered = gate();
  const finish = gate();
  let dispatches = 0;
  let inputs = 0;

  const acting = actions.withAdmittedElement(
    reference,
    {
      ...ticket().admission,
      dispatch: () => {
        dispatches++;
      },
    },
    async () => {
      entered.release();
      await finish.promise;
    },
    async () => {
      inputs++;
    },
  );

  await entered.promise;
  f.target.frameId = "child";
  finish.release();
  await expect(acting).rejects.toMatchObject({
    reason: { _tag: "Stale" },
    outcome: "undispatched",
  });
  expect(dispatches).toBe(0);
  expect(inputs).toBe(0);
  f.target.frameId = "main";
  expect((await f.observation.controlFacts(reference, ticket().admission)).label).toBe("Action");
  await f.observation.dispose();
});
