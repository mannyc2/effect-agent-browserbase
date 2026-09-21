import { Effect, Exit, Option, Scope } from "effect";

import type { CleanupResult } from "../../Cleanup.ts";
import { BrowserbaseClient } from "../../Client.ts";
import { SessionError } from "../../Errors.ts";
import type { SessionReference } from "../../References.ts";
import { isTerminalSessionStatus } from "../../SessionData.ts";
import { BrowserbaseSessions } from "../../Sessions.ts";
import { connectionAddress } from "../provider/Connection.ts";
import {
  makeCleanup,
  noLocalConnection,
  reported,
  type CleanupLimits,
  type LocalCleanup,
} from "./Cleanup.ts";
import { reportCleanup } from "./Diagnostics.ts";

export interface AttachmentOptions {
  readonly reference: SessionReference;
  /** Bounded admission of a session the provider has not finished starting. */
  readonly pendingWaitMillis?: number;
  readonly onCleanup?: (result: CleanupResult) => Effect.Effect<void>;
}

const failure = (reason: SessionError["reason"]) =>
  SessionError.make({ operation: "session-attach", reason, outcome: "undispatched" });

/**
 * Borrowing an already running session. This scope owns its local connection and nothing
 * else: no allocation attempt is made, no release is requested, and no Context-writer
 * authority is claimed. Whoever allocated the session keeps all three.
 */
export const attachRemote = Effect.fnUntraced(function* (
  options: AttachmentOptions,
  local: LocalCleanup = noLocalConnection,
  limits?: CleanupLimits,
) {
  const client = yield* BrowserbaseClient;
  const sessions = yield* BrowserbaseSessions;
  const parent = yield* Scope.Scope;
  const pendingWaitMillis = options.pendingWaitMillis ?? 0;

  if (
    !Number.isSafeInteger(pendingWaitMillis) ||
    pendingWaitMillis < 0 ||
    pendingWaitMillis > 600_000
  )
    return yield* failure("configuration");

  // The status read validates project authority before anything is borrowed. A terminal
  // session needs a fresh allocation from durable state, never a reattachment.
  const observed = yield* sessions.retrieve(options.reference);

  if (isTerminalSessionStatus(observed.status)) return yield* failure("expired");
  if (observed.status !== "RUNNING") {
    if (pendingWaitMillis === 0) return yield* failure("active");
    yield* sessions.waitUntilRunning(observed.reference, { timeoutMillis: pendingWaitMillis });
  }
  const reference = observed.reference;

  return yield* Effect.uninterruptible(
    Effect.gen(function* () {
      const resourceScope = yield* Scope.make();
      let closing = false;
      let cleanup: CleanupResult | undefined;

      const terminate = yield* Effect.cached(
        Effect.uninterruptible(
          Effect.gen(function* () {
            closing = true;

            const coordinator = yield* makeCleanup(
              reference,
              "borrowed",
              sessions,
              local,
              (result) => {
                cleanup = result;
              },
              limits,
            );

            yield* coordinator.close;
            if (cleanup !== undefined) yield* reportCleanup(cleanup);
            if (cleanup !== undefined && options.onCleanup !== undefined)
              yield* reported(options.onCleanup(cleanup));
          }),
        ),
      );

      const closeScope = yield* Effect.cached(Scope.close(resourceScope, Exit.void));

      // Teardown is registered before the first connection, exactly as an owned scope does.
      yield* Scope.addFinalizer(resourceScope, terminate);
      yield* Scope.addFinalizer(parent, closeScope);

      return {
        reference,
        status: observed,
        connection: (timeoutMillis: number) =>
          Effect.suspend(() =>
            closing
              ? Effect.fail(
                  SessionError.make({
                    operation: "session-connect",
                    reason: "expired",
                    outcome: "undispatched",
                  }),
                )
              : // Credentials are fetched fresh: an expiry can race the caller's own read.
                connectionAddress(client, sessions, reference, timeoutMillis),
          ),
        release: closeScope.pipe(
          Effect.andThen(
            Effect.suspend(() =>
              cleanup === undefined
                ? Effect.die(new Error("Borrowed session closed without cleanup evidence"))
                : Effect.succeed(cleanup),
            ),
          ),
        ),
        cleanupResult: Effect.sync(() => Option.fromNullishOr(cleanup)),
      };
    }),
  );
});
