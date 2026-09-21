import type {
  BrowserbaseAgentSession,
  BrowserbaseInteractiveHost,
} from "@effect-agent/platform-browserbase/adapter";
import type { BrowserbaseToolFailure, handlers } from "@effect-agent/platform-browserbase/tools";
import { expect, it } from "@effect/vitest";
import { type Effect, type Layer, type Scope } from "effect";
import type { BrowserHandle, InteractiveBrowserError } from "effect-agent/interactive-browser";

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

it("retains scoped ownership, original handle identity and typed native Tool failures", () => {
  expect(scoped && originalContract && borrowed && explicitOutcome).toBe(true);
  expect(typeof declaredFrameworkFailure).toBe("function");
});
