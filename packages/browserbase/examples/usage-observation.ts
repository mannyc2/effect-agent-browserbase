import { Cause, DateTime, Effect, Exit, Layer, Option, Schema } from "effect";
import { BrowserbaseAgents, type AgentRun, type AgentRunRequest } from "effect-browserbase/agents";
import { BrowserbaseClient } from "effect-browserbase/client";
import type { PlatformError, ProjectError } from "effect-browserbase/errors";
import {
  BrowserbasePageFetch,
  type PageFetchRequest,
  type PageFetchResult,
} from "effect-browserbase/page-fetch";
import { BrowserbaseProjects, ProjectUsage } from "effect-browserbase/projects";
import { Identifier } from "effect-browserbase/references";
import { BrowserbaseSearch, type SearchQuery, type SearchResults } from "effect-browserbase/search";

/** The provider supplied the usage; only the timestamp belongs to this host. */
export class ProjectUsageObservation extends Schema.Class<ProjectUsageObservation>(
  "ProjectUsageObservation",
)({
  source: Schema.Literal("browserbase-project-usage"),
  usage: ProjectUsage,
  observedAt: Schema.DateTimeUtcFromString,
}) {}

/** The host chooses a durable writer and retains its typed failure and service requirements. */
export const sampleProjectUsage = Effect.fn("sampleProjectUsage")(function* <
  WriteError,
  WriteRequirements,
>(
  write: (sample: ProjectUsageObservation) => Effect.Effect<void, WriteError, WriteRequirements>,
): Effect.fn.Return<
  ProjectUsageObservation,
  ProjectError | WriteError,
  BrowserbaseProjects | WriteRequirements
> {
  const projects = yield* BrowserbaseProjects;
  const usage = yield* projects.usage;
  const observedAt = yield* DateTime.now;

  const sample = ProjectUsageObservation.make({
    source: "browserbase-project-usage",
    usage,
    observedAt,
  });

  yield* write(sample);

  return sample;
});

export const LocalOperation = Schema.Literals(["search-web", "fetch", "agent-run"]);
export type LocalOperation = typeof LocalOperation.Type;

export const LocalOutcome = Schema.Literals(["api-reply", "undispatched", "rejected", "unknown"]);
export type LocalOutcome = typeof LocalOutcome.Type;

export const RequestedFormat = Schema.Literals(["raw", "json", "markdown"]);
export type RequestedFormat = typeof RequestedFormat.Type;

/** An API reply or failure is an activity fact, never a billed-call receipt. */
export class LocalOperationObservation extends Schema.Class<LocalOperationObservation>(
  "LocalOperationObservation",
)({
  source: Schema.Literal("host-observed"),
  projectId: Identifier,
  operation: LocalOperation,
  requestedFormat: Schema.optionalKey(RequestedFormat),
  requestedProxies: Schema.optionalKey(Schema.Boolean),
  observedAt: Schema.DateTimeUtcFromString,
  outcome: LocalOutcome,
}) {}

export type OperationIdentity =
  | {
      readonly projectId: string;
      readonly operation: "search-web" | "agent-run";
      readonly requestedFormat?: never;
      readonly requestedProxies?: never;
    }
  | {
      readonly projectId: string;
      readonly operation: "fetch";
      readonly requestedFormat?: RequestedFormat;
      readonly requestedProxies?: boolean;
    };

const classify = <A>(
  exit: Exit.Exit<A, PlatformError>,
  operation: LocalOperation,
): LocalOutcome => {
  if (Exit.isSuccess(exit)) return "api-reply";

  const reasons = exit.cause.reasons;
  const only = reasons[0];

  // A first typed error does not explain a mixed failure, defect or interruption.
  if (reasons.length !== 1 || only === undefined || !Cause.isFailReason(only)) return "unknown";

  const service =
    operation === "search-web" ? "search" : operation === "fetch" ? "fetch" : "agents";

  return only.error.operation === operation && only.error.service === service
    ? (only.error.outcome ?? "unknown")
    : "unknown";
};

const settle = <A, WriteError, WriteRequirements>(
  exit: Exit.Exit<A, PlatformError>,
  identity: OperationIdentity,
  write: (
    observation: LocalOperationObservation,
  ) => Effect.Effect<void, WriteError, WriteRequirements>,
): Effect.Effect<void, never, WriteRequirements> =>
  Effect.gen(function* () {
    const observedAt = yield* DateTime.now;

    yield* write(
      LocalOperationObservation.make({
        source: "host-observed",
        projectId: identity.projectId,
        operation: identity.operation,
        ...(identity.requestedFormat === undefined
          ? {}
          : { requestedFormat: identity.requestedFormat }),
        ...(identity.requestedProxies === undefined
          ? {}
          : { requestedProxies: identity.requestedProxies }),
        observedAt,
        outcome: classify(exit, identity.operation),
      }),
    );
  }).pipe(
    // onExit and release finalizers are masked. The race bounds a cooperative sink only.
    Effect.timeoutOption("2 seconds"),
    Effect.matchCauseEffect({
      onFailure: () => Effect.logWarning("usage observation failed"),
      onSuccess: (result) =>
        Option.isNone(result) ? Effect.logWarning("usage observation timed out") : Effect.void,
    }),
    Effect.ignoreCause,
  );

/** The host implements this port with an actual durable store and unique intent ids. */
export interface ObservationJournal<
  BeginError,
  BeginRequirements,
  FinishError,
  FinishRequirements,
> {
  readonly begin: (
    identity: OperationIdentity,
    startedAt: DateTime.Utc,
  ) => Effect.Effect<string, BeginError, BeginRequirements>;
  readonly finish: (
    id: string,
    observation: LocalOperationObservation,
  ) => Effect.Effect<void, FinishError, FinishRequirements>;
}

/**
 * A committed intent with a host Clock start time precedes the POST. The journal must
 * make begin bounded and durable, and finish idempotent. Unsettled ids remain unknown
 * after a crash; never replay the POST.
 */
const observePlatformAttempt = <
  A,
  R,
  BeginError,
  BeginRequirements,
  SettleError,
  SettleRequirements,
>(
  call: Effect.Effect<A, PlatformError, R>,
  identity: OperationIdentity,
  journal: ObservationJournal<BeginError, BeginRequirements, SettleError, SettleRequirements>,
): Effect.Effect<A, PlatformError | BeginError, R | BeginRequirements | SettleRequirements> =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const startedAt = yield* DateTime.now;

      return yield* journal.begin(identity, startedAt);
    }),
    () => call,
    (id, exit) => settle(exit, identity, (observation) => journal.finish(id, observation)),
  );

/** Build the Search service from the exact Client whose project is journaled. */
export const observeSearch = Effect.fn("observeSearch")(function* <
  BeginError,
  BeginRequirements,
  FinishError,
  FinishRequirements,
>(
  query: SearchQuery,
  journal: ObservationJournal<BeginError, BeginRequirements, FinishError, FinishRequirements>,
): Effect.fn.Return<
  SearchResults,
  PlatformError | BeginError,
  BrowserbaseClient | BeginRequirements | FinishRequirements
> {
  const client = yield* BrowserbaseClient;

  const searchCall = Effect.gen(function* () {
    return yield* (yield* BrowserbaseSearch).web(query);
  }).pipe(
    Effect.provide(
      BrowserbaseSearch.layer.pipe(Layer.provide(Layer.succeed(BrowserbaseClient, client))),
    ),
  );

  return yield* observePlatformAttempt(
    searchCall,
    { projectId: client.projectId, operation: "search-web" },
    journal,
  );
});

const fetchIdentity = (projectId: string, request: PageFetchRequest): OperationIdentity => ({
  projectId,
  operation: "fetch",
  // These are requested, bounded flags. The URL and extraction schema never enter the journal.
  ...(request?.format === "raw" || request?.format === "json" || request?.format === "markdown"
    ? { requestedFormat: request.format }
    : {}),
  ...(typeof request?.proxies === "boolean" ? { requestedProxies: request.proxies } : {}),
});

/** Fetch's target-site status is unrelated to the Browserbase API-call outcome. */
export const observePageFetch = Effect.fn("observePageFetch")(function* <
  BeginError,
  BeginRequirements,
  FinishError,
  FinishRequirements,
>(
  request: PageFetchRequest,
  journal: ObservationJournal<BeginError, BeginRequirements, FinishError, FinishRequirements>,
): Effect.fn.Return<
  PageFetchResult,
  PlatformError | BeginError,
  BrowserbaseClient | BeginRequirements | FinishRequirements
> {
  const client = yield* BrowserbaseClient;

  const fetchCall = Effect.gen(function* () {
    return yield* (yield* BrowserbasePageFetch).fetch(request);
  }).pipe(
    Effect.provide(
      BrowserbasePageFetch.layer.pipe(Layer.provide(Layer.succeed(BrowserbaseClient, client))),
    ),
  );

  return yield* observePlatformAttempt(
    fetchCall,
    fetchIdentity(client.projectId, request),
    journal,
  );
});

/** A successful run creation is an API reply, not completion or inference cost. */
export const observeAgentRun = Effect.fn("observeAgentRun")(function* <
  BeginError,
  BeginRequirements,
  FinishError,
  FinishRequirements,
>(
  request: AgentRunRequest,
  journal: ObservationJournal<BeginError, BeginRequirements, FinishError, FinishRequirements>,
): Effect.fn.Return<
  AgentRun,
  PlatformError | BeginError,
  BrowserbaseClient | BeginRequirements | FinishRequirements
> {
  const client = yield* BrowserbaseClient;

  const agentCall = Effect.gen(function* () {
    return yield* (yield* BrowserbaseAgents).run(request);
  }).pipe(
    Effect.provide(
      BrowserbaseAgents.layer.pipe(Layer.provide(Layer.succeed(BrowserbaseClient, client))),
    ),
  );

  return yield* observePlatformAttempt(
    agentCall,
    { projectId: client.projectId, operation: "agent-run" },
    journal,
  );
});

export const AllowanceMeter = Schema.Literals([
  "browser-minutes",
  "proxy-bytes",
  "search-calls",
  "fetch-calls",
  "extract-calls",
  "agent-calls",
]);

export const AllowanceUnit = Schema.Literals(["minutes", "bytes", "calls"]);

/** Imported billing dates must say which UTC offset the source intended. */
const ZonedUtcDateTime = Schema.String.check(Schema.isPattern(/(?:Z|[+-][0-9]{2}:[0-9]{2})$/)).pipe(
  Schema.decodeTo(Schema.DateTimeUtcFromString),
);

/** Caller-supplied plan policy, decoded before assessment. */
export const Allowance = Schema.Struct({
  accountOrPlanScope: Schema.NonEmptyString,
  meter: AllowanceMeter,
  unit: AllowanceUnit,
  /** Start inclusive, end exclusive. The host obtains these dates from its plan. */
  periodStart: ZonedUtcDateTime,
  periodEnd: ZonedUtcDateTime,
  includedQuantity: Schema.Natural,
  alertAtConsumedQuantity: Schema.Natural,
  /** Maximum acceptable delay between measurement and assessment for an open period. */
  maxToDateLagMillis: Schema.Natural,
});

export type Allowance = typeof Allowance.Type;

/** Shape validation only; the host must verify that account billing issued the record. */
export const ProviderPeriodConsumption = Schema.Struct({
  source: Schema.Literal("provider-billing"),
  accountOrPlanScope: Schema.NonEmptyString,
  meter: AllowanceMeter,
  unit: AllowanceUnit,
  periodStart: ZonedUtcDateTime,
  periodEnd: ZonedUtcDateTime,
  /** Quantity accumulated in the half-open [periodStart, measuredThrough) window. */
  consumedQuantity: Schema.Natural,
  measuredThrough: ZonedUtcDateTime,
  receivedAt: ZonedUtcDateTime,
  status: Schema.Literals(["to-date", "final"]),
});

export type ProviderPeriodConsumption = typeof ProviderPeriodConsumption.Type;

export type AllowanceAssessment =
  | {
      readonly _tag: "Unknown";
      readonly reason:
        | "invalid-allowance"
        | "period-not-started"
        | "missing-provider-total"
        | "scope-or-unit-mismatch"
        | "period-mismatch"
        | "invalid-provider-total"
        | "unverified-provider-total"
        | "verification-timeout"
        | "stale-provider-total"
        | "period-not-final";
    }
  | {
      readonly _tag: "Known";
      readonly source: "provider-billing";
      readonly assessedAt: DateTime.Utc;
      readonly measuredThrough: DateTime.Utc;
      readonly status: ProviderPeriodConsumption["status"];
      readonly consumedQuantity: number;
      readonly remainingIncluded: number;
      readonly overIncluded: number;
      readonly alert: boolean;
    };

/**
 * Decode imported billing data at the host boundary before calling this function. The
 * host-provided verifier must check provenance against its trusted billing source;
 * a `source` field or a successful Schema decode alone is not an attestation.
 */
export const assessAllowance = Effect.fn("assessAllowance")(function* <
  VerifyError,
  VerifyRequirements,
>(
  allowanceRecord: unknown,
  providerBillingRecord: unknown,
  verifyBillingRecord: (
    record: ProviderPeriodConsumption,
  ) => Effect.Effect<boolean, VerifyError, VerifyRequirements>,
): Effect.fn.Return<AllowanceAssessment, VerifyError, VerifyRequirements> {
  const decodedAllowance = Schema.decodeUnknownOption(Allowance)(allowanceRecord);

  if (Option.isNone(decodedAllowance)) return { _tag: "Unknown", reason: "invalid-allowance" };

  const allowance = decodedAllowance.value;

  if (
    !DateTime.isLessThan(allowance.periodStart, allowance.periodEnd) ||
    allowance.alertAtConsumedQuantity > allowance.includedQuantity ||
    allowance.unit !== unitForMeter(allowance.meter)
  )
    return { _tag: "Unknown", reason: "invalid-allowance" };

  if (providerBillingRecord === undefined)
    return { _tag: "Unknown", reason: "missing-provider-total" };

  if (!Schema.is(ProviderPeriodConsumption)(providerBillingRecord))
    return { _tag: "Unknown", reason: "invalid-provider-total" };

  const total = providerBillingRecord;

  const verified = yield* verifyBillingRecord(total).pipe(Effect.timeoutOption("5 seconds"));

  if (Option.isNone(verified)) return { _tag: "Unknown", reason: "verification-timeout" };

  if (!verified.value) return { _tag: "Unknown", reason: "unverified-provider-total" };

  const assessedAt = yield* DateTime.now;

  if (DateTime.isLessThan(assessedAt, allowance.periodStart))
    return { _tag: "Unknown", reason: "period-not-started" };

  if (
    total.accountOrPlanScope !== allowance.accountOrPlanScope ||
    total.meter !== allowance.meter ||
    total.unit !== allowance.unit
  )
    return { _tag: "Unknown", reason: "scope-or-unit-mismatch" };

  if (
    DateTime.toEpochMillis(total.periodStart) !== DateTime.toEpochMillis(allowance.periodStart) ||
    DateTime.toEpochMillis(total.periodEnd) !== DateTime.toEpochMillis(allowance.periodEnd)
  )
    return { _tag: "Unknown", reason: "period-mismatch" };

  const start = DateTime.toEpochMillis(allowance.periodStart);
  const end = DateTime.toEpochMillis(allowance.periodEnd);
  const assessedAtMillis = DateTime.toEpochMillis(assessedAt);
  const measuredThrough = DateTime.toEpochMillis(total.measuredThrough);
  const receivedAt = DateTime.toEpochMillis(total.receivedAt);

  if (
    receivedAt < measuredThrough ||
    receivedAt > assessedAtMillis ||
    measuredThrough < start ||
    measuredThrough > assessedAtMillis
  )
    return { _tag: "Unknown", reason: "invalid-provider-total" };

  if (total.status === "to-date") {
    if (assessedAtMillis >= end) return { _tag: "Unknown", reason: "period-not-final" };

    if (measuredThrough >= end) return { _tag: "Unknown", reason: "invalid-provider-total" };

    if (assessedAtMillis - measuredThrough > allowance.maxToDateLagMillis)
      return { _tag: "Unknown", reason: "stale-provider-total" };
  } else if (total.status === "final") {
    if (measuredThrough !== end || assessedAtMillis < end)
      return { _tag: "Unknown", reason: "period-not-final" };
  }

  return {
    _tag: "Known",
    source: "provider-billing",
    assessedAt,
    measuredThrough: total.measuredThrough,
    status: total.status,
    consumedQuantity: total.consumedQuantity,
    remainingIncluded: Math.max(0, allowance.includedQuantity - total.consumedQuantity),
    overIncluded: Math.max(0, total.consumedQuantity - allowance.includedQuantity),
    alert: total.consumedQuantity >= allowance.alertAtConsumedQuantity,
  };
});

const unitForMeter = (meter: Allowance["meter"]): Allowance["unit"] => {
  switch (meter) {
    case "browser-minutes":
      return "minutes";
    case "proxy-bytes":
      return "bytes";
    case "search-calls":
    case "fetch-calls":
    case "extract-calls":
    case "agent-calls":
      return "calls";
  }
};
