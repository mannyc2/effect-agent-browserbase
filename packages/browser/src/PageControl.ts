import { Effect, Schema } from "effect";

import type { OperationOptions, Page } from "./Browser.ts";
import { type PageExecutionState, PageSuspension } from "./BrowserData.ts";
import { BrowserError, Reasons } from "./Errors.ts";
import { pageControl } from "./internal/browser/PageControlAssociation.ts";
import { checkedOperationOptions } from "./internal/browser/PublicSession.ts";
export { PageExecutionState, PageSuspension } from "./BrowserData.ts";

const owner = (page: Page) =>
  Effect.suspend(() => {
    const association = pageControl(page);

    return association === undefined
      ? Effect.fail(
          BrowserError.make({
            operation: "page-control",
            reason: Reasons.UnregisteredSession.make({}),
            outcome: "undispatched",
          }),
        )
      : Effect.succeed(association);
  });

const invalid = () =>
  BrowserError.make({
    operation: "page-control",
    reason: Reasons.Configuration.make({}),
    outcome: "undispatched",
  });

const requested = (page: Page, options?: OperationOptions) =>
  owner(page).pipe(
    Effect.flatMap((association) =>
      checkedOperationOptions(options, "page-control").pipe(
        Effect.map((options) => ({ port: association.port, page: association.page, options })),
      ),
    ),
  );

/** Last acknowledged state; no remote guarantee survives connection loss or external control. */
export const state = (
  page: Page,
  options?: OperationOptions,
): Effect.Effect<PageExecutionState, BrowserError> =>
  requested(page, options).pipe(
    Effect.flatMap(({ port, page, options }) => port.state(page, options)),
  );

/** Explicit host-only hold requiring pageControl support; capture ACKs never invoke it. */
export const suspend = (
  page: Page,
  options?: OperationOptions,
): Effect.Effect<PageSuspension, BrowserError> =>
  requested(page, options).pipe(
    Effect.flatMap(({ port, page, options }) => port.suspend(page, options)),
  );

/** Consumes the exact live receipt. Activation is intentional; stale receipts never replay commands. */
export const resume = (
  page: Page,
  receipt: PageSuspension,
  options?: OperationOptions,
): Effect.Effect<void, BrowserError> =>
  Schema.decodeEffect(PageSuspension)(receipt).pipe(
    Effect.mapError(invalid),
    Effect.map((value) => Object.freeze(PageSuspension.make({ ...value }))),
    Effect.flatMap((value) =>
      owner(page).pipe(
        Effect.flatMap(({ port, page }) =>
          page.pageId !== value.pageId || page.targetId !== value.targetId
            ? Effect.fail(invalid())
            : checkedOperationOptions(options, "page-control").pipe(
                Effect.flatMap((options) => port.resume(value, options)),
              ),
        ),
      ),
    ),
  );
