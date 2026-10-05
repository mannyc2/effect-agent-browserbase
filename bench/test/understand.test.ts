// Real Chromium captures and the pinned OpenRouter adapter; every HTTP response is local and free.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Ref, Schedule } from "effect";
import { Browser } from "effect-browser/Browser";
import * as Chromium from "effect-browser/Chromium";
import { AiError, LanguageModel } from "effect/ai";
import type { BrowserContext } from "playwright-core";

import { ledger } from "../Budget.ts";
import * as Quote from "../QuoteComparison.ts";
import { isolatedTrial } from "../Trial.ts";
import {
  compare,
  main,
  manifest,
  options,
  type Record as TrialRecord,
  scriptedModel,
  saveEvidence,
  summarize,
} from "../understand.ts";

const configuration = (args: ReadonlyArray<string> = []) =>
  options(["--hard-trials", "2", "--control-trials", "1", "--concurrency", "2", ...args], false);

const dryDescribe = (
  sample: Quote.QuoteCase,
  arm: Quote.Arm,
  account: Effect.Success<Effect.Success<ReturnType<typeof ledger>>["account"]>,
  content = JSON.stringify(sample.facts.conclusions),
) =>
  Effect.gen(function* () {
    const model = yield* scriptedModel(account, content);

    return yield* Quote.describe(sample, arm).pipe(
      Effect.provideService(LanguageModel.LanguageModel, model),
    );
  });

describe("understanding comparison", () => {
  it.effect(
    "requires paid opt-in before the entry point creates a browser or consults a model",
    () =>
      Effect.gen(function* () {
        const error = yield* main(["--model", "openai/paid-canary"], false).pipe(Effect.flip);

        assert.strictEqual(error._tag, "UnderstandRunError");
        assert.include(error.message, "EFFECT_BROWSER_BENCH_LIVE=1");
        const defaults = yield* options([], false);

        assert.strictEqual(defaults.model, undefined);
        assert.strictEqual(defaults.hardTrials, 20);
        assert.strictEqual(defaults.controlTrials, 10);
        assert.strictEqual(defaults.concurrency, 4);
        assert.strictEqual(defaults.maxUsd, 1);
      }),
  );

  it.effect("freezes reproducible pair seeds and arm orders before execution", () =>
    Effect.gen(function* () {
      const settings = yield* options([], false);
      const plan = manifest(settings, "fixed");
      const replay = manifest(settings, "fixed");
      const other = manifest({ ...settings, seed: 2 }, "fixed");

      assert.deepStrictEqual(replay, plan);
      assert.notDeepEqual(other.pairs, plan.pairs);
      assert.strictEqual(plan.pairs.length, 30);
      assert.strictEqual(plan.pairs.filter((pair) => pair.dense).length, 20);
      assert.isTrue(plan.pairs.every((pair) => [...pair.order].sort().join(",") === "A,B,facts"));
      assert.isAbove(new Set(plan.pairs.map((pair) => pair.order.join(","))).size, 1);
      assert.strictEqual(plan.mode, "dry-run");
      assert.include(plan.interpretation, "do not measure model accuracy");
    }),
  );

  it.live(
    "bounds cases and calls while preserving one capture and independent accounting per arm",
    () =>
      Effect.gen(function* () {
        const plan = manifest(yield* configuration(), "fixed");
        const budget = yield* ledger(1, 0.04);
        const browser = Chromium.layer();
        const active = yield* Ref.make(0);
        const maximum = yield* Ref.make(0);
        const bothStarted = yield* Deferred.make<void>();
        const contexts: Array<BrowserContext> = [];
        const prepared: Array<Quote.QuoteCase> = [];
        const seen: Array<{ readonly sample: Quote.QuoteCase; readonly arm: Quote.Arm }> = [];
        const saved: Array<TrialRecord> = [];

        const records = yield* compare(plan, budget, {
          prepare: (pair) =>
            isolatedTrial(
              Effect.gen(function* () {
                const owner = yield* Browser;

                contexts.push(owner.context);

                return yield* Quote.prepare(pair);
              }),
              browser,
            ).pipe(Effect.tap((sample) => Effect.sync(() => prepared.push(sample)))),
          describe: (sample, arm, account) =>
            Effect.gen(function* () {
              const count = yield* Ref.updateAndGet(active, (current) => current + 1);

              yield* Ref.update(maximum, (current) => Math.max(current, count));
              seen.push({ sample, arm });

              if (count === 2) yield* Deferred.succeed(bothStarted, undefined);
              yield* Deferred.await(bothStarted);

              const content = JSON.stringify(
                !sample.dense && arm === "A"
                  ? { ...sample.facts.conclusions, ticker: "WRONG" }
                  : sample.facts.conclusions,
              );

              return yield* dryDescribe(sample, arm, account, content).pipe(
                Effect.ensuring(Ref.update(active, (current) => current - 1)),
              );
            }),
          record: (record) =>
            Effect.sync(() => {
              saved.push(record);
            }),
        });

        assert.lengthOf(records, 9);
        assert.lengthOf(saved, 9);
        assert.lengthOf(prepared, 3);
        assert.strictEqual(new Set(contexts).size, 3);
        assert.isTrue(contexts.every((context) => context.pages().length === 0));
        assert.strictEqual(yield* Ref.get(maximum), 2);
        assert.isTrue(records.every((record) => record.status === "graded"));
        assert.strictEqual(records.filter((record) => record.pass).length, 8);
        assert.isTrue(records.every((record) => record.accounting.calls === 1));
        assert.isTrue(records.every((record) => record.accounting.uncertainCalls === 0));
        assert.isTrue(
          prepared.every((sample) => seen.filter((entry) => entry.sample === sample).length === 3),
        );
        assert.isTrue(
          prepared.every((sample) => {
            const triplet = records.filter((record) => record.seed === sample.seed);

            return new Set(triplet.map((record) => JSON.stringify(record.evidence))).size === 1;
          }),
        );
        assert.deepStrictEqual(yield* budget.snapshot, { knownUsd: 0, reservedUsd: 0 });
        const summary = summarize(plan, records);

        assert.isTrue(summary.paired.every((pair) => pair.completePairs === 3));
        assert.strictEqual(
          summary.paired.find((pair) => pair.comparison === "facts vs A")?.wins,
          1,
        );
        assert.strictEqual(
          summary.paired.find((pair) => pair.comparison === "facts vs B")?.wins,
          0,
        );
        const hard = summary.byTask.find((group) => group.task === "quote-dense");
        const control = summary.byTask.find((group) => group.task === "quote-table");

        assert.isTrue(hard?.arms.every((arm) => arm.graded === 2 && arm.passed === 2));
        assert.strictEqual(control?.arms.find((arm) => arm.arm === "A")?.gradingFailures, 1);
        assert.strictEqual(control?.arms.find((arm) => arm.arm === "A")?.bindingErrors, 1);
        assert.strictEqual(
          control?.paired.find((pair) => pair.comparison === "facts vs A")?.wins,
          1,
        );
        assert.isTrue(summary.arms.every((arm) => arm.graded === 3 && arm.calls === 3));
        assert.strictEqual(summary.mode, "dry-run");
      }),
  );

  it.live("grades malformed model output as a wrong answer and keeps admitting other arms", () =>
    Effect.gen(function* () {
      const plan = manifest(yield* configuration(), "fixed");
      const browser = Chromium.layer();
      const first = plan.pairs[0];

      assert.isDefined(first);
      if (first === undefined) return;
      const prepared = yield* isolatedTrial(Quote.prepare(first), browser);
      const budget = yield* ledger(1, 0.04);

      const records = yield* compare(plan, budget, {
        prepare: (pair) =>
          Effect.succeed({ ...prepared, seed: pair.seed, dense: pair.dense, task: pair.task }),
        describe: (sample, arm, account) =>
          sample.seed === first.seed
            ? dryDescribe(sample, arm, account, "malformed-json")
            : dryDescribe(sample, arm, account),
        record: () => Effect.void,
      });

      const malformed = records.filter((record) => record.seed === first.seed);

      assert.lengthOf(records, 9);
      assert.isTrue(records.every((record) => record.status === "graded"));
      assert.isTrue(
        malformed.every(
          (record) =>
            record.reason === "invalid-output" &&
            record.pass === false &&
            record.diagnostic?.objectDecode === "JsonSyntax" &&
            record.accounting.calls === 1 &&
            record.accounting.uncertainCalls === 0,
        ),
      );
      assert.strictEqual(records.filter((record) => record.pass === true).length, 6);
      assert.isFalse(yield* budget.exhausted);

      const summary = summarize(plan, records);

      assert.isTrue(
        summary.arms.every(
          (arm) =>
            arm.graded === 3 &&
            arm.gradingFailures === 1 &&
            arm.invalidOutputs === 1 &&
            arm.infrastructureFailed === 0,
        ),
      );
    }),
  );

  it.live(
    "stops future admissions on a provider failure and still accounts a dispatched peer",
    () =>
      Effect.gen(function* () {
        const plan = manifest(yield* configuration(), "fixed");
        const browser = Chromium.layer();
        const first = plan.pairs[0];
        const second = plan.pairs[1];

        assert.isDefined(first);
        assert.isDefined(second);
        if (first === undefined || second === undefined) return;
        const prepared = yield* isolatedTrial(Quote.prepare(first), browser);
        const budget = yield* ledger(1, 0.04);
        const dispatched = yield* Deferred.make<void>();
        const failed = yield* Deferred.make<void>();
        const entered = yield* Ref.make(0);

        const outage = AiError.make({
          module: "test",
          method: "createChatCompletion",
          reason: new AiError.InternalProviderError({ description: "provider outage" }),
        });

        const records = yield* compare(plan, budget, {
          prepare: (pair) =>
            Effect.succeed({ ...prepared, seed: pair.seed, dense: pair.dense, task: pair.task }),
          describe: (sample, _arm, account) =>
            Effect.gen(function* () {
              yield* Ref.update(entered, (current) => current + 1);

              // Fail only once the peer's request is dispatched, then settle the peer afterward.
              if (sample.seed === first.seed)
                return yield* account.run(
                  Deferred.await(dispatched).pipe(Effect.andThen(Effect.fail(outage))),
                  () => undefined,
                );

              yield* account.run(
                Deferred.succeed(dispatched, undefined).pipe(
                  Effect.andThen(Deferred.await(failed)),
                  Effect.as({
                    prompt_tokens: 12,
                    completion_tokens: 3,
                    cost: 0.01,
                  }),
                ),
                (value) => value,
              );

              return {
                ...Quote.grade(sample.facts.conclusions, sample.expected),
                answer: sample.facts.conclusions,
                steps: 1 as const,
                usage: { inputTokens: 12, outputTokens: 3, cachedInputTokens: 0 },
              };
            }),
          record: (record) =>
            record.status === "infrastructure-failed"
              ? Deferred.succeed(failed, undefined).pipe(Effect.asVoid)
              : Effect.void,
        });

        assert.strictEqual(yield* Ref.get(entered), 2);
        assert.lengthOf(records, 9);

        const failure = records.find((record) => record.status === "infrastructure-failed");

        assert.strictEqual(failure?.reason, "provider-failed");
        assert.strictEqual(failure?.diagnostic?.reason, "InternalProviderError");
        assert.strictEqual(records.filter((record) => record.status === "graded").length, 1);
        assert.isTrue(
          records
            .filter((record) => record.status === "unrun")
            .every((record) => record.reason === "stopped-after-infrastructure"),
        );
        assert.strictEqual(records.filter((record) => record.status === "unrun").length, 7);
        assert.strictEqual(
          records.reduce((sum, record) => sum + record.accounting.calls, 0),
          2,
        );
        assert.closeTo((yield* budget.snapshot).knownUsd, 0.01, 1e-9);
        assert.strictEqual((yield* budget.snapshot).reservedUsd, 0.04);
        assert.isTrue(yield* budget.exhausted);
        assert.isTrue(summarize(plan, records).paired.every((pair) => pair.completePairs === 0));
      }),
  );

  it.live("separates time queued for the budget from provider request time", () =>
    Effect.gen(function* () {
      const settings = yield* configuration([
        "--hard-trials",
        "4",
        "--control-trials",
        "0",
        "--concurrency",
        "4",
      ]);

      const plan = manifest(settings, "fixed");
      const first = plan.pairs[0];

      assert.isDefined(first);
      if (first === undefined) return;
      const prepared = yield* isolatedTrial(Quote.prepare(first), Chromium.layer());
      // Two $0.45 reservations fit in $1, so four concurrent cases queue for admission.
      const budget = yield* ledger(1, 0.45);

      const records = yield* compare(plan, budget, {
        prepare: (pair) =>
          Effect.succeed({ ...prepared, seed: pair.seed, dense: pair.dense, task: pair.task }),
        describe: (sample, _arm, account) =>
          account
            .run(
              Effect.sleep("300 millis").pipe(
                Effect.as({ prompt_tokens: 10, completion_tokens: 2, cost: 0.001 }),
              ),
              (value) => value,
            )
            .pipe(
              Effect.as({
                ...Quote.grade(sample.facts.conclusions, sample.expected),
                answer: sample.facts.conclusions,
                steps: 1 as const,
                usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 0 },
              }),
            ),
        record: () => Effect.void,
      });

      assert.lengthOf(records, 12);
      assert.isTrue(records.every((record) => record.timing.requestSeconds >= 0.29));
      assert.isTrue(records.some((record) => record.timing.queueSeconds >= 0.25));
      assert.isTrue(
        records.every(
          (record) =>
            Math.abs(record.seconds - record.timing.queueSeconds - record.timing.requestSeconds) <
            0.1,
        ),
      );

      const total = Math.max(...records.map((record) => record.seconds));

      for (const arm of summarize(plan, records).arms)
        assert.isBelow(arm.requestSeconds.p95 ?? Number.POSITIVE_INFINITY, total);
    }),
  );

  it.live("records every scheduled arm and keeps dispatched charges when interrupted", () =>
    Effect.gen(function* () {
      const settings = yield* configuration([
        "--hard-trials",
        "2",
        "--control-trials",
        "0",
        "--concurrency",
        "2",
      ]);

      const plan = manifest(settings, "fixed");
      const first = plan.pairs[0];

      assert.isDefined(first);
      if (first === undefined) return;
      const prepared = yield* isolatedTrial(Quote.prepare(first), Chromium.layer());
      const budget = yield* ledger(1, 0.1);
      const saved: Array<TrialRecord> = [];
      const dispatched = yield* Ref.make(0);

      const fiber = yield* compare(plan, budget, {
        prepare: (pair) =>
          Effect.succeed({ ...prepared, seed: pair.seed, dense: pair.dense, task: pair.task }),
        describe: (_sample, _arm, account) =>
          account.run(
            Ref.update(dispatched, (count) => count + 1).pipe(Effect.andThen(Effect.never)),
            () => undefined,
          ),
        record: (record) =>
          Effect.sync(() => {
            saved.push(record);
          }),
      }).pipe(Effect.forkChild);

      yield* Ref.get(dispatched).pipe(
        Effect.repeat({ schedule: Schedule.spaced("10 millis"), until: (count) => count === 2 }),
      );
      yield* Fiber.interrupt(fiber);

      assert.lengthOf(saved, 6);
      assert.isTrue(
        saved.every((record) => record.status === "unrun" && record.reason === "interrupted"),
      );
      assert.strictEqual(
        saved.reduce((sum, record) => sum + record.accounting.reservedUsd, 0),
        0.2,
      );
      assert.deepStrictEqual(yield* budget.snapshot, { knownUsd: 0, reservedUsd: 0.2 });
    }),
  );

  it.effect("wakes queued admissions without cancelling the request that already reserved", () =>
    Effect.gen(function* () {
      const budget = yield* ledger(0.04, 0.04);
      const active = yield* budget.account;
      const waiting = yield* budget.account;
      const entered = yield* Deferred.make<void>();
      const reply = yield* Deferred.make<void>();
      const requested = yield* Ref.make(0);
      const receipt = { prompt_tokens: 1, completion_tokens: 1, cost: 0.01 };

      const first = yield* active
        .run(
          Ref.update(requested, (count) => count + 1).pipe(
            Effect.andThen(Deferred.succeed(entered, undefined)),
            Effect.andThen(Deferred.await(reply)),
            Effect.as(receipt),
          ),
          (value) => value,
        )
        .pipe(Effect.forkChild);

      yield* Deferred.await(entered);

      const second = yield* waiting
        .run(Ref.update(requested, (count) => count + 1).pipe(Effect.as(receipt)), (value) => value)
        .pipe(Effect.flip, Effect.forkChild);

      yield* Effect.yieldNow;
      yield* budget.stop;
      const denied = yield* Fiber.join(second);

      assert.include(denied.message, "budget");
      assert.strictEqual((yield* waiting.snapshot).calls, 0);
      assert.strictEqual((yield* active.snapshot).uncertainCalls, 1);
      assert.strictEqual(yield* Ref.get(requested), 1);
      yield* Deferred.succeed(reply, undefined);
      yield* Fiber.join(first);
      assert.deepStrictEqual(yield* budget.snapshot, { knownUsd: 0.01, reservedUsd: 0 });
      assert.strictEqual((yield* active.snapshot).uncertainCalls, 0);
    }),
  );
  for (const scenario of [
    {
      name: "unknown model cost",
      timeout: false,
      status: "graded",
      reason: "answered",
      stopped: "stopped-after-uncertain-charge",
    },
    {
      name: "a model deadline",
      timeout: true,
      status: "infrastructure-failed",
      reason: "timed-out",
      stopped: "stopped-after-infrastructure",
    },
  ] as const) {
    it.live("retains unresolved charges and stops the remaining arms after " + scenario.name, () =>
      Effect.gen(function* () {
        const settings = yield* configuration([
          "--hard-trials",
          "1",
          "--control-trials",
          "0",
          "--concurrency",
          "1",
        ]);

        const plan = { ...manifest(settings, "fixed"), requestTimeoutMillis: 30 };
        const budget = yield* ledger(0.1, 0.04);
        const browser = Chromium.layer();

        const records = yield* compare(plan, budget, {
          prepare: (pair) => isolatedTrial(Quote.prepare(pair), browser),
          describe: (sample, _arm, account) =>
            Effect.gen(function* () {
              yield* account.run(
                scenario.timeout
                  ? Effect.never
                  : Effect.succeed({
                      prompt_tokens: 10,
                      completion_tokens: 2,
                    }),
                (value) => value,
              );

              return {
                ...Quote.grade(sample.facts.conclusions, sample.expected),
                answer: sample.facts.conclusions,
                steps: 1 as const,
                usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 0 },
              };
            }),
          record: () => Effect.void,
        });

        assert.lengthOf(records, 3);
        assert.strictEqual(records[0]?.status, scenario.status);
        assert.strictEqual(records[0]?.reason, scenario.reason);
        assert.strictEqual(records[0]?.accounting.calls, 1);
        assert.strictEqual(records[0]?.accounting.uncertainCalls, 1);
        assert.isTrue(
          records
            .slice(1)
            .every(
              (record) =>
                record.status === "unrun" &&
                record.reason === scenario.stopped &&
                record.accounting.calls === 0,
            ),
        );
        assert.deepStrictEqual(yield* budget.snapshot, { knownUsd: 0, reservedUsd: 0.04 });
        assert.isTrue(yield* budget.exhausted);
      }),
    );
  }
  it.live("saves reviewable case evidence before calls and refuses to overwrite a capture", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.sync(() => mkdtempSync(join(tmpdir(), "quote-evidence-"))),
        (path) => Effect.sync(() => rmSync(path, { recursive: true, force: true })),
      );

      const settings = yield* configuration([
        "--hard-trials",
        "1",
        "--control-trials",
        "0",
        "--concurrency",
        "1",
      ]);

      const plan = manifest(settings, "fixed");
      const pair = plan.pairs[0];

      assert.isDefined(pair);
      if (pair === undefined) return;
      const captured = yield* isolatedTrial(Quote.prepare(pair), Chromium.layer());

      yield* saveEvidence(directory, pair, captured);
      const target = join(directory, "cases", pair.task + "-" + pair.trial + "-" + pair.seed);
      const frame = captured.moment.frames[0];

      assert.isDefined(frame);
      assert.deepStrictEqual(
        Uint8Array.from(readFileSync(join(target, "native-0.jpg"))),
        frame?.data,
      );
      assert.deepStrictEqual(
        Uint8Array.from(readFileSync(join(target, "baseline.jpg"))),
        captured.baseline.data,
      );
      const evidence = readFileSync(join(target, "evidence.json"), "utf8");

      assert.include(evidence, captured.question);
      assert.include(evidence, '"timing"');
      assert.include(evidence, '"sha256"');
      assert.include(evidence, '"grading"');
      const budget = yield* ledger(1, 0.04);
      const calls = yield* Ref.make(0);

      const records = yield* compare(plan, budget, {
        prepare: () => saveEvidence(directory, pair, captured).pipe(Effect.as(captured)),
        describe: (sample, arm, account) =>
          Ref.update(calls, (value) => value + 1).pipe(
            Effect.andThen(dryDescribe(sample, arm, account)),
          ),
        record: () => Effect.void,
      });

      assert.strictEqual(yield* Ref.get(calls), 0);
      assert.isTrue(
        records.every(
          (record) =>
            record.status === "infrastructure-failed" && record.reason === "preparation-failed",
        ),
      );
      assert.isTrue(yield* budget.exhausted);
      assert.strictEqual(readFileSync(join(target, "evidence.json"), "utf8"), evidence);
    }).pipe(Effect.scoped),
  );
});
