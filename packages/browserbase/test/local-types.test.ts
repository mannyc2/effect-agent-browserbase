import { expect, it } from "@effect/vitest";
import { type Effect, type Redacted, type Scope } from "effect";
import type * as Bootstrap from "effect-browserbase/bootstrap";
import type { BrowserSession } from "effect-browserbase/browser";
import type { BrowserPolicy } from "effect-browserbase/browser-data";
import type { BrowserError, InitializationError } from "effect-browserbase/errors";
import type { LocalBrowser, LocalSession } from "effect-browserbase/local-browser";

type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Failure = { readonly _tag: "LocalSettingsUnavailable" };
type Settings = { readonly _tag: "LocalSettings" };
type Requirements<T> = T extends Effect.Effect<infer _A, infer _E, infer R> ? R : never;

const open = (
  browser: LocalBrowser["Service"],
  policy: BrowserPolicy,
  plan: Bootstrap.Plan<Failure, Settings | Scope.Scope>,
) => browser.open(policy, { bootstrap: plan });

const attach = (
  browser: LocalBrowser["Service"],
  endpoint: Redacted.Redacted<string>,
  policy: BrowserPolicy,
  plan: Bootstrap.Plan<Failure, Settings | Scope.Scope>,
) => browser.attach(endpoint, { policy, bootstrap: plan });

const environment: Same<Requirements<ReturnType<typeof open>>, Scope.Scope | Settings> = true;

const failures: Same<
  Effect.Error<ReturnType<typeof attach>>,
  BrowserError | InitializationError | Failure
> = true;

const exact: Same<Effect.Success<ReturnType<typeof attach>>, LocalSession<Failure>> = true;
const shared = (session: LocalSession<Failure>): BrowserSession<Failure> => session;
const identity: Same<LocalSession["reference"]["provider"], "local"> = true;

it("local acquisition keeps consumer errors and services while its reference stays local", () => {
  expect(environment && failures && exact && identity).toBe(true);
  expect(typeof shared).toBe("function");
});
