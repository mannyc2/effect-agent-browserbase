import { type Effect, Schema } from "effect";

import { Identifier } from "./References.ts";

/**
 * Exact scheme-and-host origin, as a document reports it. Patterns are deliberately absent:
 * a registration that cannot say exactly where it applies does not belong in a plan.
 */
export const Origin = Schema.NonEmptyString.check(
  Schema.isMaxLength(2048),
  Schema.makeFilter(
    (value) => {
      try {
        const url = new URL(value);

        return (
          ["http:", "https:"].includes(url.protocol) &&
          url.origin === value &&
          !url.username &&
          !url.password
        );
      } catch {
        return false;
      }
    },
    { title: "an exact http(s) origin" },
  ),
);

export type Origin = typeof Origin.Type;

/**
 * The reviewed subset of native permission capabilities. Each name is checked against a real
 * browser in native acceptance; an unsupported capability is refused before it is exposed.
 */
export const Permission = Schema.Literals([
  "accelerometer",
  "background-sync",
  "camera",
  "clipboard-read",
  "clipboard-write",
  "geolocation",
  "gyroscope",
  "magnetometer",
  "microphone",
  "midi",
  "notifications",
  "payment-handler",
  "storage-access",
]);

export type Permission = typeof Permission.Type;

export const PermissionGrant = Schema.Struct({
  origin: Origin,
  permissions: Schema.Array(Permission).check(Schema.isMaxLength(16), Schema.isUnique()),
});

export type PermissionGrant = typeof PermissionGrant.Type;

/**
 * Registration is not readiness. A script may start asynchronous work, but it cannot pause the
 * website's own scripts, so a document is ready only when its expression resolves to exactly
 * `true`. A document that was already running when the bundle was registered never ran it:
 * `RequireFreshNavigation` reports that instead of pretending otherwise, and an explicit
 * reload of possibly uncertain work stays a caller's decision.
 */
export const Readiness = Schema.Struct({
  expression: Schema.NonEmptyString.check(Schema.isMaxLength(4096)),
  timeoutMillis: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 120_000 })),
  existingDocuments: Schema.Literals(["RequireFreshNavigation", "AcceptAlreadyRunning"]),
});

export type Readiness = typeof Readiness.Type;

/** Trusted host configuration. Script content is never model output or page input. */
export const InitScript = Schema.Struct({
  id: Identifier,
  content: Schema.NonEmptyString.check(Schema.isMaxLength(64 * 1024)),
  /** When present, the step runs only on these documents and readiness skips the rest. */
  origins: Schema.optionalKey(
    Schema.Array(Origin).check(Schema.isMaxLength(16), Schema.isUnique()),
  ),
  readiness: Schema.optionalKey(Readiness),
});

export type InitScript = typeof InitScript.Type;

/** A callback failure can reject one page invocation or permanently fence the session. */
export const BindingFailureMode = Schema.Literals(["reject-call", "fail-session"]);

export type BindingFailureMode = typeof BindingFailureMode.Type;

const BindingMetadata = Schema.Struct({
  name: Identifier,
  origins: Schema.Array(Origin).check(
    Schema.isMaxLength(16),
    Schema.isUnique(),
    Schema.makeFilter((origins) => origins.length > 0, { title: "at least one allowed origin" }),
  ),
  maxConcurrent: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 64 })),
  maxInputBytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1024 * 1024 })),
  maxOutputBytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 * 1024 * 1024 })),
  timeoutMillis: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 120_000 })),
  failureMode: BindingFailureMode,
});

/**
 * Trusted callback registration retained by a Plan. The codecs and handler deliberately stay
 * opaque at this level: the native registration boundary is responsible for decoding, running,
 * rechecking document authority and projecting only page-safe replies.
 */
export interface BindingRegistration {
  readonly name: string;
  readonly origins: ReadonlyArray<Origin>;
  readonly maxConcurrent: number;
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  readonly timeoutMillis: number;
  readonly failureMode: BindingFailureMode;
  readonly input: unknown;
  readonly output: unknown;
  readonly handle: unknown;
}

/**
 * Environment-free boundary codecs keep page data validation separate from consumer services.
 * The handler's E/R remain visible on the Plan and are supplied only by the trusted host.
 */
export interface BindingOptions<I, IEncoded, O, OEncoded, E, R> {
  readonly name: string;
  readonly origins: ReadonlyArray<Origin>;
  readonly input: Schema.ConstraintCodec<I, IEncoded, never, never>;
  readonly output: Schema.ConstraintCodec<O, OEncoded, never, never>;
  readonly maxConcurrent: number;
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  readonly timeoutMillis: number;
  readonly failureMode: BindingFailureMode;
  readonly handle: (input: I) => Effect.Effect<O, E, R>;
}

declare const PlanType: unique symbol;

/**
 * One ordered bundle plus its host capabilities. E/R are phantom host types carried by callback
 * registrations; static script/permission plans remain ordinary serializable values.
 */
export interface Plan<E = unknown, R = unknown> {
  readonly scripts: ReadonlyArray<InitScript>;
  readonly permissions: ReadonlyArray<PermissionGrant>;
  readonly bindings?: ReadonlyArray<BindingRegistration>;
  readonly [PlanType]?: { readonly error: E; readonly requirements: R };
}

/**
 * Serializable portion of a plan. Bindings retain trusted host codecs and closures and therefore
 * are validated by their builder/native boundary rather than encoded as configuration data.
 */
export const Plan = Schema.Struct({
  scripts: Schema.Array(InitScript).check(Schema.isMaxLength(16)),
  permissions: Schema.Array(PermissionGrant).check(Schema.isMaxLength(16)),
});

type AnyPlan = Plan<unknown, unknown>;

export type PlanError<P extends AnyPlan> = P extends Plan<infer E, infer _R> ? E : never;
export type PlanRequirements<P extends AnyPlan> = P extends Plan<infer _E, infer R> ? R : never;

export const empty: Plan<never, never> = { scripts: [], permissions: [] };

export const init = (script: InitScript): Plan<never, never> => ({
  scripts: [script],
  permissions: [],
});

export const permissions = (grant: PermissionGrant): Plan<never, never> => ({
  scripts: [],
  permissions: [grant],
});

/**
 * Register a page-callable host callback without running it or capturing an ambient runtime.
 * Native installation later owns origin/document checks, bounded admission and disposal.
 */
export const binding = <I, IEncoded, O, OEncoded, E, R>(
  options: BindingOptions<I, IEncoded, O, OEncoded, E, R>,
): Plan<E, R> => {
  const metadata = Schema.decodeUnknownSync(BindingMetadata)({
    name: options.name,
    origins: options.origins,
    maxConcurrent: options.maxConcurrent,
    maxInputBytes: options.maxInputBytes,
    maxOutputBytes: options.maxOutputBytes,
    timeoutMillis: options.timeoutMillis,
    failureMode: options.failureMode,
  });

  return {
    scripts: [],
    permissions: [],
    bindings: [
      {
        ...metadata,
        origins: [...metadata.origins],
        input: options.input,
        output: options.output,
        handle: options.handle,
      },
    ],
  };
};

/** Combination is ordered and preserves every callback's consumer E/R union. */
export const combine = <const Plans extends ReadonlyArray<AnyPlan>>(
  ...plans: Plans
): Plan<PlanError<Plans[number]>, PlanRequirements<Plans[number]>> => {
  const bindings = plans.flatMap((plan) =>
    plan.bindings === undefined ? [] : [...plan.bindings],
  );

  return {
    scripts: plans.flatMap((plan) => [...plan.scripts]),
    permissions: plans.flatMap((plan) => [...plan.permissions]),
    ...(bindings.length === 0 ? {} : { bindings }),
  };
};

/** What the current document is, not a promise about any other document. */
export type ReadinessOutcome =
  | { readonly _tag: "Ready" }
  | { readonly _tag: "NotApplicable" }
  | { readonly _tag: "RequiresNavigation" };
