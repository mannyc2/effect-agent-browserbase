import { createHash } from "node:crypto";

import { Config, Effect, Option, type Redacted, Schema } from "effect";

import { publicOrigin } from "../fixtures/HostedSite.ts";
import {
  cases,
  Composition,
  type Fixture,
  hostedRoutes,
  maxRuns,
  Task,
  unmeasured,
} from "./Cases.ts";
import {
  admission,
  ChatSettings,
  decisionAdmission,
  Gateway,
  JevSettings,
  manifest,
  Provider,
  Rates,
  type Settings,
  type Manifest,
  type Provider as ProviderName,
} from "./Evidence.ts";
import type { Allowance, Ledger } from "./Spend.ts";

/**
 * A real-model campaign: which models run which cases, with which toolkits and trials, under what
 * spend. Nothing here imports a runner or provider or allocates anything, so a plan spends
 * nothing. A live campaign runs only the plan whose digest the operator approved.
 */

export class CampaignRefusal extends Schema.TaggedError<CampaignRefusal>()("CampaignRefusal", {
  reason: Schema.Literals([
    "specification",
    "settings",
    "backend",
    "task",
    "runs",
    "budget",
    "opt-in",
    "approval",
    "credentials",
    "provenance",
  ]),
  /** A fixed explanation naming only declared values, never a credential. */
  message: Schema.String,
}) {}

const refuse = (reason: CampaignRefusal["reason"], message: string) =>
  Effect.fail(new CampaignRefusal({ reason, message }));

/** Paid calls need this set to `1`, as well as the approved digest and each credential. */
export const optIn = "EFFECT_AGENT_BROWSER_EVALUATION_LIVE";

const credential = (provider: ProviderName, gateway: Gateway) =>
  provider === "typesafe"
    ? "TYPESAFE_API_KEY"
    : gateway === "openrouter"
      ? "OPENROUTER_API_KEY"
      : provider === "openai"
        ? "OPENAI_API_KEY"
        : "ANTHROPIC_API_KEY";

const Slug = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,39}$/));
const Usd = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1000 }));
const Limit = Schema.Finite.check(Schema.isBetween({ minimum: 0.01, maximum: 100 }));

const Model = Schema.Struct({
  id: Slug,
  provider: Provider,
  gateway: Gateway,
  /**
   * A published model's ID, prefixed through OpenRouter by its vendor (`openai/...`). A
   * fine-tuned model's (`ft:...`) names its account, and a variant (`:free`, `:batch`) routes and
   * prices differently, so both are refused.
   */
  model: Schema.String.check(Schema.isPattern(/^(?:[a-z]+\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/)),
  maxOutputTokens: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 32768 })),
  reasoningEffort: ChatSettings.fields.reasoningEffort,
  decisionThreshold: Schema.optionalKey(JevSettings.fields.decisionThreshold),
  /** US dollars per million tokens, as the dated source lists them. */
  rates: Schema.Struct({
    inputUsdPerMillion: Usd,
    cacheReadUsdPerMillion: Usd,
    cacheWriteUsdPerMillion: Usd,
    outputUsdPerMillion: Usd,
    source: Rates.fields.source,
    retrieved: Rates.fields.retrieved,
  }),
});

/** What an operator asks for; `plan` expands it into every run and refuses what it cannot bound. */
export const Spec = Schema.Struct({
  version: Schema.Literal(1),
  name: Slug,
  models: Schema.Array(Model).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
  backends: Schema.Array(Schema.Literals(["chromium", "browserbase"])).check(Schema.isMinLength(1)),
  toolkits: Schema.Array(Composition).check(Schema.isMinLength(1)),
  tasks: Schema.Array(Task).check(Schema.isMinLength(1)),
  trials: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
  budget: Schema.Struct({
    perRunUsd: Limit,
    campaignUsd: Limit,
    /** Each run's time bound, in place of a case's, which is sized for a script. */
    maxRunSeconds: Schema.Int.check(Schema.isBetween({ minimum: 30, maximum: 900 })),
  }),
  judges: Schema.Literal("disabled"),
});

/** A model as a plan runs it: its settings, integer prices and the credential it needs. */
export interface Subject {
  readonly id: string;
  readonly provider: ProviderName;
  readonly model: string;
  readonly settings: typeof Settings.Type;
  readonly rates: Rates;
  readonly credential: string;
}

export interface Measured {
  readonly runId: string;
  readonly subject: string;
  readonly task: Task;
  readonly toolkit: Composition;
  readonly trial: number;
  /** Browserbase runs a served case on the hosted fixture; Chromium, on its declared backend. */
  readonly backend: "chromium" | "browserbase" | "scripted-owner";
  readonly fixture: typeof Fixture.Type;
}

/** Whole micro-dollars, or undefined for a value finer than one. */
const micro = (usd: number) => {
  const value = Math.round(usd * 1_000_000);

  return Math.abs(value - usd * 1_000_000) < 1e-6 ? value : undefined;
};

const unique = (values: ReadonlyArray<string>) => new Set(values).size === values.length;

/**
 * The whole campaign before anything runs: every run in order, each model's settings and
 * prices, and the spend bounds admission enforces. A plan it cannot bound is refused whole.
 */
export const plan = Effect.fn("Campaign.plan")(function* (input: unknown) {
  const spec = yield* Schema.decodeUnknownEffect(Spec)(input).pipe(
    Effect.mapError(
      () =>
        new CampaignRefusal({
          reason: "specification",
          message: "The specification does not match the campaign schema.",
        }),
    ),
  );

  if (
    !unique(spec.models.map((model) => model.id)) ||
    !unique(spec.tasks) ||
    !unique(spec.toolkits) ||
    !unique(spec.backends)
  )
    return yield* refuse(
      "specification",
      "Model IDs, tasks, toolkits and backends must each be unique.",
    );
  const subjects: Array<Subject> = [];

  for (const model of spec.models) {
    const prices = [
      micro(model.rates.inputUsdPerMillion),
      micro(model.rates.cacheReadUsdPerMillion),
      micro(model.rates.cacheWriteUsdPerMillion),
      micro(model.rates.outputUsdPerMillion),
    ] as const;

    const [input, cacheRead, cacheWrite, output] = prices;

    if (
      input === undefined ||
      cacheRead === undefined ||
      cacheWrite === undefined ||
      output === undefined
    )
      return yield* refuse(
        "specification",
        `${model.id}: rates must be whole micro-dollars per million tokens.`,
      );

    const pricesForSubject = {
      inputPerMillionMicrousd: input,
      cacheReadPerMillionMicrousd: cacheRead,
      cacheWritePerMillionMicrousd: cacheWrite,
      outputPerMillionMicrousd: output,
      source: model.rates.source,
      retrieved: model.rates.retrieved,
    };

    if (model.provider === "typesafe") {
      if (
        model.model !== "jev-1.13.0" ||
        model.gateway !== "direct" ||
        model.maxOutputTokens !== 0 ||
        model.reasoningEffort !== null ||
        model.decisionThreshold === undefined ||
        cacheRead !== 0 ||
        cacheWrite !== 0 ||
        output !== 0
      )
        return yield* refuse(
          "settings",
          `${model.id}: Jev needs jev-1.13.0 directly, a decision threshold, no generation allowance or reasoning, and zero cache/output rates.`,
        );
      if (spec.backends.some((backend) => backend !== "chromium"))
        return yield* refuse("backend", "Jev's decision policy currently runs on Chromium only.");
      if (spec.tasks.some((task) => task !== "navigation"))
        return yield* refuse("task", "Jev's decision policy currently measures navigation only.");
      subjects.push({
        id: model.id,
        provider: model.provider,
        model: model.model,
        settings: {
          gateway: "direct",
          maxOutputTokens: 0,
          reasoningEffort: null,
          serviceTier: null,
          decisionThreshold: model.decisionThreshold,
        },
        rates: pricesForSubject,
        credential: credential(model.provider, model.gateway),
      });
      continue;
    }
    if (model.maxOutputTokens < 256 || model.decisionThreshold !== undefined)
      return yield* refuse(
        "settings",
        `${model.id}: chat models need at least 256 output tokens and cannot take a decision threshold.`,
      );
    if (
      model.gateway === "openrouter"
        ? !model.model.startsWith(`${model.provider}/`)
        : model.model.includes("/")
    )
      return yield* refuse(
        "specification",
        `${model.id}: through OpenRouter a model is named ${model.provider}/<model>; directly, without a vendor.`,
      );
    if (model.provider === "anthropic" && model.reasoningEffort !== null)
      return yield* refuse(
        "settings",
        `${model.id}: reasoning effort is an OpenAI setting, and Anthropic thinking is not supported.`,
      );
    subjects.push({
      id: model.id,
      provider: model.provider,
      model: model.model,
      settings: {
        gateway: model.gateway,
        maxOutputTokens: model.maxOutputTokens,
        reasoningEffort: model.reasoningEffort,
        serviceTier:
          model.gateway === "openrouter"
            ? null
            : model.provider === "openai"
              ? "default"
              : "standard_only",
      },
      rates: pricesForSubject,
      credential: credential(model.provider, model.gateway),
    });
  }

  // A hosted browser runs the hosted fixture, which shows the served cases it can report.
  const unhosted = spec.backends.includes("browserbase")
    ? spec.tasks.filter((task) => hostedRoutes[task] === undefined)
    : [];

  if (unhosted.length > 0)
    return yield* refuse(
      "backend",
      `Browserbase cannot run ${unhosted.join(", ")}: only signup, rerendered-submit and hostile-receipt have a hosted fixture; the other cases remain local.`,
    );
  const excluded = spec.tasks.filter((task) => unmeasured[task] !== undefined);

  if (excluded.length > 0)
    return yield* refuse(
      "task",
      excluded.map((task) => `${task}: ${unmeasured[task] ?? ""}`).join(" "),
    );

  // Every model runs the same case back to back, on each backend in turn, so drift during a
  // campaign affects each alike.
  const runs: ReadonlyArray<Measured> = Array.from({ length: spec.trials }, (_, trial) =>
    spec.tasks.flatMap((task) =>
      spec.toolkits.flatMap((toolkit) =>
        spec.backends.flatMap((backend) =>
          subjects.map((subject) => ({
            runId: `${subject.id}-${task}-${toolkit}${backend === "browserbase" ? "-browserbase" : ""}-${trial}`,
            subject: subject.id,
            task,
            toolkit,
            trial,
            backend: backend === "browserbase" ? ("browserbase" as const) : cases[task].backend,
            fixture: backend === "browserbase" ? ("hosted-v1" as const) : cases[task].fixture,
          })),
        ),
      ),
    ),
  ).flat();

  const sessions = runs.filter((entry) => entry.backend === "browserbase").length;

  if (runs.length > maxRuns)
    return yield* refuse("runs", `${runs.length} runs exceed the ${maxRuns}-run bound.`);
  const perRun = micro(spec.budget.perRunUsd);
  const campaign = micro(spec.budget.campaignUsd);

  if (perRun === undefined || campaign === undefined)
    return yield* refuse("specification", "Spend limits must be whole micro-dollars.");
  const worst = runs.length * perRun;

  if (worst > campaign)
    return yield* refuse(
      "budget",
      `${runs.length} runs at ${perRun} micro-dollars each could spend ${worst}; the campaign allows ${campaign}.`,
    );

  const body = {
    version: 1,
    mode: "real-model-plan",
    name: spec.name,
    evaluator: "browser-evaluation-v5",
    concurrency: 1,
    order:
      "trial, then task, toolkit, backend and model: every model runs the same case back to back",
    subjects,
    cases: Object.fromEntries(
      spec.tasks.map((task) => {
        const declared = cases[task];

        return [
          task,
          {
            family: declared.family,
            revision: declared.revision,
            split: declared.split,
            attack: declared.attack,
            goal: declared.goal,
            initialState: declared.initialState,
            backend: declared.backend,
            fixture: declared.fixture,
            // A measured run's time bound is the campaign's, not the script's.
            bounds: { ...declared.bounds, maxDurationMillis: spec.budget.maxRunSeconds * 1000 },
          },
        ];
      }),
    ),
    runs,
    budget: {
      perRunMicrousd: perRun,
      campaignMicrousd: campaign,
      worstCaseMicrousd: worst,
      maxRunMillis: spec.budget.maxRunSeconds * 1000,
      judgeMicrousd: 0,
      admission: subjects.some((subject) => subject.provider === "typesafe")
        ? "per subject; see admissionBySubject"
        : admission,
      admissionBySubject: Object.fromEntries(
        subjects.map((subject) => [
          subject.id,
          subject.provider === "typesafe" ? decisionAdmission : admission,
        ]),
      ),
    },
    browser:
      "a new local Chromium, scripted owner or Browserbase session for each run, closed before the next starts",
    // One provider session per hosted run, which the provider ends itself if never released.
    browserbase:
      sessions === 0
        ? null
        : {
            sessions,
            sessionSeconds: spec.budget.maxRunSeconds + 60,
            origin: publicOrigin,
            optIn: "EFFECT_AGENT_BROWSERBASE_LIVE=1",
            cost: "billed by Browserbase per browser minute on the account's plan; not metered here",
          },
    retries:
      "none: a refused, failed or unresolved request is recorded and never retried, and a broken price contract stops the campaign",
    judges: "disabled",
    heldOut:
      "held-out results must not inform Tool, instruction or prompt changes; one that does is re-declared tuning at a new revision",
    optIn: `${optIn}=1`,
    credentials: [
      ...new Set(subjects.map((subject) => subject.credential)),
      ...(sessions === 0 ? [] : ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID"]),
    ],
  };

  return {
    ...body,
    digest: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
  };
});

export type Plan = Effect.Success<ReturnType<typeof plan>>;

/**
 * Admit a live campaign: the opt-in first, then the plan, the approved digest and every
 * credential it needs, all before anything is allocated. Credentials stay redacted.
 */
export const authorize = Effect.fn("Campaign.authorize")(function* (
  input: unknown,
  approve: string | undefined,
) {
  const opted = yield* Config.option(Config.String(optIn)).pipe(Effect.orElseSucceed(Option.none));

  if (Option.getOrUndefined(opted) !== "1")
    return yield* refuse("opt-in", `Paid model calls need ${optIn}=1.`);
  const shown = yield* plan(input);

  // The digest comes only from `plan`, so approving a campaign means having read its plan.
  if (approve !== shown.digest)
    return yield* refuse(
      "approval",
      "Pass --approve with the digest `plan` prints for this specification, after reviewing it.",
    );
  // Hosted sessions need Browserbase's own opt-in, as its guarded checks do.
  if (shown.browserbase !== null) {
    const hosted = yield* Config.option(Config.String("EFFECT_AGENT_BROWSERBASE_LIVE")).pipe(
      Effect.orElseSucceed(Option.none),
    );

    if (Option.getOrUndefined(hosted) !== "1")
      return yield* refuse("opt-in", "Browserbase sessions need EFFECT_AGENT_BROWSERBASE_LIVE=1.");
  }
  // Keyed by the environment variable that names each credential.
  const credentials: Record<string, Redacted.Redacted<string>> = {};

  for (const name of shown.credentials) {
    const key = yield* Config.option(Config.Redacted(name)).pipe(Effect.orElseSucceed(Option.none));

    if (Option.isNone(key)) return yield* refuse("credentials", `${name} is required.`);
    credentials[name] = key.value;
  }

  return { plan: shown, credentials };
});

/** One planned run's manifest: the case as declared, with the model, prices and plan behind it. */
export const measuredManifest = (shown: Plan, run: Measured, sourceRevision: string): Manifest => {
  const subject = shown.subjects.find((candidate) => candidate.id === run.subject);

  if (subject === undefined) throw new Error(`Unplanned subject ${run.subject}`);

  const declared = manifest(
    {
      runId: run.runId,
      task: run.task,
      toolkit: run.toolkit,
      policy: "measured",
      role: "measured",
      trial: run.trial,
      ...(run.backend === "browserbase" ? { hosted: "browserbase" as const } : {}),
    },
    sourceRevision,
    {
      provider: subject.provider,
      model: subject.model,
      subject: subject.id,
      settings: subject.settings,
      rates: subject.rates,
      spend: {
        perRunMicrousd: shown.budget.perRunMicrousd,
        campaignMicrousd: shown.budget.campaignMicrousd,
        admission: subject.provider === "typesafe" ? decisionAdmission : admission,
      },
      campaign: { name: shown.name, digest: shown.digest },
    },
  );

  // A real model's turns take seconds; the plan's run time bound replaces the script's.
  return {
    ...declared,
    bounds: { ...declared.bounds, maxDurationMillis: shown.budget.maxRunMillis },
  };
};

/**
 * Hosted sessions, one per run: no more start than the plan counted, and none after a run whose
 * release the provider did not confirm, or whose allocation may have happened: that session may
 * still be running, and billed, until its own timeout.
 */
export class Sessions {
  readonly #planned: number;
  #started = 0;
  halted: "release unconfirmed" | null = null;
  constructor(planned: number) {
    this.#planned = planned;
  }
  admit(): boolean {
    if (this.halted !== null || this.#started >= this.#planned) return false;
    this.#started++;

    return true;
  }
  settle(
    facts: { readonly cleanup: string; readonly ownerClose: string },
    harness: string | null,
  ): void {
    if (facts.cleanup !== "confirmed" || facts.ownerClose !== "confirmed" || harness !== null)
      this.halted = "release unconfirmed";
  }
}

/** A run's allowance at its subject's prices, drawn from the campaign's ledger. */
export const allowance = (ledger: Ledger, shown: Plan, subject: Subject): Allowance =>
  ledger.allowance({
    limitMicrousd: shown.budget.perRunMicrousd,
    rates: {
      input: subject.rates.inputPerMillionMicrousd,
      cacheRead: subject.rates.cacheReadPerMillionMicrousd,
      cacheWrite: subject.rates.cacheWritePerMillionMicrousd,
      output: subject.rates.outputPerMillionMicrousd,
    },
    // Decision responses report output usage even though output is not billed or generated.
    maxOutputTokens:
      subject.provider === "typesafe" ? Number.MAX_SAFE_INTEGER : subject.settings.maxOutputTokens,
  });
