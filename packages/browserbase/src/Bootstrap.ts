import { type Cause, type Effect, Schema } from "effect";

import type { InitializationError } from "./Errors.ts";
import * as Registration from "./internal/browser/BindingRegistration.ts";
import { Identifier } from "./References.ts";

/**
 * Exact scheme-and-host origin, as a document reports it. Patterns are deliberately absent:
 * a registration that cannot say exactly where it applies does not belong in a plan.
 */
export const Origin = Registration.Origin;

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
export const BindingFailureMode = Registration.FailureMode;

export type BindingFailureMode = typeof BindingFailureMode.Type;

/**
 * A registration issued by `binding`. Its private executable closure carries the real consumer
 * E/R; copying the metadata or fabricating an object does not grant callback authority.
 */
export type BindingRegistration<E = never, R = never> = Registration.Registration<E, R>;

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

/**
 * One ordered bundle plus its host capabilities. Callback registrations preserve E/R through
 * their executable closures; static script/permission plans remain serializable values.
 */
export interface Plan<E = unknown, R = unknown> {
  readonly scripts: ReadonlyArray<InitScript>;
  readonly permissions: ReadonlyArray<PermissionGrant>;
  readonly bindings?: ReadonlyArray<BindingRegistration<E, R>>;
}

/** Host-only typed evidence. Causes are never logged or returned to page callers. */
export interface BindingFailure<E> {
  readonly name: string;
  readonly mode: BindingFailureMode;
  readonly cause: Cause.Cause<E | InitializationError>;
}

export interface BindingStatistics {
  readonly name: string;
  readonly inFlight: number;
  readonly pendingNative: number;
  /** Finished/interrupted invocations whose native work or disposal has not settled. */
  readonly retired: number;
  readonly accepted: number;
  readonly succeeded: number;
  readonly rejected: number;
}

/** Copied snapshot: at most sixteen bindings and the latest thirty-two failure records. */
export interface BindingDiagnostics<E> {
  readonly faulted: boolean;
  readonly bindings: ReadonlyArray<BindingStatistics>;
  readonly failures: ReadonlyArray<BindingFailure<E>>;
  readonly droppedFailures: number;
}

/**
 * Static plans remain serializable. Live binding plans retain issued registrations by identity;
 * this schema neither executes their callbacks nor turns copied metadata into authority. Typed
 * acquisition validates a separate snapshot so consumer E/R is not erased by a generic decoder.
 */
export const Plan = Schema.Struct({
  scripts: Schema.Array(InitScript).check(Schema.isMaxLength(16)),
  permissions: Schema.Array(PermissionGrant).check(Schema.isMaxLength(16)),
  bindings: Schema.optionalKey(Schema.Array(Registration.schema).check(Schema.isMaxLength(16))),
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
): Plan<E, R> => ({
  scripts: [],
  permissions: [],
  bindings: [Registration.make(options)],
});

/** Combination is ordered and preserves every callback's consumer E/R union. */
export function combine<const Plans extends ReadonlyArray<AnyPlan>>(
  ...plans: Plans
): Plan<PlanError<Plans[number]>, PlanRequirements<Plans[number]>>;

export function combine(...plans: ReadonlyArray<AnyPlan>): AnyPlan {
  const bindings = plans.flatMap((plan) => (plan.bindings === undefined ? [] : [...plan.bindings]));

  return {
    scripts: plans.flatMap((plan) => [...plan.scripts]),
    permissions: plans.flatMap((plan) => [...plan.permissions]),
    ...(bindings.length === 0 ? {} : { bindings }),
  };
}

/** What the current document is, not a promise about any other document. */
export type ReadinessOutcome =
  | { readonly _tag: "Ready" }
  | { readonly _tag: "NotApplicable" }
  | { readonly _tag: "RequiresNavigation" };
