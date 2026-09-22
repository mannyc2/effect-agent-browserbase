import { expect, it } from "@effect/vitest";
import { type Effect, type Scope } from "effect";
import { type BoundTarget, type NavigationOperation } from "effect-browser/browser";
import type {
  BrowserPolicy,
  Checkpoint,
  ControlFacts,
  InputReceipt,
  ObservedElement,
} from "effect-browser/browser-data";
import type * as Capture from "effect-browser/capture";
import type { BrowserError, InitializationError } from "effect-browser/errors";
import type * as PageControl from "effect-browser/page-control";
import {
  type BrowserAcquisition,
  type BrowserbaseBrowser,
  type BrowserbaseSession,
} from "effect-browserbase/browser";
import type { CleanupResult } from "effect-browserbase/cleanup";
import type { AllocationError, ContextError } from "effect-browserbase/errors";

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

const receiptClose: Same<BrowserbaseSession["close"], Effect.Effect<CleanupResult>> = true;
const acquisitionClose: Same<BrowserAcquisition["close"], Effect.Effect<CleanupResult>> = true;

const checkedClose: Same<
  BrowserbaseSession["closeChecked"],
  Effect.Effect<void, BrowserError>
> = true;

const boundTarget: Same<ReturnType<BrowserbaseSession["bind"]>, BoundTarget> = true;

/** Native input is an ordinary owned operation: one receipt, one error, no environment. */
const inputEffect: Same<
  ReturnType<BoundTarget["wheel"]>,
  Effect.Effect<InputReceipt, BrowserError>
> = true;

const hoverElementEffect: Same<
  ReturnType<BrowserbaseSession["hoverElement"]>,
  Effect.Effect<InputReceipt, BrowserError>
> = true;

/** Key input is the same kind of owned operation, by selector or by the node an observation named. */
const keyEffect: Same<
  ReturnType<BoundTarget["press"]>,
  Effect.Effect<InputReceipt, BrowserError>
> = true;

const keyElementEffect: Same<
  ReturnType<BrowserbaseSession["pressElement"]>,
  Effect.Effect<InputReceipt, BrowserError>
> = true;

/** Host-only reads and the hold check are owned operations with no environment of their own. */
const checkpointEffect: Same<
  ReturnType<BrowserbaseSession["checkpoint"]>,
  Effect.Effect<Checkpoint, BrowserError>
> = true;

const factsEffect: Same<
  ReturnType<BrowserbaseSession["controlFacts"]>,
  Effect.Effect<ControlFacts, BrowserError>
> = true;

const revalidateEffect: Same<
  ReturnType<BrowserbaseSession["revalidateElement"]>,
  Effect.Effect<ObservedElement, BrowserError>
> = true;

/** A navigation left in flight is a scoped resource; completing or stopping it needs nothing. */
const navigationEffect: Same<
  ReturnType<BoundTarget["startNavigation"]>,
  Effect.Effect<NavigationOperation, BrowserError, Scope.Scope>
> = true;

const navigationStop: Same<NavigationOperation["stop"], Effect.Effect<void, BrowserError>> = true;

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
      receiptClose &&
      acquisitionClose &&
      checkedClose &&
      boundTarget &&
      inputEffect &&
      hoverElementEffect &&
      keyEffect &&
      keyElementEffect &&
      navigationEffect &&
      navigationStop &&
      checkpointEffect &&
      factsEffect &&
      revalidateEffect &&
      captureErrors &&
      captureScope &&
      controlErrors &&
      controlScope,
  ).toBe(true);
  expect(sourceSize.width).toBe(640);
});
