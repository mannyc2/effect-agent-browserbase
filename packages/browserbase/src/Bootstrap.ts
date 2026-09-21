import { Schema } from "effect";

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

/**
 * One ordered bundle plus its host capabilities. Order across separate native registrations is
 * not assumed, so dependent steps share a single bundle in the order they were combined.
 */
export const Plan = Schema.Struct({
  scripts: Schema.Array(InitScript).check(Schema.isMaxLength(16)),
  permissions: Schema.Array(PermissionGrant).check(Schema.isMaxLength(16)),
});

export type Plan = typeof Plan.Type;

export const empty: Plan = { scripts: [], permissions: [] };

export const init = (script: InitScript): Plan => ({ scripts: [script], permissions: [] });

export const permissions = (grant: PermissionGrant): Plan => ({
  scripts: [],
  permissions: [grant],
});

/** Combination is ordered: an earlier plan's steps run before a later plan's. */
export const combine = (...plans: ReadonlyArray<Plan>): Plan => ({
  scripts: plans.flatMap((plan) => [...plan.scripts]),
  permissions: plans.flatMap((plan) => [...plan.permissions]),
});

/** What the current document is, not a promise about any other document. */
export type ReadinessOutcome =
  | { readonly _tag: "Ready" }
  | { readonly _tag: "NotApplicable" }
  | { readonly _tag: "RequiresNavigation" };
