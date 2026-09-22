import { expect, it } from "@effect/vitest";
import { type Effect, type Layer, type Scope } from "effect";
import type { AgentSession, AdaptedSession, fromSession } from "effect-agent-browser/adapter";
import { interactiveLayer } from "effect-agent-browser/adapter";
import {
  makeHost,
  type BrowserToolFailure,
  type HandlerOptions,
  type handlers,
} from "effect-agent-browser/tools";
import type { BrowserHandle, InteractiveBrowserError } from "effect-agent/interactive-browser";
import type { BrowserPolicy } from "effect-browser/browser-data";
import type { ChromiumSession } from "effect-browser/chromium";
import type { BrowserError, InitializationError } from "effect-browser/errors";
import type { BrowserbaseSession } from "effect-browserbase/browser";

type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Requirements<T> = T extends Effect.Effect<infer _A, infer _E, infer R> ? R : never;
type LayerRequirements<T> = T extends Layer.Layer<infer _A, infer _E, infer R> ? R : never;

/** The framework contract is preserved exactly; the adapter adds no parallel handle type. */
const originalContract: Same<AgentSession["handle"], BrowserHandle> = true;

const declaredFrameworkFailure = (error: InteractiveBrowserError): string => error._tag;

/** Tool handlers borrow one already-open session; they never require a browser service. */
const borrowed: Same<LayerRequirements<ReturnType<typeof handlers>>, never> = true;

const explicitOutcome: Same<
  BrowserToolFailure["outcome"],
  "undispatched" | "rejected" | "unknown"
> = true;

type CallbackFailure = { readonly _tag: "SettingsUnavailable" };

const retainedOwner: Same<
  ReturnType<typeof fromSession<BrowserbaseSession<CallbackFailure>>>["browser"],
  BrowserbaseSession<CallbackFailure>
> = true;

const retainedChromium: Same<
  ReturnType<typeof fromSession<ChromiumSession<CallbackFailure>>>["browser"],
  ChromiumSession<CallbackFailure>
> = true;

const typedTools: Same<
  Parameters<typeof handlers<CallbackFailure>>[0],
  AgentSession<CallbackFailure>
> = true;

const retainedFailure: Same<
  Effect.Error<AdaptedSession<BrowserbaseSession<CallbackFailure>>["browser"]["failure"]>,
  CallbackFailure | InitializationError
> = true;

interface RecorderService {
  readonly _tag: "RecorderService";
}

const callbackHost = (
  session: AgentSession,
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
      openerRequirements &&
      typedTools &&
      retainedFailure &&
      callbackRequirements &&
      callbackErrors &&
      capturedRequirements &&
      synchronousAdmission,
  ).toBe(true);
  expect(typeof declaredFrameworkFailure).toBe("function");
});
