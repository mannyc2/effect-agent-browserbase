import {
  type BrowserbaseInteractiveHost,
  type BrowserbaseSession,
} from "@effect-agent/platform-browserbase/interactive-browser";
import type { handlers } from "@effect-agent/platform-browserbase/tools";
import { type BrowserbaseToolFailure } from "@effect-agent/platform-browserbase/tools";
import { type BrowserbaseError } from "@effect-agent/platform-browserbase/types";
import { expect, it } from "@effect/vitest";
import { type Effect, type Layer, type Scope } from "effect";
import { type InteractiveBrowserError, type BrowserHandle } from "effect-agent/interactive-browser";

type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Requirements<T> = T extends Effect.Effect<infer _A, infer _E, infer R> ? R : never;
type LayerRequirements<T> = T extends Layer.Layer<infer _A, infer _E, infer R> ? R : never;

const scoped: Same<
  Requirements<ReturnType<BrowserbaseInteractiveHost["Service"]["open"]>>,
  Scope.Scope
> = true;

const hostErrors: Same<
  Effect.Error<ReturnType<BrowserbaseInteractiveHost["Service"]["open"]>>,
  BrowserbaseError | InteractiveBrowserError
> = true;

const originalContract: Same<BrowserbaseSession["handle"], BrowserHandle> = true;
const borrowed: Same<LayerRequirements<ReturnType<typeof handlers>>, never> = true;

const explicitOutcome: Same<
  BrowserbaseToolFailure["outcome"],
  "undispatched" | "rejected" | "unknown"
> = true;

it("retains scoped ownership, original handle identity and typed native Tool failures", () => {
  expect(scoped && hostErrors && originalContract && borrowed && explicitOutcome).toBe(true);
});
