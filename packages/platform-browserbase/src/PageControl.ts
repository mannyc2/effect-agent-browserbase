import { Effect, Schema } from "effect";

import type { BrowserbaseSession } from "./InteractiveBrowser.ts";
import { pageControl } from "./internal/PageControlAssociation.ts";
import type { PageExecutionState } from "./Types.ts";
import { BrowserbaseError, PageInfo, PageSuspension } from "./Types.ts";
export { PageExecutionState, PageSuspension } from "./Types.ts";

const owner = (session: BrowserbaseSession) =>
  Effect.suspend(() => {
    const port = pageControl(session);

    return port === undefined
      ? Effect.fail(
          BrowserbaseError.make({
            operation: "page-control",
            reason: "unsupported",
            outcome: "undispatched",
          }),
        )
      : Effect.succeed(port);
  });

const invalid = () =>
  BrowserbaseError.make({
    operation: "page-control",
    reason: "configuration",
    outcome: "undispatched",
  });

/** Last acknowledged state; no remote guarantee survives connection loss or external control. */
export const state = (
  session: BrowserbaseSession,
  page: PageInfo,
): Effect.Effect<PageExecutionState, BrowserbaseError> =>
  Schema.decodeEffect(PageInfo)(page).pipe(
    Effect.mapError(invalid),
    Effect.map((value) => Object.freeze(PageInfo.make({ ...value }))),
    Effect.flatMap((value) => owner(session).pipe(Effect.flatMap((port) => port.state(value)))),
  );

/** Explicit host-only hold requiring InteractiveOptions.pageControl; capture ACKs never invoke it. */
export const suspend = (
  session: BrowserbaseSession,
  page: PageInfo,
): Effect.Effect<PageSuspension, BrowserbaseError> =>
  Schema.decodeEffect(PageInfo)(page).pipe(
    Effect.mapError(invalid),
    Effect.map((value) => Object.freeze(PageInfo.make({ ...value }))),
    Effect.flatMap((value) => owner(session).pipe(Effect.flatMap((port) => port.suspend(value)))),
  );

/** Consumes the exact live receipt. Activation is intentional; stale receipts never replay commands. */
export const resume = (
  session: BrowserbaseSession,
  receipt: PageSuspension,
): Effect.Effect<void, BrowserbaseError> =>
  Schema.decodeEffect(PageSuspension)(receipt).pipe(
    Effect.mapError(invalid),
    Effect.map((value) => Object.freeze(PageSuspension.make({ ...value }))),
    Effect.flatMap((value) => owner(session).pipe(Effect.flatMap((port) => port.resume(value)))),
  );
