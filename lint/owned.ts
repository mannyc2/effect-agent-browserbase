// Strict lint policy for the packages this repository owns and their integration tests.
//
// Upstream's root `vite.config.ts` appends these overrides to `lint.overrides`, so they apply
// only to owned paths and take precedence there; upstream sources keep upstream's rules. Each
// rule is opted into on its own and grouped by the failure it prevents. A rule that does not
// fire today still guards against the code that would make it fire.
//
// Every severity is "error". Acceptance also rejects a disable directive that no longer
// suppresses anything, so an exception must stay necessary and say why:
//   // oxlint-disable-next-line <rule> -- <why this site is an exception>
//
// Effect diagnostics come from @effect/tsgo twice over. The patched `tsc` reports the language
// service defaults configured in upstream's `tsconfig.base.json`; the `effecttsgo` rules here are
// the stricter ones that are off or suggestion-only there, reported through the patched Oxlint.
// Effect's `@effect-diagnostics-next-line` directive suppresses a site for both.

import type { OxlintOverride } from "oxlint";

const packages = "packages/{browser,browserbase,agent-browser}";

/** Library source: what consumers import. */
const library = [`${packages}/src/**/*.ts`];

/**
 * Test code: package suites and fixtures, the paid hosted checks, and the repository-level
 * integration suites. Upstream keeps its own fixtures beside `test/integration`.
 */
const tests = [
  `${packages}/test/**/*.ts`,
  "packages/browserbase/hosted/**/*.ts",
  "test/integration/**/*.ts",
];

const owned = [`${packages}/**/*.ts`, ...tests, "test/vite.config.ts"];

/** Throwing or runtime-escaping accessors with typed, non-throwing Effect alternatives. */
const escapeHatches = [
  ["Option", "getOrThrow"],
  ["Option", "getOrThrowWith"],
  ["Result", "getOrThrow"],
  ["Result", "getOrThrowWith"],
  ["UndefinedOr", "getOrThrow"],
  ["UndefinedOr", "getOrThrowWith"],
  ["Array", "getUnsafe"],
  ["Context", "getUnsafe"],
  ["Effect", "runSync"],
  ["Effect", "runSyncExit"],
  ["Effect", "runPromise"],
  ["Effect", "runPromiseExit"],
  ["Effect", "runFork"],
].map(([object, property]) => ({
  object,
  property,
  message: `${object}.${property} throws or leaves the caller's fiber; library code returns a typed Effect.`,
}));

export const ownedOverrides: Array<OxlintOverride> = [
  {
    files: owned,
    plugins: ["effecttsgo", "promise"],
    rules: {
      // Don't panic: a failure is a typed value, not an unchecked escape.
      "typescript/no-non-null-assertion": "error",
      "typescript/only-throw-error": "error",
      // Re-rejecting a caught `unknown` forwards the original failure unchanged.
      "typescript/prefer-promise-reject-errors": ["error", { allowThrowingUnknown: true }],
      "effecttsgo/schema-sync-in-effect": "error",
      "effecttsgo/try-catch-in-effect-gen": "error",

      // Don't fail silently: no dropped work, swallowed failure or assertion-free test.
      "typescript/no-floating-promises": "error",
      "typescript/no-misused-promises": "error",
      "typescript/use-unknown-in-catch-callback-variable": "error",
      "eslint/preserve-caught-error": "error",
      "eslint/no-empty": "error",
      "effecttsgo/return-effect-in-gen": "error",
      "effecttsgo/catch-unfailable-effect": "error",
      "effecttsgo/any-unknown-in-error-context": "error",
      "vitest/expect-expect": "error",
      "vitest/no-conditional-expect": "error",
      "vitest/no-conditional-tests": "error",
      "vitest/no-disabled-tests": "error",

      // Don't do bad async things: keep interruption, supervision and settlement explicit.
      "typescript/return-await": "error",
      "eslint/no-promise-executor-return": "error",
      "promise/no-callback-in-promise": "error",
      "promise/no-multiple-resolved": "error",
      "promise/no-promise-in-callback": "error",
      "effecttsgo/run-effect-inside-effect": "error",
      "effecttsgo/abort-controller-in-effect": "error",
      "effecttsgo/leaking-requirements": "error",

      // Don't escape the type system: `any` and narrowing casts are TypeScript's `unsafe`.
      "typescript/no-unsafe-argument": "error",
      "typescript/no-unsafe-assignment": "error",
      "typescript/no-unsafe-call": "error",
      "typescript/no-unsafe-member-access": "error",
      "typescript/no-unsafe-return": "error",
      "typescript/no-unsafe-type-assertion": "error",
      "effecttsgo/unsafe-effect-type-assertion": "error",
      "typescript/ban-ts-comment": [
        "error",
        {
          "ts-check": false,
          "ts-expect-error": "allow-with-description",
          "ts-ignore": true,
          "ts-nocheck": true,
          minimumDescriptionLength: 10,
        },
      ],

      // Don't do potentially incorrect things with numbers.
      "typescript/restrict-plus-operands": "error",
      "typescript/require-array-sort-compare": "error",
      "unicorn/prefer-number-properties": "error",
      "eslint/radix": "error",
      "effecttsgo/schema-number": "error",

      // Keep effects deterministic under TestClock and Random.
      "effecttsgo/global-date-in-effect": "error",
      "effecttsgo/global-random-in-effect": "error",
      "effecttsgo/global-timers-in-effect": "error",

      // Don't do bad things that are easy to avoid.
      "eslint/no-new": "error",
      "eslint/no-warning-comments": "error",
      "typescript/no-deprecated": "error",
      "typescript/switch-exhaustiveness-check": "error",
      "effecttsgo/extends-native-error": "error",
    },
  },
  {
    // Library code reaches the platform only through Effect services, and never unwraps.
    files: library,
    rules: {
      "eslint/no-restricted-properties": ["error", ...escapeHatches],
      "effecttsgo/prefer-schema-over-json": "error",
      "effecttsgo/global-console": "error",
      "effecttsgo/global-console-in-effect": "error",
      "effecttsgo/global-date": "error",
      "effecttsgo/global-fetch": "error",
      "effecttsgo/global-fetch-in-effect": "error",
      "effecttsgo/global-random": "error",
      "effecttsgo/process-env": "error",
      "effecttsgo/process-env-in-effect": "error",
    },
  },
  {
    // Tests may unwrap, cast and use `any`-typed test utilities such as asymmetric matchers and
    // prototype spies; a wrong guess fails the test that made it.
    files: tests,
    rules: {
      "typescript/no-non-null-assertion": "off",
      "typescript/no-unsafe-argument": "off",
      "typescript/no-unsafe-assignment": "off",
      "typescript/no-unsafe-call": "off",
      "typescript/no-unsafe-member-access": "off",
      "typescript/no-unsafe-return": "off",
      "typescript/no-unsafe-type-assertion": "off",
    },
  },
];
