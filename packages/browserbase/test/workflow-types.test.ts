import { expect, it } from "@effect/vitest";
import { Effect, type Scope } from "effect";
import type * as Bootstrap from "effect-browser/bootstrap";
import * as Browser from "effect-browser/browser";
import type { BrowserPolicy } from "effect-browser/browser-data";
import type { BrowserError, InitializationError } from "effect-browser/errors";
import { BrowserbaseBrowser } from "effect-browserbase/browser";
import type { AllocationError, ContextError } from "effect-browserbase/errors";

type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type HostedFailure = { readonly _tag: "HostedFailure" };
type BindingService = { readonly _tag: "BindingService" };
type TaskFailure = { readonly _tag: "TaskFailure" };
type TaskService = { readonly _tag: "TaskService" };

const workflows = (
  policy: BrowserPolicy,
  hostedPlan: Bootstrap.Plan<HostedFailure, BindingService | Scope.Scope>,
  task: Effect.Effect<string, TaskFailure, TaskService | Scope.Scope>,
) => {
  const use = Browser.scoped((browser) => Effect.andThen(browser.observe(), task));

  return {
    hosted: BrowserbaseBrowser.open(policy, { bootstrap: hostedPlan }).pipe(use),
  };
};

type Workflows = ReturnType<typeof workflows>;

const hostedErrors: Same<
  Effect.Error<Workflows["hosted"]>,
  HostedFailure | TaskFailure | BrowserError | InitializationError | AllocationError | ContextError
> = true;

const hostedServices: Same<
  Effect.Services<Workflows["hosted"]>,
  BrowserbaseBrowser | BindingService | TaskService
> = true;

const hostedKnown: Same<
  unknown extends Effect.Error<Workflows["hosted"]> ? true : false,
  false
> = true;

it("a stored unannotated workflow retains the real provider's errors and services", () => {
  expect(hostedErrors && hostedServices && hostedKnown).toBe(true);
});
