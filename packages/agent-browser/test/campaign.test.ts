import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OpenAiClient } from "@effect/ai-openai";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Cause, ConfigProvider, Effect, Exit, Redacted, Schema, Stream } from "effect";
import * as BrowserTools from "effect-agent-browser/tools";
import { AgentPolicyError } from "effect-agent/agent-error";
import * as AgentRuntime from "effect-agent/agent-runtime";
import * as Browser from "effect-browser/browser";
import * as Testing from "effect-browser/testing";
import { Command } from "effect/unstable/cli";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
  authorize,
  allowance,
  measuredManifest,
  plan,
  Sessions,
  type Plan,
} from "./evaluation/Campaign.ts";
import { orderReference } from "./evaluation/Cases.ts";
import { cli } from "./evaluation/Cli.ts";
import {
  decisionAdmission,
  diagnose,
  Journal,
  json,
  manifest,
  Manifest,
} from "./evaluation/Evidence.ts";
import { grade } from "./evaluation/Grading.ts";
import { provenance } from "./evaluation/Provenance.ts";
import {
  admitAnthropic,
  admitOpenAi,
  guarded,
  measured,
  withoutDone,
} from "./evaluation/Provider.ts";
import { replay } from "./evaluation/Replay.ts";
import { Ledger } from "./evaluation/Spend.ts";
import { agent, ownerPolicy, run } from "./evaluation/Tasks.ts";
import { feedRecorder, gradeUnderstanding } from "./evaluation/Understanding.ts";
import { anthropicWire, openAiWire, type WireTurn } from "./fixtures/ProviderWire.ts";
import { feedPosts } from "./fixtures/UnderstandingSite.ts";

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

const jev = {
  id: "jev",
  provider: "typesafe",
  gateway: "direct",
  model: "jev-1.13.0",
  maxOutputTokens: 0,
  reasoningEffort: null,
  decisionThreshold: 0.8,
  rates: {
    ...rates,
    cacheReadUsdPerMillion: 0,
    cacheWriteUsdPerMillion: 0,
    outputUsdPerMillion: 0,
  },
} as const;

const decisionSpec = {
  ...spec,
  models: [jev],
  tasks: ["navigation"],
  trials: 1,
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
    // The plan shows the time bound measured runs use, not the script's.
    expect(shown.cases.signup?.bounds.maxDurationMillis).toBe(180_000);
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
    // Enabling filming must not silently change a previously approved unfilmed plan.
    expect(shown.digest).toBe("160d0eead644bbdb8640bc6939a30843f5fab54225058a49f09a679bc3d0e3cf");
    expect((yield* plan({ ...spec, trials: 1 })).digest).not.toBe(shown.digest);
  }),
);

// Requested filming seam: approval must bind capture bounds, and capture cannot substitute an owner.
it.effect("filming is explicitly approved and refused for a non-Chromium owner", () =>
  Effect.gen(function* () {
    const capture = {
      format: "jpeg-frames-v1",
      maxFrames: 1200,
      maxBytes: 32 * 1024 * 1024,
      quality: 70,
    };

    const input = { ...spec, models: [gpt], tasks: ["feed-commentary"], trials: 1 };
    const plain = yield* plan(input);
    const filmed = yield* plan({ ...input, capture });

    expect(filmed.digest).not.toBe(plain.digest);
    expect(filmed).toMatchObject({ capture: { ...capture, maxDurationMillis: 185_000 } });
    expect(measuredManifest(filmed, filmed.runs[0]!, "unavailable").capture).toEqual(
      filmed.capture,
    );
    expect(measuredManifest(plain, plain.runs[0]!, "unavailable").capture).toBe("off");
    expect((yield* plan({ ...input, capture: { ...capture, maxFrames: 1000 } })).digest).not.toBe(
      filmed.digest,
    );
    expect(yield* reason(plan({ ...spec, capture }))).toBe("backend");
    expect(
      yield* reason(plan({ ...input, capture: { ...capture, maxBytes: 128 * 1024 * 1024 } })),
    ).toBe("specification");
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

it.effect("a Jev plan binds the decision policy, its rates and its output provenance", () =>
  Effect.gen(function* () {
    const shown = yield* plan(decisionSpec);
    const subject = shown.subjects[0]!;
    const evidence = measuredManifest(shown, shown.runs[0]!, "unavailable");

    expect(shown.credentials).toEqual(["TYPESAFE_API_KEY"]);
    expect(shown.runs.map((entry) => entry.backend)).toEqual(["chromium", "chromium"]);
    expect(subject.settings).toEqual({
      gateway: "direct",
      maxOutputTokens: 0,
      reasoningEffort: null,
      serviceTier: null,
      decisionThreshold: 0.8,
    });
    expect(shown.budget.admissionBySubject).toEqual({ jev: decisionAdmission });
    expect(evidence).toMatchObject({
      version: 5,
      evaluator: "browser-evaluation-v5",
      provider: "typesafe",
      boundary: "typesafe-decisions; host-derived-tool-calls",
      outputProvenance: "decision-policy",
      spend: { admission: decisionAdmission },
    });
    expect(Schema.is(Manifest)({ ...evidence, version: 4 })).toBe(false);
    expect(
      (yield* plan({ ...decisionSpec, models: [{ ...jev, decisionThreshold: 0.9 }] })).digest,
    ).not.toBe(shown.digest);
    expect(yield* reason(authorize(decisionSpec, shown.digest).pipe(withEnv(live)))).toBe(
      "credentials",
    );
    expect(
      (yield* authorize(decisionSpec, shown.digest).pipe(
        withEnv({ EFFECT_AGENT_BROWSER_EVALUATION_LIVE: "1", TYPESAFE_API_KEY: "test-SECRET" }),
      )).plan.digest,
    ).toBe(shown.digest);
  }),
);

it.effect("a Jev plan refuses unsupported models, settings, tasks and browser backends", () =>
  Effect.gen(function* () {
    for (const model of [
      { ...jev, model: "jev-latest" },
      { ...jev, gateway: "openrouter" },
      { ...jev, maxOutputTokens: 256 },
      { ...jev, reasoningEffort: "low" },
      Object.fromEntries(Object.entries(jev).filter(([name]) => name !== "decisionThreshold")),
      { ...jev, rates: { ...jev.rates, cacheReadUsdPerMillion: 1 } },
      { ...jev, rates: { ...jev.rates, cacheWriteUsdPerMillion: 1 } },
      { ...jev, rates: { ...jev.rates, outputUsdPerMillion: 1 } },
    ])
      expect(yield* reason(plan({ ...decisionSpec, models: [model] }))).toBe("settings");
    for (const decisionThreshold of [-0.1, 1.1])
      expect(
        yield* reason(plan({ ...decisionSpec, models: [{ ...jev, decisionThreshold }] })),
      ).toBe("specification");
    expect(yield* reason(plan({ ...decisionSpec, tasks: ["signup"] }))).toBe("task");
    expect(yield* reason(plan({ ...decisionSpec, backends: ["browserbase"] }))).toBe("backend");
    expect(yield* reason(plan({ ...spec, models: [{ ...gpt, decisionThreshold: 0.8 }] }))).toBe(
      "settings",
    );
    expect(yield* reason(plan({ ...spec, models: [{ ...gpt, maxOutputTokens: 0 }] }))).toBe(
      "settings",
    );
  }),
);

it.effect("Jev reserves the full input allowance and counts free response tokens", () =>
  Effect.gen(function* () {
    const shown = yield* plan(decisionSpec);
    const ledger = new Ledger(shown.budget.campaignMicrousd);
    const bounded = allowance(ledger, shown, shown.subjects[0]!);

    yield* bounded.admit(65536);
    expect(bounded.usage()).toMatchObject({ retainedMicrousd: 66560 });
    expect(
      bounded.settle({
        inputTokens: { total: 500, uncached: 500, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 73, text: 73, reasoning: 0 },
      }),
    ).toBe(500);
    expect(bounded.usage()).toMatchObject({
      inputTokens: 500,
      outputTokens: 73,
      costMicrousd: 500,
      retainedMicrousd: 0,
      overrun: false,
    });
    expect(ledger.closed).toBe(null);
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

    // The source is a directory the campaign reads its commit from, not a stated revision.
    const args = (directory: string, approve: string) => [
      "campaign",
      path,
      directory,
      "--source-root",
      root,
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

    // Not a clean checkout whose packages match the ones that would run.
    const unproven = yield* start(args(join(root, "unproven"), digest)).pipe(
      withEnv(live),
      Effect.flip,
    );

    expect(unproven).toMatchObject({ _tag: "CampaignRefusal", reason: "provenance" });
    expect(existsSync(join(root, "unproven"))).toBe(false);
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

it.effect.each([
  { id: "gpt", wire: openAiWire },
  { id: "claude", wire: anthropicWire },
])("$id commentary pairs retained aliases through the real provider client", ({ id, wire }) =>
  Effect.gen(function* () {
    const shown = yield* plan({
      ...spec,
      tasks: ["feed-commentary"],
      toolkits: ["base"],
      trials: 1,
    });

    const entry = shown.runs.find((candidate) => candidate.subject === id)!;
    const chosen = shown.subjects.find((candidate) => candidate.id === id)!;
    const post = feedPosts[0]!;

    const output = {
      status: "done",
      answer: "Delivered commentary for one observed post.",
    } as const;

    const params = {
      observationId: "observation-1",
      postId: post.id,
      quote: post.text,
      claim: post.claim,
      caption: `${post.author}: ${post.text}`,
    };

    const transport = wire([
      {
        call: "browser_inspect",
        params: { scope: "viewport" },
        usage: { input: 1200, output: 80 },
      },
      { call: "browser_commentary", params, usage: { input: 1500, output: 100 } },
      { text: JSON.stringify(output), usage: { input: 1800, output: 30 } },
    ]);

    // Only the native page engine and HTTP replies are scripted; the owner and provider clients run.
    const journal = new Journal({
      ...measuredManifest(shown, entry, "b".repeat(40)),
      backend: "scripted-owner",
      fixture: "scripted-document-v1",
    });

    const driver = measured({
      subject: chosen,
      allowance: allowance(new Ledger(shown.budget.campaignMicrousd), shown, chosen),
      apiKey: Redacted.make("key-SECRET"),
      journal,
      transport: transport.layer,
    });

    const given = journal.manifest.goal;

    journal.facts = { ...journal.facts, input: given };

    const result = yield* Browser.scoped(
      Testing.open(
        {
          documents: [
            {
              url: "https://fixture.test/feed",
              text: `Post ${post.id} · ${post.author}\n${post.text}`,
            },
          ],
        },
        {
          policy: ownerPolicy(journal.manifest),
          viewport: journal.manifest.viewport,
          onCleanup: (receipt) =>
            Effect.sync(() => {
              journal.facts = {
                ...journal.facts,
                cleanup:
                  receipt.connection === "closed" && receipt.issues.length === 0
                    ? "confirmed"
                    : "unconfirmed",
                cleanupReceipt: json({ connection: receipt.connection, issues: receipt.issues }),
              };
            }),
        },
      ),
      (browser) =>
        Effect.gen(function* () {
          const recorder = feedRecorder(journal, browser);

          const host = yield* BrowserTools.makeHost(browser, browser.initialPage, {
            observe: recorder.observe,
          });

          return yield* host.run(
            driver
              .provide(
                AgentRuntime.run(agent("base", journal.manifest.bounds, "feed-commentary"), given, {
                  onHistory: driver.history,
                  estimateCostMicrousd: driver.estimate,
                }),
              )
              .pipe(Effect.provide(recorder.layer)),
          );
        }),
    );

    journal.facts = {
      ...journal.facts,
      terminal: "completed",
      finishReason: result.finishReason,
      turns: result.turns,
      output: json(result.output),
      outputValid: true,
      ownerClose: "confirmed",
      usage: driver.finish(),
    };
    const evidence = journal.snapshot();

    expect(gradeUnderstanding(evidence)).toMatchObject({
      kind: "feed-commentary",
      passed: false,
      groundedCoverage: [post.id],
      wrong: 0,
      unrecorded: 0,
      commentary: [{ paired: true, fresh: true, sourceObserved: true, claimCorrect: true }],
    });
    expect(grade(evidence)).toMatchObject({ evidence: "complete", cleanup: "confirmed" });
    expect(evidence.facts.usage).toMatchObject({ admitted: 3, settled: 3, retainedMicrousd: 0 });
    expect(transport.bodies).toHaveLength(3);
    expect(JSON.stringify(evidence)).not.toContain("SECRET");
    expect((yield* replay(evidence)).output).toEqual(output);
  }),
);

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

          return yield* Command.runWith(
            cli({ transport: transport.layer, provenance: () => Effect.succeed("a".repeat(40)) }),
            { version: "test" },
          )(["campaign", path, join(root, out), "--source-root", root, "--approve", digest]).pipe(
            withEnv(live),
          );
        });

      const summary = (out: string): unknown =>
        JSON.parse(readFileSync(join(root, out, "campaign.json"), "utf8"));

      const one = { ...readingSpec, models: [gpt] };

      yield* start(one, openAiWire(reading), "done");
      expect(existsSync(join(root, "done", "plan.json"))).toBe(true);

      // Every file the campaign wrote is listed with its digest, as the hosted runner's are.
      const sums = readFileSync(join(root, "done", "SHA256SUMS"), "utf8")
        .trim()
        .split("\n");

      expect(sums.map((line) => line.split("  ")[1])).toEqual(
        expect.arrayContaining(["campaign.json", "plan.json", "gpt-reading-base-0/report.json"]),
      );
      for (const line of sums) {
        const [digestHex, file] = line.split("  ");

        expect(
          createHash("sha256")
            .update(readFileSync(join(root, "done", file!)))
            .digest("hex"),
        ).toBe(digestHex);
      }
      expect(JSON.parse(readFileSync(join(root, "done", "campaign.json"), "utf8"))).toMatchObject({
        sourceRevision: "a".repeat(40),
      });
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
    // Only the vendor's own endpoint serves it, so its listed rates are the ones charged.
    for (const body of openai.bodies) {
      expect(body).toMatchObject({
        model: "openai/gpt-test",
        store: false,
        provider: { only: ["openai"], allow_fallbacks: false },
      });
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
      expect(body).toMatchObject({
        model: "anthropic/claude-test",
        max_tokens: 2048,
        provider: { only: ["anthropic"], allow_fallbacks: false },
      });
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
    expect(shown.runs.map((entry) => entry.fixture)).toEqual([
      "tool-site-v3",
      "tool-site-v3",
      "hosted-v1",
      "hosted-v1",
      "tool-site-v3",
      "tool-site-v3",
      "hosted-v1",
      "hosted-v1",
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

// Sessions start one at a time, no more than planned, and none after a release the provider did
// not confirm: that session may still be running, and billed.
it("hosted sessions stop at the plan's count and after any unconfirmed release", () => {
  const sessions = new Sessions(3);

  expect(sessions.admit()).toBe(true);
  sessions.settle({ cleanup: "confirmed", ownerClose: "confirmed" }, null);
  expect(sessions.admit()).toBe(true);
  sessions.settle({ cleanup: "unconfirmed", ownerClose: "confirmed" }, null);
  expect(sessions.admit()).toBe(false);
  expect(sessions.halted).toBe("release unconfirmed");

  const counted = new Sessions(1);

  expect(counted.admit()).toBe(true);
  counted.settle({ cleanup: "confirmed", ownerClose: "confirmed" }, null);
  expect(counted.admit()).toBe(false);

  const failed = new Sessions(2);

  failed.admit();
  failed.settle({ cleanup: "missing", ownerClose: "missing" }, "AllocationError");
  expect(failed.admit()).toBe(false);
  expect(failed.halted).toBe("release unconfirmed");
});

// A campaign's source revision is read from a clean checkout whose owned packages are the ones
// in the workspace that runs, never taken on trust.
it.effect("a campaign's source revision is a clean checkout matching the workspace", () =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "provenance-")));
    const source = join(root, "source");
    const tree = join(root, "tree");

    for (const base of [source, tree])
      yield* Effect.promise(async () => {
        await mkdir(join(base, "packages", "agent-browser"), { recursive: true });
        await writeFile(join(base, "packages", "agent-browser", "Harness.ts"), "export {};\n");
      });

    const git = (...args: ReadonlyArray<string>) =>
      execFileSync("git", ["-C", source, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
        encoding: "utf8",
      }).trim();

    git("init", "-q");
    git("add", ".");
    git("commit", "-q", "-m", "source");
    const head = git("rev-parse", "HEAD");

    expect(yield* provenance(source, tree)).toBe(head);

    // The workspace runs something else than the commit says.
    yield* Effect.promise(() =>
      writeFile(join(tree, "packages", "agent-browser", "Harness.ts"), "export const x = 1;\n"),
    );
    expect(yield* reason(provenance(source, tree))).toBe("provenance");

    // The checkout itself has changes no commit names.
    yield* Effect.promise(() =>
      writeFile(join(source, "packages", "agent-browser", "Harness.ts"), "export const x = 1;\n"),
    );
    expect(yield* reason(provenance(source, tree))).toBe("provenance");
    expect(yield* reason(provenance(root, tree))).toBe("provenance");
  }),
);

// OpenRouter's closing `data: [DONE]` line is dropped however the stream is chunked: split
// multi-byte characters, CRLF line ends and every other event survive intact.
it.effect("the OpenRouter stream keeps every event but its closing line", () =>
  Effect.gen(function* () {
    const events = [
      'event: response.output_text.delta\r\ndata: {"delta":"Grüße, 世界"}\r\n\r\n',
      'event: response.completed\r\ndata: {"type":"response.completed"}\r\n\r\n',
      "data: [DONE]\r\n\r\n",
    ].join("");

    const bytes = new TextEncoder().encode(events);

    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            new ReadableStream({
              start: (controller) => {
                // Five-byte chunks split the multi-byte characters and the CRLF pairs.
                for (let offset = 0; offset < bytes.length; offset += 5)
                  controller.enqueue(bytes.slice(offset, offset + 5));
                controller.close();
              },
            }),
          ),
        ),
      ),
    );

    const response = yield* withoutDone(client).execute(
      HttpClientRequest.get("https://openrouter.ai/api/v1/responses"),
    );

    const text = yield* response.stream.pipe(Stream.decodeText, Stream.mkString);

    // Only that one line goes; lines are rejoined with LF, which SSE reads as CRLF.
    expect(text.split(/\r?\n/)).toEqual(events.replace("data: [DONE]\r\n", "").split(/\r?\n/));
  }),
);

it("a policy stop is recorded by the limit it names", () => {
  expect(
    diagnose(Cause.fail(AgentPolicyError.make({ limit: "duration", message: "stopped" }))),
  ).toMatchObject({ reason: "duration", status: null });
});
