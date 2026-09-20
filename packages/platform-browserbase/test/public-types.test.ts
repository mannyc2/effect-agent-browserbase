import type * as Capture from "@effect-agent/platform-browserbase/capture";
import {
  type BrowserbaseInteractiveHost,
  type BrowserbaseSession,
} from "@effect-agent/platform-browserbase/interactive-browser";
import type * as PageControl from "@effect-agent/platform-browserbase/page-control";
import {
  type handlers,
  type BrowserbaseToolFailure,
} from "@effect-agent/platform-browserbase/tools";
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

const captureErrors: Same<Effect.Error<ReturnType<typeof Capture.start>>, BrowserbaseError> = true;
const captureScope: Same<Requirements<ReturnType<typeof Capture.start>>, Scope.Scope> = true;
const sourceSize: Capture.CaptureSize = { width: 640, height: 360 };

const controlErrors: Same<
  Effect.Error<ReturnType<typeof PageControl.suspend>>,
  BrowserbaseError
> = true;

const controlScope: Same<Requirements<ReturnType<typeof PageControl.suspend>>, never> = true;
const originalContract: Same<BrowserbaseSession["handle"], BrowserHandle> = true;
const borrowed: Same<LayerRequirements<ReturnType<typeof handlers>>, never> = true;

const explicitOutcome: Same<
  BrowserbaseToolFailure["outcome"],
  "undispatched" | "rejected" | "unknown"
> = true;

it("retains scoped ownership, original handle identity and typed native Tool failures", () => {
  expect(
    scoped &&
      hostErrors &&
      originalContract &&
      borrowed &&
      explicitOutcome &&
      captureErrors &&
      captureScope &&
      controlErrors &&
      controlScope,
  ).toBe(true);
  expect(sourceSize.width).toBe(640);
});
