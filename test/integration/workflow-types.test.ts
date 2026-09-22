import { expect, it } from "@effect/vitest";
import { Effect, type Scope } from "effect";
import type * as Bootstrap from "effect-browser/bootstrap";
import * as Browser from "effect-browser/browser";
import type { BrowserPolicy } from "effect-browser/browser-data";
import { Chromium } from "effect-browser/chromium";
import type { BrowserError, InitializationError } from "effect-browser/errors";
import { BrowserbaseBrowser } from "effect-browserbase/browser";
import type { AllocationError, ContextError } from "effect-browserbase/errors";

type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type LocalFailure = { readonly _tag: "LocalFailure" };
type HostedFailure = { readonly _tag: "HostedFailure" };
type BindingService = { readonly _tag: "BindingService" };
type TaskFailure = { readonly _tag: "TaskFailure" };
type TaskService = { readonly _tag: "TaskService" };

const workflows = (
  policy: BrowserPolicy,
  localPlan: Bootstrap.Plan<LocalFailure, BindingService | Scope.Scope>,
  hostedPlan: Bootstrap.Plan<HostedFailure, BindingService | Scope.Scope>,
  task: Effect.Effect<string, TaskFailure, TaskService | Scope.Scope>,
) => {
  const use = Browser.scoped((browser) => Effect.andThen(browser.observe(), task));

  return {
    local: Chromium.launch(policy, { bootstrap: localPlan }).pipe(use),
    hosted: BrowserbaseBrowser.open(policy, { bootstrap: hostedPlan }).pipe(use),
  };
};

type Workflows = ReturnType<typeof workflows>;

const localErrors: Same<
  Effect.Error<Workflows["local"]>,
  LocalFailure | TaskFailure | BrowserError | InitializationError
> = true;

const hostedErrors: Same<
  Effect.Error<Workflows["hosted"]>,
  HostedFailure | TaskFailure | BrowserError | InitializationError | AllocationError | ContextError
> = true;

const localServices: Same<
  Effect.Services<Workflows["local"]>,
  Chromium | BindingService | TaskService
> = true;

const hostedServices: Same<
  Effect.Services<Workflows["hosted"]>,
  BrowserbaseBrowser | BindingService | TaskService
> = true;

const localKnown: Same<
  unknown extends Effect.Error<Workflows["local"]> ? true : false,
  false
> = true;

const hostedKnown: Same<
  unknown extends Effect.Error<Workflows["hosted"]> ? true : false,
  false
> = true;

it("a stored unannotated workflow retains each real provider's errors and services", () => {
  expect(
    localErrors && hostedErrors && localServices && hostedServices && localKnown && hostedKnown,
  ).toBe(true);
});
