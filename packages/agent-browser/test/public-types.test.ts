import { expect, it } from "@effect/vitest";
import { Effect, type Layer, type Scope } from "effect";
import type { AdaptedSession, fromSession, SelectionOptions } from "effect-agent-browser/adapter";
import { interactiveLayer } from "effect-agent-browser/adapter";
import {
  type keyboardHandlers,
  type selectionHandlers,
  makeHost,
  run as runTools,
  type BrowserToolFailure,
  type HandlerOptions,
  type handlers,
  type ToolHostServices,
  type ToolFailureSnapshot,
} from "effect-agent-browser/tools";
import type { BrowserHandle, InteractiveBrowserError } from "effect-agent/interactive-browser";
import type { BrowserSession } from "effect-browser/browser";
import type { BrowserPolicy } from "effect-browser/browser-data";
import type { ChromiumSession } from "effect-browser/chromium";
import type { BrowserError, InitializationError } from "effect-browser/errors";
import type { BrowserbaseSession } from "effect-browserbase/browser";

type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Requirements<T> = T extends Effect.Effect<infer _A, infer _E, infer R> ? R : never;
type LayerRequirements<T> = T extends Layer.Layer<infer _A, infer _E, infer R> ? R : never;

/** The framework contract is preserved exactly; the adapter adds no parallel handle type. */
const originalContract: Same<AdaptedSession<BrowserSession>["handle"], BrowserHandle> = true;

const declaredFrameworkFailure = (error: InteractiveBrowserError): string => error._tag;

/** Tool handlers borrow one already-open session; they never require a browser service. */
const borrowed: Same<LayerRequirements<ReturnType<typeof handlers>>, never> = true;

const explicitOutcome: Same<
  BrowserToolFailure["outcome"],
  "undispatched" | "rejected" | "unknown"
> = true;

type CallbackFailure = { readonly _tag: "SettingsUnavailable" };

const retainedOwner: Same<
  Effect.Success<ReturnType<typeof fromSession<BrowserbaseSession<CallbackFailure>>>>["browser"],
  BrowserbaseSession<CallbackFailure>
> = true;

const retainedChromium: Same<
  Effect.Success<ReturnType<typeof fromSession<ChromiumSession<CallbackFailure>>>>["browser"],
  ChromiumSession<CallbackFailure>
> = true;

const adaptationError: Same<
  Effect.Error<ReturnType<typeof fromSession<ChromiumSession<CallbackFailure>>>>,
  BrowserError
> = true;

const adaptationServices: Same<
  Effect.Services<ReturnType<typeof fromSession<ChromiumSession<CallbackFailure>>>>,
  never
> = true;

const explicitSelection: Same<Parameters<typeof fromSession>[1], SelectionOptions> = true;

const singleHandle: Same<keyof AdaptedSession<BrowserSession>, "browser" | "handle"> = true;

const typedTools: Same<
  Parameters<typeof handlers<CallbackFailure>>[0],
  BrowserSession<CallbackFailure>
> = true;

const keyboardBorrowed: Same<LayerRequirements<ReturnType<typeof keyboardHandlers>>, never> = true;

const selectionBorrowed: Same<
  LayerRequirements<ReturnType<typeof selectionHandlers>>,
  never
> = true;

const retainedFailure: Same<
  Effect.Error<AdaptedSession<BrowserbaseSession<CallbackFailure>>["browser"]["failure"]>,
  CallbackFailure | InitializationError
> = true;

interface RecorderService {
  readonly _tag: "RecorderService";
}

interface ProgramService {
  readonly _tag: "ProgramService";
}

type OwnerFailure = { readonly _tag: "OwnerFailure" };
type ProgramFailure = { readonly _tag: "ProgramFailure" };

const callbackHost = (
  session: BrowserbaseSession<OwnerFailure>,
  callback: Effect.Effect<void, CallbackFailure, RecorderService | Scope.Scope>,
) => makeHost(session, { onNavigation: () => callback, onInput: () => callback });

const callbackRequirements: Same<
  Requirements<ReturnType<typeof callbackHost>>,
  RecorderService | Scope.Scope
> = true;

const callbackErrors: Same<
  Effect.Error<Effect.Success<ReturnType<typeof callbackHost>>["failure"]>,
  OwnerFailure | CallbackFailure | InitializationError | BrowserError
> = true;

const capturedRequirements: Same<
  LayerRequirements<Effect.Success<ReturnType<typeof callbackHost>>["handlers"]>,
  never
> = true;

const diagnosticSnapshot: Same<
  Effect.Success<ReturnType<typeof callbackHost>>["toolFailures"],
  Effect.Effect<ToolFailureSnapshot>
> = true;

const supervised = (
  host: Effect.Success<ReturnType<typeof callbackHost>>,
  program: Effect.Effect<number, ProgramFailure, ProgramService | ToolHostServices | Scope.Scope>,
) => host.run(program);

const supervisedRequirements: Same<
  Requirements<ReturnType<typeof supervised>>,
  ProgramService
> = true;

const supervisedErrors: Same<
  Effect.Error<ReturnType<typeof supervised>>,
  ProgramFailure | OwnerFailure | CallbackFailure | InitializationError | BrowserError
> = true;

const scoped = (
  session: BrowserbaseSession<OwnerFailure>,
  program: Effect.Effect<number, ProgramFailure, ProgramService | ToolHostServices | Scope.Scope>,
  callback: Effect.Effect<void, CallbackFailure, RecorderService | Scope.Scope>,
) => runTools(session, program, { onInput: () => callback });

const scopedRequirements: Same<
  Requirements<ReturnType<typeof scoped>>,
  ProgramService | RecorderService
> = true;

const scopedErrors: Same<
  Effect.Error<ReturnType<typeof scoped>>,
  ProgramFailure | OwnerFailure | CallbackFailure | InitializationError | BrowserError
> = true;

const callbackHandlerRequirement = (
  session: BrowserbaseSession<OwnerFailure>,
  callback: Effect.Effect<void, CallbackFailure, ToolHostServices | Scope.Scope>,
) => runTools(session, Effect.succeed(1), { onNavigation: () => callback });

const callbackHandlersStayRequired: Same<
  Requirements<ReturnType<typeof callbackHandlerRequirement>>,
  ToolHostServices
> = true;

const configured = (
  open: (
    policy: BrowserPolicy,
  ) => Effect.Effect<
    ChromiumSession<CallbackFailure>,
    CallbackFailure,
    RecorderService | Scope.Scope
  >,
) => interactiveLayer({ implementation: "chromium-playwright-cdp", open });

const openerRequirements: Same<
  LayerRequirements<ReturnType<typeof configured>>,
  RecorderService
> = true;

const synchronousAdmission: Same<
  ReturnType<NonNullable<HandlerOptions["admission"]>["admit"]>,
  boolean
> = true;

it("retains scoped ownership, original handle identity and typed native Tool failures", () => {
  expect(
    originalContract &&
      borrowed &&
      explicitOutcome &&
      retainedOwner &&
      retainedChromium &&
      adaptationError &&
      adaptationServices &&
      explicitSelection &&
      singleHandle &&
      openerRequirements &&
      typedTools &&
      keyboardBorrowed &&
      selectionBorrowed &&
      retainedFailure &&
      callbackRequirements &&
      callbackErrors &&
      capturedRequirements &&
      diagnosticSnapshot &&
      supervisedRequirements &&
      supervisedErrors &&
      scopedRequirements &&
      scopedErrors &&
      callbackHandlersStayRequired &&
      synchronousAdmission,
  ).toBe(true);
  expect(typeof declaredFrameworkFailure).toBe("function");
});
