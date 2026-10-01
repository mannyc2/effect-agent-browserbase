import { Effect, Schema } from "effect";

import type { BrowserSession, OperationOptions, Page } from "./Browser.ts";
import { type PageExecutionState, PageInfo, PageSuspension } from "./BrowserData.ts";
import { BrowserError, Reasons } from "./Errors.ts";
import { pageControl } from "./internal/browser/PageControlAssociation.ts";
import { checkedOperationOptions } from "./internal/browser/PublicSession.ts";
export { PageExecutionState, PageSuspension } from "./BrowserData.ts";

const owner = <E>(session: BrowserSession<E> | Page) =>
  Effect.suspend(() => {
    const association = pageControl(session);

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

const requested = <E>(
  session: BrowserSession<E> | Page,
  pageOrOptions?: PageInfo | OperationOptions,
  operationOptions?: OperationOptions,
) =>
  owner(session).pipe(
    Effect.flatMap((association) => {
      if (association.page !== undefined) {
        if (operationOptions !== undefined) return Effect.fail(invalid());

        const page = association.page;

        return checkedOperationOptions(pageOrOptions, "page-control").pipe(
          Effect.map((options) => ({ port: association.port, page, options })),
        );
      }
      if (pageOrOptions === undefined) return Effect.fail(invalid());

      return Schema.decodeUnknownEffect(PageInfo)(pageOrOptions, {
        onExcessProperty: "error",
      }).pipe(
        Effect.mapError(invalid),
        Effect.flatMap((value) =>
          checkedOperationOptions(operationOptions, "page-control").pipe(
            Effect.map((options) => ({
              port: association.port,
              page: Object.freeze(PageInfo.make({ ...value })),
              options,
            })),
          ),
        ),
      );
    }),
  );

/** Last acknowledged state; no remote guarantee survives connection loss or external control. */
export function state(
  page: Page,
  options?: OperationOptions,
): Effect.Effect<PageExecutionState, BrowserError>;

export function state<E>(
  session: BrowserSession<E>,
  page: PageInfo,
  options?: OperationOptions,
): Effect.Effect<PageExecutionState, BrowserError>;

export function state<E>(
  session: BrowserSession<E> | Page,
  pageOrOptions?: PageInfo | OperationOptions,
  options?: OperationOptions,
): Effect.Effect<PageExecutionState, BrowserError> {
  return requested(session, pageOrOptions, options).pipe(
    Effect.flatMap(({ port, page, options }) => port.state(page, options)),
  );
}

/** Explicit host-only hold requiring InteractiveOptions.pageControl; capture ACKs never invoke it. */
export function suspend(
  page: Page,
  options?: OperationOptions,
): Effect.Effect<PageSuspension, BrowserError>;

export function suspend<E>(
  session: BrowserSession<E>,
  page: PageInfo,
  options?: OperationOptions,
): Effect.Effect<PageSuspension, BrowserError>;

export function suspend<E>(
  session: BrowserSession<E> | Page,
  pageOrOptions?: PageInfo | OperationOptions,
  options?: OperationOptions,
): Effect.Effect<PageSuspension, BrowserError> {
  return requested(session, pageOrOptions, options).pipe(
    Effect.flatMap(({ port, page, options }) => port.suspend(page, options)),
  );
}

/** Consumes the exact live receipt. Activation is intentional; stale receipts never replay commands. */
export const resume = <E>(
  session: BrowserSession<E> | Page,
  receipt: PageSuspension,
  options?: OperationOptions,
): Effect.Effect<void, BrowserError> =>
  Schema.decodeEffect(PageSuspension)(receipt).pipe(
    Effect.mapError(invalid),
    Effect.map((value) => Object.freeze(PageSuspension.make({ ...value }))),
    Effect.flatMap((value) =>
      owner(session).pipe(
        Effect.flatMap(({ port, page }) =>
          page !== undefined && (page.pageId !== value.pageId || page.targetId !== value.targetId)
            ? Effect.fail(invalid())
            : checkedOperationOptions(options, "page-control").pipe(
                Effect.flatMap((options) => port.resume(value, options)),
              ),
        ),
      ),
    ),
  );
