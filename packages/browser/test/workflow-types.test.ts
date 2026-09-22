import { expect, it } from "@effect/vitest";
import { Effect, type Scope } from "effect";
import type * as Bootstrap from "effect-browser/bootstrap";
import * as Browser from "effect-browser/browser";
import type { BrowserPolicy } from "effect-browser/browser-data";
import { Chromium, type ChromiumSession } from "effect-browser/chromium";
import type { BrowserError, InitializationError } from "effect-browser/errors";

type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type CallbackError = { readonly _tag: "CallbackError" };
type CallbackService = { readonly _tag: "CallbackService" };
type TaskError = { readonly _tag: "TaskError" };
type TaskService = { readonly _tag: "TaskService" };

const workflow = (
  policy: BrowserPolicy,
  bootstrap: Bootstrap.Plan<CallbackError, CallbackService | Scope.Scope>,
  task: (
    browser: ChromiumSession<CallbackError>,
  ) => Effect.Effect<string, TaskError, TaskService | Scope.Scope>,
) => Browser.scoped(Chromium.launch(policy, { bootstrap }), task);

const piped = (
  policy: BrowserPolicy,
  bootstrap: Bootstrap.Plan<CallbackError, CallbackService | Scope.Scope>,
  task: (
    browser: ChromiumSession<CallbackError>,
  ) => Effect.Effect<string, TaskError, TaskService | Scope.Scope>,
) => Chromium.launch(policy, { bootstrap }).pipe(Browser.scoped(task));

const inferred = (
  policy: BrowserPolicy,
  bootstrap: Bootstrap.Plan<CallbackError, CallbackService | Scope.Scope>,
) =>
  Chromium.launch(policy, { bootstrap }).pipe(
    Browser.scoped((browser) => Effect.succeed(browser.reference.provider)),
  );

const failures: Same<
  Effect.Error<ReturnType<typeof workflow>>,
  CallbackError | TaskError | BrowserError | InitializationError
> = true;

const services: Same<
  Effect.Services<ReturnType<typeof workflow>>,
  Chromium | CallbackService | TaskService
> = true;

const pipeSignature: Same<ReturnType<typeof piped>, ReturnType<typeof workflow>> = true;
const inferredResult: Same<Effect.Success<ReturnType<typeof inferred>>, "chromium"> = true;

const inferredFailures: Same<
  Effect.Error<ReturnType<typeof inferred>>,
  CallbackError | BrowserError | InitializationError
> = true;

it("Browser.scoped preserves the concrete owner, callback errors and unrelated services in both forms", () => {
  expect(failures && services && pipeSignature && inferredResult && inferredFailures).toBe(true);
});
