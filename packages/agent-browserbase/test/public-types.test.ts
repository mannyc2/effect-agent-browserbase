import { expect, it } from "@effect/vitest";
import { type Effect, type Layer, type Scope } from "effect";
import type {
  AgentSession,
  BrowserbaseAgentSession,
  BrowserbaseInteractiveHost,
  fromSession,
} from "effect-agent-browserbase/adapter";
import {
  makeHost,
  type BrowserbaseToolFailure,
  type HandlerOptions,
  type handlers,
} from "effect-agent-browserbase/tools";
import type { BrowserHandle, InteractiveBrowserError } from "effect-agent/interactive-browser";
import type { BrowserbaseSession } from "effect-browserbase/browser";
import type { BrowserError, InitializationError } from "effect-browserbase/errors";

type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Requirements<T> = T extends Effect.Effect<infer _A, infer _E, infer R> ? R : never;
type LayerRequirements<T> = T extends Layer.Layer<infer _A, infer _E, infer R> ? R : never;

const scoped: Same<
  Requirements<ReturnType<BrowserbaseInteractiveHost["Service"]["open"]>>,
  Scope.Scope
> = true;

/** The framework contract is preserved exactly; the adapter adds no parallel handle type. */
const originalContract: Same<BrowserbaseAgentSession["handle"], BrowserHandle> = true;

const declaredFrameworkFailure = (error: InteractiveBrowserError): string => error._tag;

/** Tool handlers borrow one already-open session; they never require a browser service. */
const borrowed: Same<LayerRequirements<ReturnType<typeof handlers>>, never> = true;

const explicitOutcome: Same<
  BrowserbaseToolFailure["outcome"],
  "undispatched" | "rejected" | "unknown"
> = true;

type CallbackFailure = { readonly _tag: "SettingsUnavailable" };

const retainedOwner: Same<
  ReturnType<typeof fromSession<CallbackFailure>>["browser"],
  BrowserbaseSession<CallbackFailure>
> = true;

const typedTools: Same<
  Parameters<typeof handlers<CallbackFailure>>[0],
  AgentSession<CallbackFailure>
> = true;

const retainedFailure: Same<
  Effect.Error<BrowserbaseAgentSession<CallbackFailure>["browser"]["failure"]>,
  CallbackFailure | InitializationError
> = true;

interface RecorderService {
  readonly _tag: "RecorderService";
}

const callbackHost = (
  session: BrowserbaseAgentSession,
  callback: Effect.Effect<void, CallbackFailure, RecorderService | Scope.Scope>,
) => makeHost(session, { onNavigation: () => callback, onInput: () => callback });

const callbackRequirements: Same<
  Requirements<ReturnType<typeof callbackHost>>,
  RecorderService | Scope.Scope
> = true;

const callbackErrors: Same<
  Effect.Error<Effect.Success<ReturnType<typeof callbackHost>>["failure"]>,
  CallbackFailure | BrowserError
> = true;

const capturedRequirements: Same<
  LayerRequirements<Effect.Success<ReturnType<typeof callbackHost>>["handlers"]>,
  never
> = true;

const synchronousAdmission: Same<
  ReturnType<NonNullable<HandlerOptions["admission"]>["admit"]>,
  boolean
> = true;

it("retains scoped ownership, original handle identity and typed native Tool failures", () => {
  expect(
    scoped &&
      originalContract &&
      borrowed &&
      explicitOutcome &&
      retainedOwner &&
      typedTools &&
      retainedFailure &&
      callbackRequirements &&
      callbackErrors &&
      capturedRequirements &&
      synchronousAdmission,
  ).toBe(true);
  expect(typeof declaredFrameworkFailure).toBe("function");
});
