import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OpenAiClient } from "@effect/ai-openai";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Exit, Redacted } from "effect";
import { Command } from "effect/unstable/cli";

import { authorize, allowance, measuredManifest, plan, type Plan } from "./evaluation/Campaign.ts";
import { orderReference } from "./evaluation/Cases.ts";
import { cli } from "./evaluation/Cli.ts";
import { Journal, manifest } from "./evaluation/Evidence.ts";
import { grade } from "./evaluation/Grading.ts";
import { admitAnthropic, admitOpenAi, guarded, measured } from "./evaluation/Provider.ts";
import { replay } from "./evaluation/Replay.ts";
import { Ledger } from "./evaluation/Spend.ts";
import { ownerPolicy, run } from "./evaluation/Tasks.ts";
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
  gateway: "direct",
  model: "gpt-test",
  maxOutputTokens: 2048,
  reasoningEffort: "low",
  rates,
} as const;

const claude = {
  id: "claude",
  provider: "anthropic",
  gateway: "direct",
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
  budget: { perRunUsd: 0.25, campaignUsd: 4, maxRunSeconds: 180 },
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
      // A real model's turns take seconds, not a script's milliseconds.
      maxRunMillis: 180_000,
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
    // Reading runs on the scripted owner, which no hosted browser replaces.
    expect(yield* reason(plan({ ...spec, backends: ["chromium", "browserbase"] }))).toBe("backend");
    // A lost acknowledgement's late write never reaches a hosted fixture's host.
    expect(
      yield* reason(plan({ ...spec, backends: ["browserbase"], tasks: ["lost-acknowledgement"] })),
    ).toBe("backend");
    expect(yield* reason(plan({ ...spec, tasks: ["signup", "cancelled-mutation"] }))).toBe("task");
    expect(
      yield* reason(
        plan({ ...spec, budget: { perRunUsd: 0.25, campaignUsd: 3.99, maxRunSeconds: 180 } }),
      ),
    ).toBe("budget");
    expect(
      yield* reason(
        plan({
          ...spec,
          tasks: ["signup", "reading", "lost-acknowledgement", "hostile-receipt"],
          trials: 8,
          budget: { perRunUsd: 0.25, campaignUsd: 100, maxRunSeconds: 180 },
        }),
      ),
    ).toBe("runs");
    expect(
      yield* reason(plan({ ...spec, models: [gpt, { ...claude, reasoningEffort: "low" }] })),
    ).toBe("settings");
    expect(yield* reason(plan({ ...spec, models: [gpt, { ...claude, id: "gpt" }] }))).toBe(
      "specification",
    );
    // A fine-tuned model's ID names the account that owns it, so it cannot enter a record.
    expect(
      yield* reason(plan({ ...spec, models: [{ ...gpt, model: "ft:gpt-test:acme::abc123" }] })),
    ).toBe("specification");
    // Through OpenRouter a model is named by its vendor, which must be the provider's; directly,
    // it is not. A variant such as `:free` or `:batch` routes and prices differently.
    for (const model of [
      { ...gpt, gateway: "openrouter" },
      { ...gpt, gateway: "openrouter", model: "anthropic/gpt-test" },
      { ...gpt, gateway: "openrouter", model: "openai/gpt-test:batch" },
      { ...gpt, model: "openai/gpt-test" },
    ])
      expect(yield* reason(plan({ ...spec, models: [model] }))).toBe("specification");
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
    expect(Redacted.value(granted.credentials.OPENAI_API_KEY!)).toBe("sk-SECRET");
    expect(Redacted.value(granted.credentials.ANTHROPIC_API_KEY!)).toBe("ak-SECRET");
  }),
);

it.effect("a refused live campaign creates no directory and loads no runner", () =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "campaign-")));
    const path = join(root, "spec.json");

    yield* Effect.promise(() => writeFile(path, JSON.stringify(spec)));
    const { digest } = yield* plan(spec);
    const start = Command.runWith(cli(), { version: "test" });

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

    const keyless = yield* start(args(join(root, "keyless"), digest)).pipe(
      withEnv({ ...live, OPENAI_API_KEY: "" }),
      Effect.flip,
    );

    expect(keyless).toMatchObject({ _tag: "CampaignRefusal", reason: "credentials" });
    expect(existsSync(join(root, "keyless"))).toBe(false);
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
    // Nothing was refused: the request was sent, and used more than was reserved for it.
    expect(first.usage()).toMatchObject({ refused: null, overrun: true, costMicrousd: 10_500 });

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

it.effect("a run admits one request at a time, each priced at its dearest input rate", () =>
  Effect.gen(function* () {
    const one = new Ledger(1_000_000).allowance({
      limitMicrousd: 100_000,
      rates: microusd,
      maxOutputTokens: 1000,
    });

    yield* one.admit(976);
    expect(Exit.isFailure(yield* Effect.exit(one.admit(976)))).toBe(true);
    expect(one.usage()).toMatchObject({ admitted: 1, refused: "concurrent", costMicrousd: 10_500 });
    // Its stream ended without usage: the next request is admitted, and the first retained whole.
    one.release();
    yield* one.admit(976);
    expect(one.usage()).toMatchObject({
      admitted: 2,
      costMicrousd: 21_000,
      retainedMicrousd: 21_000,
    });

    // A cache-read rate above the others prices the reservation: 2,000 tokens at 2, plus 8,000.
    const dear = new Ledger(1_000_000).allowance({
      limitMicrousd: 100_000,
      rates: { ...microusd, cacheRead: 2_000_000 },
      maxOutputTokens: 1000,
    });

    yield* dear.admit(976);
    expect(dear.usage().costMicrousd).toBe(12_000);

    // Usage for a request that was never admitted means one bypassed admission.
    const ledger = new Ledger(1_000_000);

    const stray = ledger.allowance({
      limitMicrousd: 100_000,
      rates: microusd,
      maxOutputTokens: 1000,
    });

    expect(stray.settle({ inputTokens: { total: 1 }, outputTokens: { total: 1 } })).toBe(0);
    expect(ledger.closed).toBe("contract");
    expect(stray.usage()).toMatchObject({ overrun: true });
  }),
);

it.effect("the transport sends only a request that was admitted", () =>
  Effect.gen(function* () {
    const wire = openAiWire(reading);

    const native = yield* OpenAiClient.make({
      apiKey: Redacted.make("key-SECRET"),
      transformClient: guarded({ armed: false }),
    }).pipe(Effect.provide(wire.layer));

    const exit = yield* Effect.exit(
      native.createResponseStream({ model: "gpt-test", input: [] } as never),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(wire.bodies).toEqual([]);
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
      { ...priced, conversation: "conv_1" },
      { ...priced, background: true },
      {
        ...priced,
        input: [
          { role: "user", content: [{ type: "input_image", image_url: "https://x.invalid/a" }] },
        ],
      },
      {
        ...priced,
        input: [{ role: "user", content: [{ type: "input_file", file_id: "file_1" }] }],
      },
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
      { payload: { ...message, speed: "fast" } },
      { payload: { ...message, inference_geo: "us" } },
      { payload: { ...message, container: "container_1" } },
      { payload: { ...message, context_management: { edits: [] } } },
      { payload: { ...message, mcp_servers: [] } },
      {
        payload: {
          ...message,
          messages: [
            {
              role: "user",
              content: [{ type: "document", source: { type: "url", url: "https://x.invalid/a" } }],
            },
          ],
        },
      },
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
    expect(evidence.manifest.bounds.maxDurationMillis).toBe(180_000);
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
      budget: { perRunUsd: 0.02, campaignUsd: 0.02, maxRunSeconds: 180 },
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

it.effect(
  "a live campaign records every planned run and stops admitting once a contract breaks",
  () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "campaign-")));

      const start = (
        specification: unknown,
        transport: ReturnType<typeof openAiWire>,
        out: string,
      ) =>
        Effect.gen(function* () {
          const path = join(root, `${out}.json`);

          yield* Effect.promise(() => writeFile(path, JSON.stringify(specification)));
          const { digest } = yield* plan(specification);

          return yield* Command.runWith(cli(transport.layer), { version: "test" })([
            "campaign",
            path,
            join(root, out),
            "--source-revision",
            "a".repeat(40),
            "--approve",
            digest,
          ]).pipe(withEnv(live));
        });

      const summary = (out: string): unknown =>
        JSON.parse(readFileSync(join(root, out, "campaign.json"), "utf8"));

      const one = { ...readingSpec, models: [gpt] };

      yield* start(one, openAiWire(reading), "done");
      expect(existsSync(join(root, "done", "plan.json"))).toBe(true);
      expect(summary("done")).toMatchObject({
        planned: 1,
        recorded: 1,
        notStarted: [],
        spendRefused: 0,
        harnessFailures: 0,
        incompleteEvidence: 0,
        subjects: { gpt: { planned: 1, recorded: 1, costMicrousd: 2680 } },
        spend: { spentMicrousd: 2680, closed: null },
      });

      // The first request reports far more input than its bytes allow: the campaign closes, that
      // run's next request is refused, and the second run never starts.
      const broken = openAiWire([
        { ...reading[0]!, usage: { input: 200_000, output: 80 } },
        reading[1]!,
      ]);

      const failure = yield* start({ ...one, trials: 2 }, broken, "stopped").pipe(Effect.flip);

      expect(failure).toMatchObject({ _tag: "EvidenceError" });
      expect(broken.bodies).toHaveLength(1);
      expect(summary("stopped")).toMatchObject({
        planned: 2,
        recorded: 1,
        notStarted: ["gpt-reading-base-1"],
        spendRefused: 1,
        spend: { closed: "contract" },
      });
    }).pipe(Effect.provide(NodeServices.layer)),
);

// OpenRouter serves the same OpenAI and Anthropic request formats under one credential. Its
// Responses stream ends with `data: [DONE]`, which is not an OpenAI event, and it prices by its
// own list, so no provider tier is sent.
it.effect("a measured run can reach either provider through OpenRouter", () =>
  Effect.gen(function* () {
    const routed = {
      ...readingSpec,
      models: [
        { ...gpt, gateway: "openrouter", model: "openai/gpt-test", reasoningEffort: null },
        { ...claude, gateway: "openrouter", model: "anthropic/claude-test" },
      ],
    };

    const shown = yield* plan(routed);

    expect(shown.credentials).toEqual(["OPENROUTER_API_KEY"]);
    expect(shown.subjects[0]).toMatchObject({
      credential: "OPENROUTER_API_KEY",
      settings: { gateway: "openrouter", serviceTier: null },
    });

    const openai = openAiWire(reading, { done: true });
    const viaOpenAi = yield* measure(shown, "gpt", openai);

    expect(grade(viaOpenAi)).toMatchObject({ task: "pass", termination: "completed" });
    expect(openai.sent.map((request) => request.url)).toEqual([
      "https://openrouter.ai/api/v1/responses",
      "https://openrouter.ai/api/v1/responses",
    ]);
    for (const body of openai.bodies) {
      expect(body).toMatchObject({ model: "openai/gpt-test", store: false });
      expect(body).not.toHaveProperty("service_tier");
    }

    const anthropic = anthropicWire(reading);
    const viaAnthropic = yield* measure(shown, "claude", anthropic);

    expect(grade(viaAnthropic)).toMatchObject({ task: "pass", termination: "completed" });
    expect(anthropic.sent).toEqual([
      { url: "https://openrouter.ai/api/v1/messages", credentials: ["authorization", "x-api-key"] },
      { url: "https://openrouter.ai/api/v1/messages", credentials: ["authorization", "x-api-key"] },
    ]);
    for (const body of anthropic.bodies) {
      expect(body).toMatchObject({ model: "anthropic/claude-test", max_tokens: 2048 });
      expect(body).not.toHaveProperty("service_tier");
      // OpenRouter refuses a null `cache_control`, which the provider package sends and
      // Anthropic's own API reads as absent.
      expect(JSON.stringify(body)).not.toContain('"cache_control":null');
    }
    expect(JSON.stringify([viaOpenAi, viaAnthropic])).not.toContain("SECRET");
  }),
);

// A provider's refusal is kept as its reason and HTTP status. Its message is provider text, so it
// stays out of the record, and the reservation for a request whose billing is unknown is kept.
it.effect("a provider refusal is recorded by reason and status, never by its message", () =>
  Effect.gen(function* () {
    const shown = yield* plan(readingSpec);
    const evidence = yield* measure(shown, "claude", anthropicWire([{ refuse: 400 }]));

    expect(evidence.facts.failure).toEqual({
      category: "infrastructure",
      tag: "AiError",
      reason: "InvalidRequestError",
      status: 400,
    });
    expect(evidence.facts.usage).toMatchObject({
      admitted: 1,
      settled: 0,
      status: "includes-retained-reservations",
    });
    expect(grade(evidence).termination).toBe("infrastructure-failure");
    expect(JSON.stringify(evidence)).not.toContain("SECRET");
  }),
);

// A real model's calls take seconds each: the browser must outlive the agent's own run bound, or
// its later actions meet a closed session and the model is graded for the harness's timeout.
it.effect("the browser owner outlives a measured run's time bound", () =>
  Effect.gen(function* () {
    const shown = yield* plan(readingSpec);
    const measuredRun = measuredManifest(shown, shown.runs[0]!, "b".repeat(40));

    expect(ownerPolicy(measuredRun).maxElapsedMillis).toBe(210_000);

    const scripted = manifest(
      {
        runId: "signup-base-completes-0",
        task: "signup",
        toolkit: "base",
        policy: "completes",
        role: "reference",
        trial: 0,
      },
      "unavailable",
    );

    expect(ownerPolicy(scripted).maxElapsedMillis).toBe(60_000);
  }),
);

const hosted = {
  ...spec,
  backends: ["chromium", "browserbase"],
  tasks: ["signup", "hostile-receipt"],
  toolkits: ["base"],
  trials: 1,
};

const browserbaseLive = {
  ...live,
  EFFECT_AGENT_BROWSERBASE_LIVE: "1",
  BROWSERBASE_API_KEY: "bb-SECRET",
  BROWSERBASE_PROJECT_ID: "project-SECRET",
};

// A hosted campaign's sessions are counted and bounded in the plan it is approved by, and need
// Browserbase's own opt-in and credentials as well as the evaluation's.
it.effect("a Browserbase campaign plans its sessions and needs Browserbase's opt-in", () =>
  Effect.gen(function* () {
    const shown = yield* plan(hosted);

    expect(shown.runs.map((entry) => [entry.runId, entry.backend])).toEqual([
      ["gpt-signup-base-0", "chromium"],
      ["claude-signup-base-0", "chromium"],
      ["gpt-signup-base-browserbase-0", "browserbase"],
      ["claude-signup-base-browserbase-0", "browserbase"],
      ["gpt-hostile-receipt-base-0", "chromium"],
      ["claude-hostile-receipt-base-0", "chromium"],
      ["gpt-hostile-receipt-base-browserbase-0", "browserbase"],
      ["claude-hostile-receipt-base-browserbase-0", "browserbase"],
    ]);
    expect(shown.browserbase).toMatchObject({
      sessions: 4,
      sessionSeconds: 240,
      origin: "https://example.com",
      optIn: "EFFECT_AGENT_BROWSERBASE_LIVE=1",
    });
    expect(shown.credentials).toEqual([
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "BROWSERBASE_API_KEY",
      "BROWSERBASE_PROJECT_ID",
    ]);
    expect(measuredManifest(shown, shown.runs[2]!, "b".repeat(40))).toMatchObject({
      fixture: "hosted-v1",
      backend: "browserbase",
    });
    expect(measuredManifest(shown, shown.runs[0]!, "b".repeat(40))).toMatchObject({
      fixture: "tool-site-v3",
      backend: "chromium",
    });

    // Chromium alone needs neither.
    expect((yield* plan({ ...hosted, backends: ["chromium"] })).browserbase).toBeNull();

    expect(yield* reason(authorize(hosted, shown.digest).pipe(withEnv(live)))).toBe("opt-in");
    expect(
      yield* reason(
        authorize(hosted, shown.digest).pipe(
          withEnv({ ...browserbaseLive, BROWSERBASE_PROJECT_ID: "" }),
        ),
      ),
    ).toBe("credentials");

    const granted = yield* authorize(hosted, shown.digest).pipe(withEnv(browserbaseLive));

    expect(Redacted.value(granted.credentials.BROWSERBASE_API_KEY!)).toBe("bb-SECRET");
  }),
);
