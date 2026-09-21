import { resolve } from "node:path";
// The one gate every guarded hosted check passes through. A check declares itself in
// `checks.ts`; this module refuses to start it without the operator's explicit opt-in and the
// credentials that entry names, derives every budget from that entry, and emits one JSON line
// per phase. No check reads the environment, builds an account or opens a session on its own.
import { createInterface } from "node:readline/promises";

import * as Account from "@effect-agent/browserbase/account";
import {
  BrowserbaseBrowser,
  type BrowserOptions,
  type OpenOptions,
} from "@effect-agent/browserbase/browser";
import { BrowserPolicy } from "@effect-agent/browserbase/browser-data";
import { Effect, Redacted } from "effect";

import { ceiling, checks, type CheckName } from "./checks.ts";

const refuse = (message: string): never => {
  throw new Error(message);
};

/**
 * A trusted operator supplies exact approved delivery origins before allocation. Never derive
 * this allowlist from untrusted page data or a newly returned URL.
 */
const approvedOrigins = (configured: string): ReadonlyArray<string> => {
  const origins = configured.split(",").map((origin) => origin.trim());

  if (
    origins.length > 32 ||
    origins.some((origin) => {
      try {
        const url = new URL(origin);

        return (
          url.protocol !== "https:" || url.origin !== origin || !!url.username || !!url.password
        );
      } catch {
        return true;
      }
    })
  ) {
    refuse("BROWSERBASE_ARTIFACT_ORIGINS must contain exact approved HTTPS origins");
  }

  return origins;
};

export const hostedCase = (name: CheckName) => {
  const check = checks[name];
  const { budget } = check;
  const env = process.env;

  if (env.EFFECT_AGENT_BROWSERBASE_LIVE !== "1") {
    refuse("Refusing hosted Browserbase allocation without EFFECT_AGENT_BROWSERBASE_LIVE=1");
  }

  const missing = ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", ...check.env].filter(
    (key) => !env[key],
  );

  if (missing.length > 0) refuse(`The ${name} check requires ${missing.join(", ")}`);
  const setting = (key: string): string => env[key] || refuse(`The ${name} check requires ${key}`);

  // A Live View URL grants control of the browser, so it is shown only to a person at a
  // terminal and never written to a log that an Actions artifact would retain.
  if (check.operator && (env.CI !== undefined || !process.stdin.isTTY)) {
    refuse(`The ${name} check needs an operator at an interactive terminal and never runs in CI`);
  }
  for (const key of Object.keys(ceiling) as Array<keyof typeof ceiling>) {
    if (budget[key] > ceiling[key]) refuse(`The ${name} check exceeds the ${key} ceiling`);
  }

  const artifactOrigins = check.env.some((key) => key === "BROWSERBASE_ARTIFACT_ORIGINS")
    ? approvedOrigins(setting("BROWSERBASE_ARTIFACT_ORIGINS"))
    : undefined;

  const report = (phase: string, result: unknown) =>
    Effect.sync(() =>
      console.log(
        JSON.stringify({ check: name, phase, result }, (_key, value) =>
          typeof value === "bigint" ? value.toString() : value,
        ),
      ),
    );

  const account = Account.layer({
    projectId: setting("BROWSERBASE_PROJECT_ID"),
    apiKey: Redacted.make(setting("BROWSERBASE_API_KEY")),
    ...(artifactOrigins === undefined ? {} : { artifactOrigins }),
    requestTimeoutMillis: 15_000,
  });

  const policy = BrowserPolicy.make({
    network: { _tag: "Unrestricted" },
    maxActions: budget.actions,
    maxElapsedMillis: budget.browserSeconds * 1000,
    maxReturnedBytes: 2 * 1024 * 1024,
  });

  let opened = 0;

  return {
    name,
    budget,
    claim: check.claim,
    report,
    /** Where a check writes files; the runner points this at its output directory. */
    output: resolve(env.BROWSERBASE_HOSTED_OUTPUT ?? `hosted-output/${name}`),
    /** Only the optional settings the registry entry names are readable. */
    setting: (key: (typeof check.optionalEnv)[number]): string | undefined => env[key],
    /** A browser whose account, timeouts and cleanup reporting come from the gate. */
    browser: (
      options: Omit<BrowserOptions, "onCleanup" | "onAllocationUncertain" | "actionTimeoutMillis">,
    ) =>
      BrowserbaseBrowser.layer({
        ...options,
        actionTimeoutMillis: 15_000,
        onCleanup: (cleanup) => report("cleanup", cleanup),
        onAllocationUncertain: (attempt) => report("allocation-unknown", attempt),
      }),
    /** The only way a check allocates, so the session budget is enforced before spending. */
    open: (options: OpenOptions = {}) =>
      Effect.gen(function* () {
        if (opened >= budget.sessions) {
          return yield* Effect.die(`The ${name} check is budgeted for ${budget.sessions} sessions`);
        }
        opened += 1;
        const session = yield* (yield* BrowserbaseBrowser).open(policy, options);

        yield* report("allocated", session.reference);

        return session;
      }),
    /** Fail unless every fact holds, so a `complete` record always means the claim held. */
    established: (
      facts: Record<string, boolean>,
    ): Effect.Effect<void, { readonly _tag: "ClaimNotEstablished"; readonly failed: string[] }> => {
      const failed = Object.keys(facts).filter((key) => facts[key] !== true);

      return failed.length === 0
        ? Effect.void
        : Effect.fail({ _tag: "ClaimNotEstablished" as const, failed });
    },
    /** Show the operator something privately and wait, bounded, for them to type a line. */
    ask: (prompt: string, timeoutMillis: number) =>
      Effect.acquireUseRelease(
        Effect.sync(() => createInterface({ input: process.stdin, output: process.stderr })),
        (lines) =>
          Effect.tryPromise(() => lines.question(`${prompt}\n> `)).pipe(
            Effect.timeout(timeoutMillis),
          ),
        (lines) => Effect.sync(() => lines.close()),
      ),
    /** Run the check once against one account and report how it ended. */
    run: async <A, E>(program: Effect.Effect<A, E, Account.Services>) => {
      const result = await Effect.runPromise(
        program.pipe(
          Effect.tapError((error) => report("failure", error)),
          Effect.provide(account),
        ),
      );

      await Effect.runPromise(report("complete", { claim: check.claim, result }));
    },
  };
};
