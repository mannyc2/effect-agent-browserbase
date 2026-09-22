import { expect, it } from "@effect/vitest";
import { type Effect, type Redacted, type Scope } from "effect";
import type * as Bootstrap from "effect-browser/bootstrap";
import type { BrowserSession } from "effect-browser/browser";
import type { BrowserPolicy } from "effect-browser/browser-data";
import type { Chromium, ChromiumSession } from "effect-browser/chromium";
import type { BrowserError, InitializationError } from "effect-browser/errors";

type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Failure = { readonly _tag: "LocalSettingsUnavailable" };
type Settings = { readonly _tag: "LocalSettings" };
type Requirements<T> = T extends Effect.Effect<infer _A, infer _E, infer R> ? R : never;

const open = (
  browser: Chromium["Service"],
  policy: BrowserPolicy,
  plan: Bootstrap.Plan<Failure, Settings | Scope.Scope>,
) => browser.launch(policy, { bootstrap: plan });

const attach = (
  browser: Chromium["Service"],
  endpoint: Redacted.Redacted<string>,
  policy: BrowserPolicy,
  plan: Bootstrap.Plan<Failure, Settings | Scope.Scope>,
) => browser.attach(endpoint, { policy, bootstrap: plan });

const environment: Same<Requirements<ReturnType<typeof open>>, Scope.Scope | Settings> = true;

const failures: Same<
  Effect.Error<ReturnType<typeof attach>>,
  BrowserError | InitializationError | Failure
> = true;

const exact: Same<Effect.Success<ReturnType<typeof attach>>, ChromiumSession<Failure>> = true;
const shared = (session: ChromiumSession<Failure>): BrowserSession<Failure> => session;
const identity: Same<ChromiumSession["reference"]["provider"], "chromium"> = true;

it("local acquisition keeps consumer errors and services while its reference stays local", () => {
  expect(environment && failures && exact && identity).toBe(true);
  expect(typeof shared).toBe("function");
});
