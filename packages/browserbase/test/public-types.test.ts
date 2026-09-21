import { expect, it } from "@effect/vitest";
import { type Effect, type Scope } from "effect";
import {
  type BoundTarget,
  type BrowserbaseBrowser,
  type BrowserbaseSession,
} from "effect-browserbase/browser";
import type { BrowserPolicy } from "effect-browserbase/browser-data";
import type * as Capture from "effect-browserbase/capture";
import type {
  AllocationError,
  BrowserError,
  ContextError,
  InitializationError,
} from "effect-browserbase/errors";
import type * as PageControl from "effect-browserbase/page-control";

type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Requirements<T> = T extends Effect.Effect<infer _A, infer _E, infer R> ? R : never;

// Instantiate the default call: ReturnType of an uninstantiated generic method is unknown,
// not evidence of whether this environment-free plan requires a consumer service.
const plainOpen = (browser: BrowserbaseBrowser["Service"], policy: BrowserPolicy) =>
  browser.open(policy);

const scoped: Same<Requirements<ReturnType<typeof plainOpen>>, Scope.Scope> = true;

/** Acquisition keeps allocation and context authority visible; operations do not. */
const hostErrors: Same<
  Effect.Error<ReturnType<typeof plainOpen>>,
  AllocationError | BrowserError | ContextError | InitializationError
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
