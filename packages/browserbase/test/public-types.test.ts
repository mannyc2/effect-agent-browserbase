import {
  type BoundTarget,
  type BrowserbaseBrowser,
  type BrowserbaseSession,
} from "@effect-agent/browserbase/browser";
import type * as Capture from "@effect-agent/browserbase/capture";
import type { AllocationError, BrowserError, ContextError } from "@effect-agent/browserbase/errors";
import type * as PageControl from "@effect-agent/browserbase/page-control";
import { expect, it } from "@effect/vitest";
import { type Effect, type Scope } from "effect";

type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Requirements<T> = T extends Effect.Effect<infer _A, infer _E, infer R> ? R : never;

const scoped: Same<
  Requirements<ReturnType<BrowserbaseBrowser["Service"]["open"]>>,
  Scope.Scope
> = true;

/** Acquisition keeps allocation and context authority visible; operations do not. */
const hostErrors: Same<
  Effect.Error<ReturnType<BrowserbaseBrowser["Service"]["open"]>>,
  AllocationError | BrowserError | ContextError
> = true;

const operationErrors: Same<
  Effect.Error<ReturnType<BrowserbaseSession["clickElement"]>>,
  BrowserError
> = true;

const boundTarget: Same<ReturnType<BrowserbaseSession["bind"]>, BoundTarget> = true;

const captureErrors: Same<Effect.Error<ReturnType<typeof Capture.start>>, BrowserError> = true;
const captureScope: Same<Requirements<ReturnType<typeof Capture.start>>, Scope.Scope> = true;
const sourceSize: Capture.CaptureSize = { width: 640, height: 360 };

const controlErrors: Same<
  Effect.Error<ReturnType<typeof PageControl.suspend>>,
  BrowserError
> = true;

const controlScope: Same<Requirements<ReturnType<typeof PageControl.suspend>>, never> = true;

it("retains scoped ownership, declared acquisition failures and framework-free operations", () => {
  expect(
    scoped &&
      hostErrors &&
      operationErrors &&
      boundTarget &&
      captureErrors &&
      captureScope &&
      controlErrors &&
      controlScope,
  ).toBe(true);
  expect(sourceSize.width).toBe(640);
});
