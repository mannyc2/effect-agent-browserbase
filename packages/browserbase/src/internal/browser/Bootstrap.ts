import type { Plan } from "../../Bootstrap.ts";

export interface ReadinessRequirement {
  readonly step: string;
  readonly expression: string;
  readonly timeoutMillis: number;
  readonly origins?: ReadonlyArray<string>;
}

/** What the native driver installs: one ordered bundle, its capabilities and its gates. */
export interface CompiledBootstrap {
  readonly bundle?: string;
  readonly permissions: ReadonlyArray<{
    readonly origin: string;
    readonly permissions: ReadonlyArray<string>;
  }>;
  readonly readiness: ReadonlyArray<ReadinessRequirement>;
  readonly existingDocuments: "RequireFreshNavigation" | "AcceptAlreadyRunning";
}

const guarded = (content: string, origins: ReadonlyArray<string> | undefined): string =>
  origins === undefined
    ? `(() => {\n${content}\n})();`
    : `(() => {\nconst origins = ${JSON.stringify([...origins])};\nif (!origins.includes(globalThis.location && globalThis.location.origin)) return;\n${content}\n})();`;

/**
 * Dependent steps become one script in declared order: a failing step stops the ones after it
 * rather than letting a later step observe half-initialized state. Origin-excluded steps are
 * skipped inside the document that reports the origin, never by guessing from a navigation URL.
 */
export const compileBootstrap = (plan: Plan): CompiledBootstrap | undefined => {
  if (plan.scripts.length === 0 && plan.permissions.length === 0) return undefined;

  const bundle =
    plan.scripts.length === 0
      ? undefined
      : plan.scripts.map((script) => guarded(script.content, script.origins)).join("\n");

  const readiness = plan.scripts.flatMap((script) =>
    script.readiness === undefined
      ? []
      : [
          {
            step: script.id,
            expression: script.readiness.expression,
            timeoutMillis: script.readiness.timeoutMillis,
            ...(script.origins === undefined ? {} : { origins: script.origins }),
          },
        ],
  );

  // The most conservative declared policy governs the whole plan: one document is either
  // admitted for dependent work or it is not, and steps cannot disagree about that.
  const existingDocuments = plan.scripts.some(
    (script) => script.readiness?.existingDocuments === "RequireFreshNavigation",
  )
    ? "RequireFreshNavigation"
    : "AcceptAlreadyRunning";

  return {
    ...(bundle === undefined ? {} : { bundle }),
    permissions: plan.permissions.map((grant) => ({
      origin: grant.origin,
      permissions: [...grant.permissions],
    })),
    readiness,
    existingDocuments,
  };
};

/** Duplicate step identity would make registration order and readiness reports ambiguous. */
export const duplicateStep = (plan: Plan): boolean =>
  new Set(plan.scripts.map((script) => script.id)).size !== plan.scripts.length ||
  new Set(plan.permissions.map((grant) => grant.origin)).size !== plan.permissions.length;
