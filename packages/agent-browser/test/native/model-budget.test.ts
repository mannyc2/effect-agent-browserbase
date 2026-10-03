import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { run } from "../bench/Backends.ts";
import { Ledger } from "../bench/Budget.ts";
import { answer, scripted, type Driver } from "../bench/Drivers.ts";
import { Journal } from "../bench/Records.ts";
import { understanding } from "../bench/Understanding.ts";

it.live("narration passes reported native finish usage to its actual AgentRuntime estimator", () =>
  Effect.gen(function* () {
    const journal = new Journal({
      version: 1,
      runId: "narration-budget",
      scene: "read-table",
      backend: "chromium",
      driver: "scripted-usage",
      sourceRevision: "native-test",
      sourceDirty: false,
      trial: 0,
      seed: 0,
      viewport: { width: 1280, height: 720 },
      settings: {},
      capture: {
        maxFrames: 300,
        maxBytes: 16 * 1024 * 1024,
        quality: 30,
        maxDurationMillis: 15000,
      },
    });

    const ledger = new Ledger(400);

    const allowance = ledger.allowance({
      limitMicrousd: 400,
      maxOutputTokens: 100,
      rates: { input: 1000000, cacheRead: 500000, cacheWrite: 1000000, output: 2000000 },
    });

    const base = scripted(journal, [
      () =>
        answer({ caption: "Fixture response.", facts: {} }).map((part) =>
          part.type === "finish"
            ? {
                ...part,
                usage: {
                  inputTokens: { total: 100, uncached: 100 },
                  outputTokens: { total: 50, text: 50 },
                },
              }
            : part,
        ),
    ]);

    let estimates = 0;

    const driver: Driver = {
      ...base,
      estimate: (usage) =>
        Effect.sync(() => {
          estimates++;

          return allowance.settle(usage);
        }),
      finish: () => allowance.finish(),
    };

    yield* run(journal, (browser) =>
      Effect.gen(function* () {
        for (let index = 0; index < 2; index++) {
          yield* allowance.admit();
          yield* understanding(journal, browser, { driver, condition: "picture" });
          expect(allowance.usage()).toMatchObject({
            admitted: index + 1,
            settled: index + 1,
            costMicrousd: (index + 1) * 200,
            status: "estimated-from-reported-usage",
          });
        }
        expect((yield* allowance.admit().pipe(Effect.exit))._tag).toBe("Failure");
      }),
    );
    expect(estimates).toBe(2);
    expect(driver.finish()).toMatchObject({ settled: 2, costMicrousd: 400, refused: "run-budget" });
    expect(journal.cleanup).toBe("confirmed");
    expect(journal.ownerClose).toBe("confirmed");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
