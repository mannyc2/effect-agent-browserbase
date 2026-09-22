import { Effect, type Option, type Redacted } from "effect";
import type { Lifetime, Source } from "effect-browser/browser-runtime";
import { BrowserError, Reasons } from "effect-browser/errors";

import type { CleanupResult } from "../../Cleanup.ts";
import { BrowserbaseClient } from "../../Client.ts";
import type { AllocationError, ContextError, SessionError } from "../../Errors.ts";
import type { LaunchRecipe } from "../../Launch.ts";
import type { AllocationAttempt, SessionReference } from "../../References.ts";
import { BrowserbaseSessions } from "../../Sessions.ts";
import { issueLiveView, type LiveView } from "../browser/LiveView.ts";
import { browserRequestFailure } from "../browser/RequestFailure.ts";
import { acquireRemote } from "./Acquisition.ts";
import { attachRemote } from "./Attachment.ts";
import type { ContextWriterPermit } from "./WriterFacts.ts";

export interface RemoteLease extends Lifetime {
  readonly reference: SessionReference;
  readonly closeChecked: Effect.Effect<CleanupResult, BrowserError>;
  readonly attempt?: AllocationAttempt;
  readonly release: Effect.Effect<CleanupResult>;
  readonly cleanupResult: Effect.Effect<Option.Option<CleanupResult>>;
  readonly liveView: (ttl: number) => Effect.Effect<LiveView, BrowserError>;
}

type RemoteSource<L extends Lifetime, E> = Source<L, E, BrowserbaseClient | BrowserbaseSessions>;

/** A borrowed connection closes without requiring or requesting remote termination. */
const checkedCleanup = (
  close: Effect.Effect<CleanupResult>,
): Effect.Effect<CleanupResult, BrowserError> =>
  close.pipe(
    Effect.filterOrFail(
      (result) =>
        result.local === "closed" &&
        result.issues.length === 0 &&
        (result.ownership === "borrowed"
          ? result.remote === "not-owned"
          : result.remote === "confirmed"),
      () =>
        BrowserError.make({
          operation: "close",
          reason: Reasons.Provider.make({}),
          outcome: "unknown",
        }),
    ),
  );

const withConnection = <
  A extends {
    readonly reference: SessionReference;
    readonly connection: (
      timeoutMillis: number,
    ) => Effect.Effect<Redacted.Redacted<string>, SessionError>;
    readonly release: Effect.Effect<CleanupResult>;
  },
>(
  acquired: A,
) => ({
  ...acquired,
  connection: (timeoutMillis: number) =>
    acquired
      .connection(timeoutMillis)
      .pipe(Effect.mapError((error) => browserRequestFailure("connect", error))),
  closeChecked: checkedCleanup(acquired.release),
});

export interface OwnedLease extends RemoteLease {
  readonly attempt: AllocationAttempt;
}

export interface OwnedOptions {
  /** The single provider-faithful launch description; the owner adds no second default body. */
  readonly launch: LaunchRecipe;
  /** Required for a persistent context; the writer permit, not this owner, holds that authority. */
  readonly contextWriter?: ContextWriterPermit;
  readonly onCleanup?: (result: CleanupResult) => Effect.Effect<void>;
  readonly onAllocationUncertain?: (attempt: AllocationAttempt) => Effect.Effect<void>;
}

/** Allocates the session, and therefore owns releasing it. */
const providerControls = (
  client: BrowserbaseClient["Service"],
  sessions: BrowserbaseSessions["Service"],
  reference: SessionReference,
) => ({
  liveView: (ttl: number) => issueLiveView(client, reference, ttl),
  verifyReconnect: sessions.retrieve(reference).pipe(
    Effect.mapError((error) => browserRequestFailure("reconnect", error)),
    Effect.flatMap((status) =>
      status.status === "RUNNING"
        ? Effect.void
        : Effect.fail(
            BrowserError.make({
              operation: "reconnect",
              reason: Reasons.Expired.make({}),
              outcome: "undispatched",
            }),
          ),
    ),
  ),
});

export const ownedRemote =
  (
    options: OwnedOptions,
  ): RemoteSource<OwnedLease, AllocationError | BrowserError | ContextError> =>
  (local, lifetimeDeadline) =>
    Effect.gen(function* () {
      const client = yield* BrowserbaseClient;
      const sessions = yield* BrowserbaseSessions;

      const acquired = yield* acquireRemote(
        {
          launch: options.launch,
          ...(options.contextWriter === undefined ? {} : { contextWriter: options.contextWriter }),
          allocationDeadline: lifetimeDeadline,
          ...(options.onCleanup === undefined ? {} : { onCleanup: options.onCleanup }),
          ...(options.onAllocationUncertain === undefined
            ? {}
            : { onAllocationUncertain: options.onAllocationUncertain }),
        },
        local,
      );

      return {
        ...withConnection(acquired),
        ...providerControls(client, sessions, acquired.reference),
      };
    });

/** Borrows a running session: local connection only, and never a release request. */
export const borrowedRemote =
  (options: {
    readonly reference: SessionReference;
    readonly pendingWaitMillis?: number;
    readonly onCleanup?: (result: CleanupResult) => Effect.Effect<void>;
  }): RemoteSource<RemoteLease, SessionError> =>
  (local) =>
    Effect.gen(function* () {
      const client = yield* BrowserbaseClient;
      const sessions = yield* BrowserbaseSessions;
      const acquired = yield* attachRemote(options, local);

      return {
        ...withConnection(acquired),
        ...providerControls(client, sessions, acquired.reference),
      };
    });
