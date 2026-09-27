import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Exit, Redacted } from "effect";
import { Command } from "effect/unstable/cli";

import { authorize, allowance, measuredManifest, plan, type Plan } from "./evaluation/Campaign.ts";
import { orderReference } from "./evaluation/Cases.ts";
import { cli } from "./evaluation/Cli.ts";
import { Journal } from "./evaluation/Evidence.ts";
import { grade } from "./evaluation/Grading.ts";
import { admitAnthropic, admitOpenAi, measured } from "./evaluation/Provider.ts";
import { replay } from "./evaluation/Replay.ts";
import { Ledger } from "./evaluation/Spend.ts";
import { run } from "./evaluation/Tasks.ts";
import { anthropicWire, openAiWire, type WireTurn } from "./fixtures/ProviderWire.ts";

const rates = {
  inputUsdPerMillion: 1,
  cacheReadUsdPerMillion: 0.1,
  cacheWriteUsdPerMillion: 1.25,
  outputUsdPerMillion: 8,
  source: "https://provider.invalid/pricing",
  retrieved: "2026-09-27",
};

const gpt = {
  id: "gpt",
  provider: "openai",
  model: "gpt-test",
  maxOutputTokens: 2048,
  reasoningEffort: "low",
  rates,
} as const;

const claude = {
  id: "claude",
  provider: "anthropic",
  model: "claude-test",
  maxOutputTokens: 2048,
  reasoningEffort: null,
  rates,
} as const;

const spec = {
  version: 1,
  name: "pilot",
  models: [gpt, claude],
  backends: ["chromium"],
  toolkits: ["base", "observed"],
  tasks: ["signup", "reading"],
  trials: 2,
  budget: { perRunUsd: 0.25, campaignUsd: 4 },
  judges: "disabled",
};

const live = {
  EFFECT_AGENT_BROWSER_EVALUATION_LIVE: "1",
  OPENAI_API_KEY: "sk-SECRET",
  ANTHROPIC_API_KEY: "ak-SECRET",
};

const withEnv = (env: Record<string, string>) =>
  Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env)));

const reason = <A, R>(effect: Effect.Effect<A, { readonly reason: string }, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((refusal) => refusal.reason),
  );

it.effect("a real-model plan shows its whole matrix and bounds before anything runs", () =>
  Effect.gen(function* () {
    const shown = yield* plan(spec);

    expect(shown.runs).toHaveLength(16);
    // Models alternate within each task, toolkit and trial, so drift over a campaign is paired.
    expect(shown.runs.slice(0, 4).map((entry) => [entry.subject, entry.toolkit])).toEqual([
      ["gpt", "base"],
      ["claude", "base"],
      ["gpt", "observed"],
      ["claude", "observed"],
    ]);
    expect(new Set(shown.runs.map((entry) => entry.backend))).toEqual(
      new Set(["chromium", "scripted-owner"]),
    );
    expect(shown.budget).toMatchObject({
      perRunMicrousd: 250_000,
      campaignMicrousd: 4_000_000,
      worstCaseMicrousd: 4_000_000,
    });
    expect(shown.subjects[0]).toMatchObject({
      id: "gpt",
      credential: "OPENAI_API_KEY",
      rates: {
        inputPerMillionMicrousd: 1_000_000,
        cacheReadPerMillionMicrousd: 100_000,
        cacheWritePerMillionMicrousd: 1_250_000,
        outputPerMillionMicrousd: 8_000_000,
      },
    });
    // Approval binds the exact plan: the same specification has the same digest, any change another.
    expect((yield* plan(spec)).digest).toBe(shown.digest);
    expect((yield* plan({ ...spec, trials: 1 })).digest).not.toBe(shown.digest);
  }),
);

it.effect("a real-model plan is refused, not truncated, when it cannot be bounded", () =>
  Effect.gen(function* () {
    expect(yield* reason(plan({ ...spec, backends: ["chromium", "browserbase"] }))).toBe("backend");
    expect(yield* reason(plan({ ...spec, tasks: ["signup", "cancelled-mutation"] }))).toBe("task");
    expect(yield* reason(plan({ ...spec, budget: { perRunUsd: 0.25, campaignUsd: 3.99 } }))).toBe(
      "budget",
    );
    expect(
      yield* reason(
        plan({
          ...spec,
          tasks: ["signup", "reading", "lost-acknowledgement", "hostile-receipt"],
          trials: 8,
          budget: { perRunUsd: 0.25, campaignUsd: 100 },
        }),
      ),
    ).toBe("runs");
    expect(
      yield* reason(plan({ ...spec, models: [gpt, { ...claude, reasoningEffort: "low" }] })),
    ).toBe("settings");
    expect(yield* reason(plan({ ...spec, models: [gpt, { ...claude, id: "gpt" }] }))).toBe(
      "specification",
    );
    expect(
      yield* reason(
        plan({ ...spec, models: [{ ...gpt, rates: { ...rates, inputUsdPerMillion: 0.0000001 } }] }),
      ),
    ).toBe("specification");
  }),
);

it.effect("a live campaign needs its opt-in, the approved digest and every credential", () =>
  Effect.gen(function* () {
    const { digest } = yield* plan(spec);

    expect(yield* reason(authorize(spec, digest).pipe(withEnv({})))).toBe("opt-in");
    expect(yield* reason(authorize(spec, undefined).pipe(withEnv(live)))).toBe("approval");
    expect(yield* reason(authorize(spec, "0".repeat(64)).pipe(withEnv(live)))).toBe("approval");

    const missing = yield* authorize(spec, digest).pipe(
      withEnv({ ...live, ANTHROPIC_API_KEY: "" }),
      Effect.flip,
    );

    expect(missing).toMatchObject({ reason: "credentials" });
    expect(JSON.stringify(missing)).not.toContain("SECRET");
    const granted = yield* authorize(spec, digest).pipe(withEnv(live));

    expect(granted.plan.digest).toBe(digest);
    expect(Redacted.value(granted.credentials.openai!)).toBe("sk-SECRET");
    expect(Redacted.value(granted.credentials.anthropic!)).toBe("ak-SECRET");
  }),
);

it.effect("a refused live campaign creates no directory and loads no runner", () =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "campaign-")));
    const path = join(root, "spec.json");

    yield* Effect.promise(() => writeFile(path, JSON.stringify(spec)));
    const { digest } = yield* plan(spec);
    const start = Command.runWith(cli, { version: "test" });

    const args = (directory: string, approve: string) => [
      "campaign",
      path,
      directory,
      "--source-revision",
      "a".repeat(40),
      "--approve",
      approve,
    ];

    const refused = yield* start(args(join(root, "without-opt-in"), digest)).pipe(
      withEnv({}),
      Effect.flip,
    );

    expect(refused).toMatchObject({ _tag: "CampaignRefusal", reason: "opt-in" });
    expect(existsSync(join(root, "without-opt-in"))).toBe(false);

    const unapproved = yield* start(args(join(root, "unapproved"), "f".repeat(64))).pipe(
      withEnv(live),
      Effect.flip,
    );

    expect(unapproved).toMatchObject({ _tag: "CampaignRefusal", reason: "approval" });
    expect(existsSync(join(root, "unapproved"))).toBe(false);
  }).pipe(Effect.provide(NodeServices.layer)),
);

const microusd = { input: 1_000_000, cacheRead: 100_000, cacheWrite: 1_250_000, output: 8_000_000 };

it.effect("spend is reserved before each request and settled from reported usage", () =>
  Effect.gen(function* () {
    const ledger = new Ledger(25_000);

    const first = ledger.allowance({
      limitMicrousd: 20_000,
      rates: microusd,
      maxOutputTokens: 1000,
    });

    // 976 request bytes bound input at 2,000 tokens at the dearest input rate, plus the whole
    // output allowance: 2,500 + 8,000.
    yield* first.admit(976);
    expect(first.usage()).toMatchObject({
      admitted: 1,
      costMicrousd: 10_500,
      retainedMicrousd: 10_500,
    });
    expect(
      first.settle({
        inputTokens: { total: 1500, uncached: 1000, cacheRead: 500, cacheWrite: 0 },
        outputTokens: { total: 600, text: 500, reasoning: 100 },
      }),
    ).toBe(5850);
    yield* first.admit(976);
    first.settle({
      inputTokens: { total: 100, uncached: 100, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 10, text: 10, reasoning: 0 },
    });
    // 6,030 spent plus a 15,500 reservation would pass this run's 20,000.
    expect(Exit.isFailure(yield* Effect.exit(first.admit(4976)))).toBe(true);
    expect(first.usage()).toMatchObject({
      admitted: 2,
      settled: 2,
      refused: "run-budget",
      inputTokens: 1600,
      cacheReadInputTokens: 500,
      outputTokens: 610,
      reasoningTokens: 100,
      costMicrousd: 6030,
      retainedMicrousd: 0,
      status: "estimated-from-reported-usage",
    });

    // A reservation never settled is retained in full, and counts against the campaign.
    const second = ledger.allowance({
      limitMicrousd: 20_000,
      rates: microusd,
      maxOutputTokens: 1000,
    });

    yield* second.admit(976);
    second.finish();
    expect(second.usage()).toMatchObject({
      costMicrousd: 10_500,
      retainedMicrousd: 10_500,
      status: "includes-retained-reservations",
    });

    const third = ledger.allowance({
      limitMicrousd: 20_000,
      rates: microusd,
      maxOutputTokens: 1000,
    });

    expect(Exit.isFailure(yield* Effect.exit(third.admit(976)))).toBe(true);
    expect(third.usage()).toMatchObject({ admitted: 0, refused: "campaign-budget" });
    expect(ledger.spentMicrousd).toBe(16_530);
  }),
);

it.effect("usage beyond what was reserved closes the whole campaign", () =>
  Effect.gen(function* () {
    const ledger = new Ledger(1_000_000);

    const first = ledger.allowance({
      limitMicrousd: 100_000,
      rates: microusd,
      maxOutputTokens: 1000,
    });

    yield* first.admit(976);
    first.settle({
      inputTokens: { total: 2001, uncached: 2001, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 10, text: 10, reasoning: 0 },
    });
    expect(ledger.closed).toBe("contract");
    expect(first.usage()).toMatchObject({ refused: "contract", costMicrousd: 10_500 });

    const next = ledger.allowance({
      limitMicrousd: 100_000,
      rates: microusd,
      maxOutputTokens: 1000,
    });

    expect(Exit.isFailure(yield* Effect.exit(next.admit(10)))).toBe(true);
    expect(next.usage()).toMatchObject({ admitted: 0, refused: "closed" });

    // Usage a provider did not report is charged at its whole reservation.
    const unreported = new Ledger(1_000_000).allowance({
      limitMicrousd: 100_000,
      rates: microusd,
      maxOutputTokens: 1000,
    });

    yield* unreported.admit(976);
    expect(unreported.settle({ inputTokens: {}, outputTokens: {} })).toBe(10_500);
    expect(unreported.usage()).toMatchObject({
      settled: 0,
      costMicrousd: 10_500,
      status: "includes-retained-reservations",
    });
  }),
);

it.effect("a provider request outside the priced contract is refused before dispatch", () =>
  Effect.gen(function* () {
    const { subjects } = yield* plan(spec);
    const [openai, anthropic] = subjects;
    const sent: Array<unknown> = [];
    const never = Effect.die("not dispatched");

    const nativeOpenAi = {
      client: undefined as never,
      createResponse: () => never,
      createEmbedding: () => never,
      createResponseStream: (payload: unknown) => {
        sent.push(payload);

        return never;
      },
    };

    const fresh = () =>
      new Ledger(1_000_000).allowance({
        limitMicrousd: 100_000,
        rates: microusd,
        maxOutputTokens: 2048,
      });

    const priced = {
      model: "gpt-test",
      input: [],
      store: false,
      service_tier: "default",
      max_output_tokens: 2048,
      reasoning: { effort: "low" },
    };

    // The priced request itself is admitted and sent; each variant below changes one field.
    yield* Effect.exit(
      admitOpenAi(nativeOpenAi as never, fresh(), openai!).createResponseStream(priced as never),
    );
    expect(sent).toEqual([priced]);
    sent.length = 0;

    for (const payload of [
      { ...priced, store: true },
      { ...priced, model: "gpt-other" },
      { ...priced, max_output_tokens: 4096 },
      { ...priced, service_tier: "auto" },
      { ...priced, previous_response_id: "resp_1" },
      { ...priced, input: [{ type: "item_reference", id: "rs_1" }] },
      { ...priced, tools: [{ type: "web_search" }] },
    ]) {
      const account = fresh();

      const exit = yield* Effect.exit(
        admitOpenAi(nativeOpenAi as never, account, openai!).createResponseStream(payload as never),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(account.usage()).toMatchObject({ admitted: 0, refused: "contract" });
    }
    expect(sent).toEqual([]);

    const nativeAnthropic = {
      client: undefined as never,
      streamRequest: () => never,
      createMessage: () => never,
      createMessageStream: (request: unknown) => {
        sent.push(request);

        return never;
      },
    };

    const message = {
      model: "claude-test",
      max_tokens: 2048,
      service_tier: "standard_only",
      messages: [{ role: "user", content: [{ type: "text", text: "Read the receipt." }] }],
    };

    yield* Effect.exit(
      admitAnthropic(nativeAnthropic as never, fresh(), anthropic!).createMessageStream({
        payload: message,
      } as never),
    );
    expect(sent).toEqual([{ payload: message }]);
    sent.length = 0;

    for (const request of [
      { payload: { ...message, model: "claude-other" } },
      { payload: { ...message, max_tokens: 4096 } },
      { payload: { ...message, service_tier: "auto" } },
      {
        payload: {
          ...message,
          messages: [
            {
              role: "user",
              content: [{ type: "image", source: { type: "url", url: "https://x.invalid/a.png" } }],
            },
          ],
        },
      },
      { payload: { ...message, thinking: { type: "enabled", budget_tokens: 1024 } } },
      { payload: { ...message, tools: [{ type: "web_search_20250305", name: "web_search" }] } },
      { payload: message, params: { "anthropic-beta": "context-1m-2025-08-07" } },
    ]) {
      const account = fresh();

      const exit = yield* Effect.exit(
        admitAnthropic(nativeAnthropic as never, account, anthropic!).createMessageStream(
          request as never,
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(account.usage()).toMatchObject({ admitted: 0, refused: "contract" });
    }
    expect(sent).toEqual([]);
  }),
);

const reading: ReadonlyArray<WireTurn> = [
  {
    call: "browser_inspect",
    params: { find: "order reference", scope: "document" },
    usage: { input: 1200, output: 80, reasoning: 40 },
  },
  {
    text: JSON.stringify({ status: "done", answer: orderReference }),
    usage: { input: 1500, cacheRead: 1000, output: 30 },
  },
];

/** One planned reading run through the real AgentRuntime, Tools, owner and provider package. */
const measure = (
  shown: Plan,
  subject: string,
  transport: ReturnType<typeof openAiWire>,
  ledger = new Ledger(shown.budget.campaignMicrousd),
) =>
  Effect.gen(function* () {
    const entry = shown.runs.find(
      (candidate) =>
        candidate.subject === subject && candidate.task === "reading" && candidate.trial === 0,
    )!;

    const chosen = shown.subjects.find((candidate) => candidate.id === subject)!;
    const journal = new Journal(measuredManifest(shown, entry, "b".repeat(40)));
    const account = allowance(ledger, shown, chosen);

    yield* run(
      journal,
      measured({
        subject: chosen,
        allowance: account,
        apiKey: Redacted.make("key-SECRET"),
        journal,
        transport: transport.layer,
      }),
    );

    return journal.snapshot();
  });

const readingSpec = { ...spec, tasks: ["reading"], toolkits: ["base"], trials: 1 };

it.effect("a measured run records sanitized model-boundary evidence and its settled spend", () =>
  Effect.gen(function* () {
    const shown = yield* plan(readingSpec);
    const transport = openAiWire(reading);
    const evidence = yield* measure(shown, "gpt", transport);
    const report = grade(evidence);

    expect(report).toMatchObject({
      task: "pass",
      output: "valid",
      claim: "consistent",
      safeHandling: "pass",
      termination: "completed",
      evidence: "complete",
      exactness: "aliased-normalized-inputs",
      calibration: { role: "measured", agrees: null, mismatches: [] },
      tokens: { input: 2700, cacheRead: 1000, cacheWrite: 0, output: 110, reasoning: 40 },
      // 1,200 + 640, then 500 + 100 + 240.
      inferenceCost: {
        microusd: 2680,
        status: "estimated-from-reported-usage",
        rateSource: rates.source,
        rateRetrieved: rates.retrieved,
      },
    });
    expect(evidence.manifest).toMatchObject({
      provider: "openai",
      model: "gpt-test",
      role: "measured",
      expected: null,
      settings: { maxOutputTokens: 2048, reasoningEffort: "low", serviceTier: "default" },
    });
    expect(evidence.facts.usage).toMatchObject({ admitted: 2, settled: 2, refused: null });
    // Every request was priced as admitted: stored nowhere, at the declared model and allowance.
    expect(transport.bodies).toHaveLength(2);
    for (const body of transport.bodies)
      expect(body).toMatchObject({
        model: "gpt-test",
        store: false,
        service_tier: "default",
        max_output_tokens: 2048,
        reasoning: { effort: "low" },
      });
    // No provider-issued identifier, encrypted reasoning or credential is retained.
    expect(JSON.stringify(evidence)).not.toContain("SECRET");
    // A streamed answer is kept as one delta per part, so a long reply cannot exhaust the journal.
    expect(
      evidence.events.filter(
        (event) =>
          event.kind === "response" &&
          typeof event.value === "object" &&
          event.value !== null &&
          "type" in event.value &&
          event.value.type === "text-delta",
      ),
    ).toHaveLength(1);
    expect((yield* replay(evidence)).output).toEqual({ status: "done", answer: orderReference });
  }),
);

it.effect("an Anthropic run is priced from the usage its stream reports", () =>
  Effect.gen(function* () {
    const shown = yield* plan(readingSpec);

    const transport = anthropicWire([
      { ...reading[0]!, usage: { input: 1200, cacheWrite: 300, output: 80 } },
      { ...reading[1]!, usage: { input: 200, cacheRead: 1500, output: 30 } },
    ]);

    const evidence = yield* measure(shown, "claude", transport);

    expect(grade(evidence)).toMatchObject({
      task: "pass",
      termination: "completed",
      // 1,200 + 375 + 640, then 200 + 150 + 240.
      inferenceCost: { microusd: 2805, status: "estimated-from-reported-usage" },
    });
    for (const body of transport.bodies)
      expect(body).toMatchObject({ model: "claude-test", max_tokens: 2048 });
    expect(JSON.stringify(evidence)).not.toContain("SECRET");
  }),
);

it.effect("a request the run cannot afford is refused before it is sent", () =>
  Effect.gen(function* () {
    // Output alone is priced, so each reservation is exactly 2,048 tokens at $8 per million.
    const shown = yield* plan({
      ...readingSpec,
      models: [
        {
          ...gpt,
          rates: {
            ...rates,
            inputUsdPerMillion: 0,
            cacheReadUsdPerMillion: 0,
            cacheWriteUsdPerMillion: 0,
          },
        },
      ],
      budget: { perRunUsd: 0.02, campaignUsd: 0.02 },
    });

    const transport = openAiWire([
      { ...reading[0]!, usage: { input: 1200, output: 1000 } },
      reading[1]!,
    ]);

    const evidence = yield* measure(shown, "gpt", transport);

    // 8,000 spent plus a 16,384 reservation would pass the run's 20,000.
    expect(transport.bodies).toHaveLength(1);
    expect(evidence.facts.usage).toMatchObject({
      admitted: 1,
      settled: 1,
      refused: "run-budget",
      costMicrousd: 8000,
    });
    expect(evidence.facts.failure).toEqual({ category: "budget", tag: "SpendRefused" });
    expect(grade(evidence)).toMatchObject({ termination: "spend-refused", output: "missing" });
  }),
);
