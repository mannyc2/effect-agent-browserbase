import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Stream } from "effect";
import * as BrowserTools from "effect-agent-browser/tools";
import { RunToolScheduling } from "effect-agent/run-options";
import { ActionResult } from "effect-browser/browser-data";
import { TestClock } from "effect/testing";
import { Toolkit } from "effect/unstable/ai";

import { scriptedSession } from "./fixtures/ScriptedSession.ts";

const url = "https://example.test/";

/** The scheduling an Agent run inside this context would use. */
const scheduling = Effect.service(RunToolScheduling);

it.effect("every option is checked once, when the host or a handler Layer is built", () =>
  Effect.gen(function* () {
    const browser = scriptedSession();

    for (const [path, options] of [
      ["maxTextBytes", { maxTextBytes: 0 }],
      ["maxTextBytes", { maxTextBytes: 131073 }],
      ["maxControls", { maxControls: 65 }],
      ["observationScope", { observationScope: "page" }],
      ["resultMaxBytes", { resultMaxBytes: 1024 }],
      ["continuationBytes", { maxTextBytes: 16384, continuationBytes: 8192 }],
      ["form", { form: { settleMillis: 5001 } }],
      ["form", { form: { verify: true, retries: 2 } }],
      ["admission", { admission: { admit: true } }],
      ["observe", { observe: "document" }],
      ["lane.maxOutstanding", { lane: { maxOutstanding: 0 } }],
      ["lane.maxQueueMillis", { lane: { maxQueueMillis: 600001 } }],
      ["scheduling", { scheduling: "parallel" }],
    ] as const)
      expect(
        // @ts-expect-error Each case is an invalid, untyped host input.
        yield* Effect.scoped(BrowserTools.makeHost(browser, options)).pipe(Effect.flip),
      ).toMatchObject({
        operation: "configure",
        reason: { _tag: "Configuration", path },
        outcome: "undispatched",
      });

    expect(
      yield* BrowserTools.toolkit.pipe(
        Effect.provide(BrowserTools.handlers(browser, { maxControls: 65 })),
        Effect.flip,
      ),
    ).toMatchObject({ reason: { _tag: "Configuration", path: "maxControls" } });
  }),
);

it.effect("the host's lane bounds how many calls wait and for how long", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();

      const browser = scriptedSession({
        scroll: () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(ActionResult.make({ url })),
          ),
      });

      const single = yield* BrowserTools.makeHost(browser, { lane: { maxOutstanding: 1 } });
      const tools = yield* BrowserTools.toolkit.pipe(Effect.provide(single.handlers));

      const scroll = () =>
        tools
          .handle("browser_scroll", { deltaX: 0, deltaY: 1 })
          .pipe(Effect.flatMap(Stream.runCollect));

      const first = yield* Effect.forkChild(scroll());

      yield* Deferred.await(entered);
      expect(yield* scroll()).toMatchObject([
        { isFailure: true, encodedResult: { reason: "busy", outcome: "undispatched" } },
      ]);
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(first)).toMatchObject([{ isFailure: false }]);

      const blocked = yield* Deferred.make<void>();
      const waiting = yield* Deferred.make<void>();

      const slow = yield* BrowserTools.makeHost(
        scriptedSession({
          scroll: () =>
            Deferred.succeed(waiting, undefined).pipe(
              Effect.andThen(Deferred.await(blocked)),
              Effect.as(ActionResult.make({ url })),
            ),
        }),
        { lane: { maxQueueMillis: 50 } },
      );

      const queued = yield* BrowserTools.toolkit.pipe(Effect.provide(slow.handlers));

      const call = () =>
        queued
          .handle("browser_scroll", { deltaX: 0, deltaY: 1 })
          .pipe(Effect.flatMap(Stream.runCollect));

      const holder = yield* Effect.forkChild(call());

      yield* Deferred.await(waiting);
      const late = yield* Effect.forkChild(call());

      yield* TestClock.adjust(51);
      expect(yield* Fiber.join(late)).toMatchObject([
        { isFailure: true, encodedResult: { reason: "timeout", outcome: "undispatched" } },
      ]);
      yield* Deferred.succeed(blocked, undefined);
      expect(yield* Fiber.join(holder)).toMatchObject([{ isFailure: false }]);
    }),
  ),
);

it.effect("host.run makes browser Tools sequential and keeps the caller's own scheduling", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = scriptedSession();
      const sequential = yield* BrowserTools.makeHost(browser);
      const inside = yield* sequential.run(scheduling);

      expect(inside.toolRequiresSequential?.("browser_click")).toBe(true);
      expect(inside.toolRequiresSequential?.("browser_fill_form_and_inspect")).toBe(true);
      expect(inside.toolRequiresSequential?.("search")).toBe(false);

      const caller = {
        runOverride: { mode: "bounded" as const, concurrency: 2 },
        toolRequiresSequential: (name: string) => name === "search",
      };

      const merged = yield* sequential
        .run(scheduling)
        .pipe(Effect.provideService(RunToolScheduling, caller));

      expect(merged.runOverride).toEqual(caller.runOverride);
      expect(merged.toolRequiresSequential?.("search")).toBe(true);
      expect(merged.toolRequiresSequential?.("browser_scroll")).toBe(true);
      expect(merged.toolRequiresSequential?.("other")).toBe(false);

      const lane = yield* BrowserTools.makeHost(browser, { scheduling: "lane" });

      expect(
        yield* lane.run(scheduling).pipe(Effect.provideService(RunToolScheduling, caller)),
      ).toBe(caller);
      expect(BrowserTools.sequentialScheduling().toolRequiresSequential?.("browser_inspect")).toBe(
        true,
      );
    }),
  ),
);

it("instructions follow the Tools an agent declares", () => {
  const plain = BrowserTools.instructions(BrowserTools.toolkit);

  expect(plain).toMatch(/untrusted/);
  expect(plain).toMatch(/one control per response/);
  expect(plain).toMatch(/inspect again/);
  expect(plain).not.toMatch(/browser_fill_form|browser_read_more|_and_inspect/);

  const full = BrowserTools.instructions(
    Toolkit.merge(
      BrowserTools.observedToolkit,
      BrowserTools.observedFormToolkit,
      BrowserTools.readingToolkit,
    ),
  );

  expect(full).toMatch(/_and_inspect returns the new observation/);
  expect(full).toMatch(/browser_fill_form/);
  expect(full).toMatch(/browser_read_more/);
  expect(BrowserTools.instructions()).toBe(BrowserTools.instructions(undefined));
});

it("the policy helper suits the Tools and yields to the host", () => {
  expect(BrowserTools.policy()).toMatchObject({
    repeatedFailureLimit: 5,
    toolResultBounds: { maxBytes: 50 * 1024 },
  });
  expect(BrowserTools.policy({ repeatedFailureLimit: 8, maxTurns: 4 })).toMatchObject({
    repeatedFailureLimit: 8,
    maxTurns: 4,
  });
  expect(BrowserTools.policy({}, { resultMaxBytes: 100_000 }).toolResultBounds).toMatchObject({
    maxBytes: 100_000,
  });
});

it.effect("describe replaces what the model reads and keeps each Tool's identity", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const described = BrowserTools.describe(BrowserTools.toolkit, {
        browser_click: "Click only the buttons this deployment allows.",
      });

      expect(described.tools.browser_click.description).toBe(
        "Click only the buttons this deployment allows.",
      );
      expect(described.tools.browser_click.id).toBe(BrowserTools.toolkit.tools.browser_click.id);
      expect(described.tools.browser_click.parametersSchema).toBe(
        BrowserTools.toolkit.tools.browser_click.parametersSchema,
      );
      expect(described.tools.browser_fill).toBe(BrowserTools.toolkit.tools.browser_fill);
      expect(BrowserTools.toolkit.tools.browser_click.description).not.toMatch(/deployment/);

      const host = yield* BrowserTools.makeHost(
        scriptedSession({ clickElement: () => Effect.succeed(ActionResult.make({ url })) }),
      );

      const ready = yield* described.pipe(Effect.provide(host.handlers));

      expect(
        yield* ready
          .handle("browser_click", { observationId: "o", elementId: "e" })
          .pipe(Effect.flatMap(Stream.runCollect)),
      ).toMatchObject([{ isFailure: false, encodedResult: { url } }]);
      expect(BrowserTools.isBrowserTool("browser_click")).toBe(true);
      expect(BrowserTools.isBrowserTool("search")).toBe(false);
    }),
  ),
);
