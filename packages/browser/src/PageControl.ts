import { Effect, Schema } from "effect";

import type { BrowserSession } from "./Browser.ts";
import { type PageExecutionState, PageInfo, PageSuspension } from "./BrowserData.ts";
import { BrowserError, Reasons } from "./Errors.ts";
import { pageControl } from "./internal/browser/PageControlAssociation.ts";
export { PageExecutionState, PageSuspension } from "./BrowserData.ts";

const owner = <E>(session: BrowserSession<E>) =>
  Effect.suspend(() => {
    const port = pageControl(session);

    return port === undefined
      ? Effect.fail(
          BrowserError.make({
            operation: "page-control",
            reason: Reasons.UnregisteredSession.make({}),
            outcome: "undispatched",
          }),
        )
      : Effect.succeed(port);
  });

const invalid = () =>
  BrowserError.make({
    operation: "page-control",
    reason: Reasons.Configuration.make({}),
    outcome: "undispatched",
  });

/** Last acknowledged state; no remote guarantee survives connection loss or external control. */
export const state = <E>(
  session: BrowserSession<E>,
  page: PageInfo,
): Effect.Effect<PageExecutionState, BrowserError> =>
  Schema.decodeEffect(PageInfo)(page).pipe(
    Effect.mapError(invalid),
    Effect.map((value) => Object.freeze(PageInfo.make({ ...value }))),
    Effect.flatMap((value) => owner(session).pipe(Effect.flatMap((port) => port.state(value)))),
  );

/** Explicit host-only hold requiring InteractiveOptions.pageControl; capture ACKs never invoke it. */
export const suspend = <E>(
  session: BrowserSession<E>,
  page: PageInfo,
): Effect.Effect<PageSuspension, BrowserError> =>
  Schema.decodeEffect(PageInfo)(page).pipe(
    Effect.mapError(invalid),
    Effect.map((value) => Object.freeze(PageInfo.make({ ...value }))),
    Effect.flatMap((value) => owner(session).pipe(Effect.flatMap((port) => port.suspend(value)))),
  );

/** Consumes the exact live receipt. Activation is intentional; stale receipts never replay commands. */
export const resume = <E>(
  session: BrowserSession<E>,
  receipt: PageSuspension,
): Effect.Effect<void, BrowserError> =>
  Schema.decodeEffect(PageSuspension)(receipt).pipe(
    Effect.mapError(invalid),
    Effect.map((value) => Object.freeze(PageSuspension.make({ ...value }))),
    Effect.flatMap((value) => owner(session).pipe(Effect.flatMap((port) => port.resume(value)))),
  );
