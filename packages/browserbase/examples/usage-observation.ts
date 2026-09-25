import { Cause, DateTime, Effect, Exit, Option, Schema } from "effect";
import { BrowserbaseClient } from "effect-browserbase/client";
import type { PlatformError, ProjectError } from "effect-browserbase/errors";
import type { PageFetchRequest } from "effect-browserbase/page-fetch";
import { BrowserbaseProjects, ProjectUsage } from "effect-browserbase/projects";
import { Identifier } from "effect-browserbase/references";

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

export type ObservedUsageChange =
  | {
      readonly _tag: "Unknown";
      readonly reason: "different-project" | "out-of-order" | "counter-decreased";
    }
  | {
      readonly _tag: "Observed";
      readonly source: "host-observed";
      readonly from: DateTime.Utc;
      readonly to: DateTime.Utc;
      readonly browserMinutes: number;
      readonly proxyBytes: number;
      readonly alert: boolean;
    };

/**
 * The change between two samples of the same project, against a threshold the owner sets.
 * It is not a billing-period total: the API reports neither its period nor its reset, so
 * a counter that went down makes the window `Unknown` rather than a negative change.
 */
export const observedUsageChange = (
  earlier: ProjectUsageObservation,
  later: ProjectUsageObservation,
  alertAtBrowserMinutes: number,
): ObservedUsageChange => {
  if (earlier.usage.projectId !== later.usage.projectId)
    return { _tag: "Unknown", reason: "different-project" };

  if (DateTime.isLessThan(later.observedAt, earlier.observedAt))
    return { _tag: "Unknown", reason: "out-of-order" };

  const browserMinutes = later.usage.browserMinutes - earlier.usage.browserMinutes;
  const proxyBytes = later.usage.proxyBytes - earlier.usage.proxyBytes;

  if (browserMinutes < 0 || proxyBytes < 0) return { _tag: "Unknown", reason: "counter-decreased" };

  return {
    _tag: "Observed",
    source: "host-observed",
    from: earlier.observedAt,
    to: later.observedAt,
    browserMinutes,
    proxyBytes,
    alert: browserMinutes >= alertAtBrowserMinutes,
  };
};

export const LocalOperation = Schema.Literals(["search-web", "fetch", "agent-run"]);
export type LocalOperation = typeof LocalOperation.Type;

/**
 * `api-reply` rather than the issue's `confirmed`: a decoded reply confirms the reply, not a
 * billed call, and the stored word should not suggest otherwise.
 */
export const LocalOutcome = Schema.Literals(["api-reply", "undispatched", "rejected", "unknown"]);
export type LocalOutcome = typeof LocalOutcome.Type;

export const RequestedFormat = Schema.Literals(["raw", "json", "markdown"]);
export type RequestedFormat = typeof RequestedFormat.Type;

/** Only Fetch has requested flags; the union keeps stored records to the shapes a call has. */
export const ObservedOperation = Schema.Union([
  Schema.Struct({ operation: Schema.Literals(["search-web", "agent-run"]) }),
  Schema.Struct({
    operation: Schema.Literal("fetch"),
    requestedFormat: Schema.optionalKey(RequestedFormat),
    requestedProxies: Schema.optionalKey(Schema.Boolean),
  }),
]);

export type ObservedOperation = typeof ObservedOperation.Type;

/** An API reply or failure is an activity fact, never a billed-call receipt. */
export class LocalOperationObservation extends Schema.Class<LocalOperationObservation>(
  "LocalOperationObservation",
)({
  source: Schema.Literal("host-observed"),
  projectId: Identifier,
  attempt: ObservedOperation,
  observedAt: Schema.DateTimeUtcFromString,
  outcome: LocalOutcome,
}) {}

/** The requested, bounded flags. The URL and extraction schema never enter the journal. */
export const fetchOperation = (request: PageFetchRequest): ObservedOperation => ({
  operation: "fetch",
  ...(request.format === undefined ? {} : { requestedFormat: request.format }),
  ...(request.proxies === undefined ? {} : { requestedProxies: request.proxies }),
});

const serviceOf = { "search-web": "search", fetch: "fetch", "agent-run": "agents" } as const;

const classify = <A>(
  exit: Exit.Exit<A, PlatformError>,
  operation: LocalOperation,
): LocalOutcome => {
  if (Exit.isSuccess(exit)) return "api-reply";

  const reasons = exit.cause.reasons;
  const only = reasons[0];

  // A first typed error does not explain a mixed failure, defect or interruption.
  if (reasons.length !== 1 || only === undefined || !Cause.isFailReason(only)) return "unknown";

  // `observe` accepts any PlatformError Effect, so a host's composed call can fail in a
  // different operation, such as a preceding read. That outcome says nothing about this POST.
  return only.error.operation === operation && only.error.service === serviceOf[operation]
    ? (only.error.outcome ?? "unknown")
    : "unknown";
};

const settle = Effect.fnUntraced(
  function* <A, FinishError, FinishRequirements>(
    exit: Exit.Exit<A, PlatformError>,
    projectId: string,
    attempt: ObservedOperation,
    write: (
      observation: LocalOperationObservation,
    ) => Effect.Effect<void, FinishError, FinishRequirements>,
  ) {
    const observedAt = yield* DateTime.now;

    yield* write(
      LocalOperationObservation.make({
        source: "host-observed",
        projectId,
        attempt,
        observedAt,
        outcome: classify(exit, attempt.operation),
      }),
    );
  },
  // Release finalizers are masked. The race bounds a cooperative sink only.
  Effect.timeoutOption("2 seconds"),
  Effect.matchCauseEffect({
    onFailure: () => Effect.logWarning("usage observation failed"),
    onSuccess: (result) =>
      Option.isNone(result) ? Effect.logWarning("usage observation timed out") : Effect.void,
  }),
);

/** The host implements this port with an actual durable store and unique intent ids. */
export interface ObservationJournal<
  BeginError,
  BeginRequirements,
  FinishError,
  FinishRequirements,
> {
  readonly begin: (
    projectId: string,
    attempt: ObservedOperation,
    startedAt: DateTime.Utc,
  ) => Effect.Effect<string, BeginError, BeginRequirements>;
  readonly finish: (
    id: string,
    observation: LocalOperationObservation,
  ) => Effect.Effect<void, FinishError, FinishRequirements>;
}

/**
 * Wraps the host's own Search, Fetch or Agent-run Effect, for example `search.web(query)`.
 * A committed intent with a host Clock start time precedes the POST. `finish` must be
 * idempotent. Unsettled ids remain unknown after a crash; never replay the POST.
 */
export const observe = <BeginError, BeginRequirements, FinishError, FinishRequirements>(
  attempt: ObservedOperation,
  journal: ObservationJournal<BeginError, BeginRequirements, FinishError, FinishRequirements>,
) =>
  Effect.fn("observe")(function* <A, R>(
    call: Effect.Effect<A, PlatformError, R>,
  ): Effect.fn.Return<
    A,
    PlatformError | BeginError | Cause.TimeoutError,
    R | BrowserbaseClient | BeginRequirements | FinishRequirements
  > {
    const { projectId } = yield* BrowserbaseClient;

    return yield* Effect.acquireUseRelease(
      // Acquire is uninterruptible, but the timeout's racers are not. A write that lands
      // after the deadline leaves an unsettled intent, which already reads as unknown.
      Effect.flatMap(DateTime.now, (startedAt) =>
        journal.begin(projectId, attempt, startedAt).pipe(Effect.timeout("2 seconds")),
      ),
      () => call,
      (id, exit) =>
        settle(exit, projectId, attempt, (observation) => journal.finish(id, observation)),
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

const unitForMeter = {
  "browser-minutes": "minutes",
  "proxy-bytes": "bytes",
  "search-calls": "calls",
  "fetch-calls": "calls",
  "extract-calls": "calls",
  "agent-calls": "calls",
} as const;

/** Imported billing dates must say which UTC offset the source intended. */
const ZonedUtcDateTime = Schema.String.check(Schema.isPattern(/(?:Z|[+-][0-9]{2}:[0-9]{2})$/)).pipe(
  Schema.decodeTo(Schema.DateTimeUtcFromString),
);

/** Start inclusive, end exclusive. */
export const BillingPeriod = Schema.Struct({
  start: ZonedUtcDateTime,
  end: ZonedUtcDateTime,
}).check(
  Schema.makeFilter(({ start, end }) =>
    DateTime.isLessThan(start, end) ? true : "the period must end after it starts",
  ),
);

export type BillingPeriod = typeof BillingPeriod.Type;

const scopeFields = {
  accountOrPlanScope: Schema.NonEmptyString,
  meter: AllowanceMeter,
  unit: AllowanceUnit,
};

const unitMatchesMeter = Schema.makeFilter(
  ({ meter, unit }: { readonly meter: keyof typeof unitForMeter; readonly unit: string }) =>
    unit === unitForMeter[meter] ? true : `${meter} is counted in ${unitForMeter[meter]}`,
);

/**
 * Caller-supplied plan policy, decoded at the host boundary so that a configuration
 * mistake is a decode failure rather than an `Unknown`. An omitted period is one the
 * host does not know.
 */
export const Allowance = Schema.Struct({
  ...scopeFields,
  period: Schema.optionalKey(BillingPeriod),
  includedQuantity: Schema.Natural,
  alertAtConsumedQuantity: Schema.Natural,
}).check(unitMatchesMeter);

export type Allowance = typeof Allowance.Type;

/** A provider total the host obtained and verified through its own billing channel. */
export const ProviderPeriodConsumption = Schema.Struct({
  source: Schema.Literal("provider-billing"),
  ...scopeFields,
  period: BillingPeriod,
  consumedQuantity: Schema.Natural,
}).check(unitMatchesMeter);

export type ProviderPeriodConsumption = typeof ProviderPeriodConsumption.Type;

export type AllowanceAssessment =
  | {
      readonly _tag: "Unknown";
      readonly reason: "unknown-period" | "missing-provider-total" | "mismatched-provider-total";
    }
  | {
      readonly _tag: "Known";
      readonly source: "provider-billing";
      readonly consumedQuantity: number;
      readonly remainingIncluded: number;
      readonly overIncluded: number;
      readonly alert: boolean;
    };

const samePeriod = (left: BillingPeriod, right: BillingPeriod) =>
  DateTime.Equivalence(left.start, right.start) && DateTime.Equivalence(left.end, right.end);

/** No documented Browserbase API supplies the total, so this is `Unknown` unless the host has one. */
export const assessAllowance = (
  allowance: Allowance,
  total?: ProviderPeriodConsumption,
): AllowanceAssessment => {
  if (allowance.period === undefined) return { _tag: "Unknown", reason: "unknown-period" };

  if (total === undefined) return { _tag: "Unknown", reason: "missing-provider-total" };

  if (
    total.accountOrPlanScope !== allowance.accountOrPlanScope ||
    total.meter !== allowance.meter ||
    total.unit !== allowance.unit ||
    !samePeriod(total.period, allowance.period)
  )
    return { _tag: "Unknown", reason: "mismatched-provider-total" };

  return {
    _tag: "Known",
    source: "provider-billing",
    consumedQuantity: total.consumedQuantity,
    remainingIncluded: Math.max(0, allowance.includedQuantity - total.consumedQuantity),
    overIncluded: Math.max(0, total.consumedQuantity - allowance.includedQuantity),
    alert: total.consumedQuantity >= allowance.alertAtConsumedQuantity,
  };
};
