import { Context, Effect, Layer, type Option, type Redacted, Schema, type Scope } from "effect";
import type { BrowserSession, OpenOptions } from "effect-browser/browser";
import type {
  ActionResult,
  AutomationOptions,
  BrowserPolicy,
  ClickRequest,
  Observation,
} from "effect-browser/browser-data";
import * as BrowserRuntime from "effect-browser/browser-runtime";
import {
  BrowserError,
  type BrowserOperation,
  type InitializationError,
} from "effect-browser/errors";

import { BrowserbaseBrowserBinding } from "./BrowserBinding.ts";
import type { CleanupResult } from "./Cleanup.ts";
import { BrowserbaseClient } from "./Client.ts";
import type { AllocationError, ContextError, SessionError } from "./Errors.ts";
import type { LiveView } from "./internal/browser/LiveView.ts";
import { borrowedRemote, ownedRemote, type RemoteLease } from "./internal/session/Browser.ts";
import type { ContextWriterPermit } from "./internal/session/WriterFacts.ts";
import { issuedUpload } from "./internal/upload/Issued.ts";
import type { LaunchRecipe } from "./Launch.ts";
import type { AllocationAttempt, SessionReference } from "./References.ts";
import { BrowserbaseSessions } from "./Sessions.ts";
import { DownloadObservation, type SelectFilesRequest } from "./Transfers.ts";

export type { LiveView } from "./internal/browser/LiveView.ts";
export type { FileSelection, SelectFilesRequest } from "./Transfers.ts";

/** Host configuration. Credentials live in the Client; a model never selects these values. */
export interface BrowserOptions extends AutomationOptions {
  readonly launch: LaunchRecipe;
  /** Required whenever the launch recipe persists a context. */
  readonly contextWriter?: ContextWriterPermit;
  readonly onCleanup?: (result: CleanupResult) => Effect.Effect<void>;
  readonly onAllocationUncertain?: (attempt: AllocationAttempt) => Effect.Effect<void>;
}

export interface Handoff {
  readonly token: Redacted.Redacted<string>;
  readonly view: LiveView;
}

/** Browserbase identity, remote artifacts and provider cleanup remain hosted capabilities. */
export interface BrowserbaseSession<E = never> extends BrowserSession<E> {
  readonly reference: SessionReference;
  readonly clickForDownload: (
    request: ClickRequest,
  ) => Effect.Effect<DownloadObservation, BrowserError>;
  /** Attaches to an existing file input; an uploaded branch needs a receipt for this session. */
  readonly selectFiles: (request: SelectFilesRequest) => Effect.Effect<ActionResult, BrowserError>;
  /** Registers the chooser observation before the single click that opens it. */
  readonly clickForFileSelection: (
    request: SelectFilesRequest,
  ) => Effect.Effect<ActionResult, BrowserError>;
  readonly liveView: (expiresInSeconds?: number) => Effect.Effect<LiveView, BrowserError>;
  readonly beginHandoff: (expiresInSeconds?: number) => Effect.Effect<Handoff, BrowserError>;
  readonly resume: (
    token: Redacted.Redacted<string>,
    operatorReleasedControl: boolean,
  ) => Effect.Effect<Observation, BrowserError>;
  readonly detach: Effect.Effect<
    { readonly reference: SessionReference; readonly targetId: string },
    BrowserError
  >;
  readonly reconnect: (
    operatorReleasedControl: boolean,
  ) => Effect.Effect<Observation, BrowserError | InitializationError>;
  readonly close: Effect.Effect<CleanupResult, BrowserError>;
  readonly cleanupResult: Effect.Effect<Option.Option<CleanupResult>>;
}

export interface AttachRequest<E = never, R = never> extends OpenOptions<E, R> {
  readonly policy: BrowserPolicy;
  /** The exact page to resume; without it the session must have exactly one page. */
  readonly target?: { readonly targetId: string };
  /** Bounded admission of a session the provider has not finished starting. */
  readonly pendingWaitMillis?: number;
}

export interface BrowserAcquisition<E = never> {
  readonly reference: SessionReference;
  readonly attempt: AllocationAttempt;
  readonly failure: Effect.Effect<never, E | InitializationError>;
  readonly connect: Effect.Effect<BrowserbaseSession<E>, BrowserError | E | InitializationError>;
  readonly close: Effect.Effect<CleanupResult, BrowserError>;
}

/** Only receipts issued for this exact provider session may resolve to stored paths. */
const selection = (
  request: SelectFilesRequest,
  reference: SessionReference,
  operation: BrowserOperation,
): Effect.Effect<BrowserRuntime.ResolvedFileSelection, BrowserError> =>
  Effect.suspend(() => {
    if (request.selection._tag === "Inline")
      return Effect.succeed<BrowserRuntime.ResolvedFileSelection>({
        _tag: "Inline",
        files: request.selection.files,
      });

    const uploads = request.selection.uploads;

    if (!Array.isArray(uploads) || uploads.length < 1 || uploads.length > 8)
      return Effect.fail(
        BrowserError.make({ operation, reason: "configuration", outcome: "undispatched" }),
      );
    const paths: string[] = [];

    for (const receipt of uploads) {
      const issued = issuedUpload(receipt);

      if (
        issued === undefined ||
        issued.reference.projectId !== reference.projectId ||
        issued.reference.sessionId !== reference.sessionId
      )
        return Effect.fail(
          BrowserError.make({ operation, reason: "authorization", outcome: "undispatched" }),
        );
      paths.push(issued.remotePath);
    }

    return Effect.succeed<BrowserRuntime.ResolvedFileSelection>({ _tag: "Stored", paths });
  });

const makeSession = <E>(
  connection: BrowserRuntime.Connection<SessionReference, E>,
  lifetime: RemoteLease,
): BrowserbaseSession<E> => {
  const { session, operations } = connection;

  // Decorating the same object preserves its private capture and page-control associations.
  return Object.assign(session, {
    reference: lifetime.reference,
    clickForDownload: (request) =>
      operations.clickForDownload(request).pipe(
        Effect.flatMap((event) =>
          Schema.decodeEffect(DownloadObservation)({
            ...event,
            reference: lifetime.reference,
          }).pipe(
            Effect.mapError(() =>
              BrowserError.make({ operation: "download-action", reason: "malformed" }),
            ),
          ),
        ),
      ),
    selectFiles: (request) =>
      selection(request, lifetime.reference, "select-files").pipe(
        Effect.flatMap((files) =>
          operations.selectFiles({ selector: request.selector, selection: files }),
        ),
      ),
    clickForFileSelection: (request) =>
      selection(request, lifetime.reference, "file-chooser").pipe(
        Effect.flatMap((files) =>
          operations.clickForFileSelection({ selector: request.selector, selection: files }),
        ),
      ),
    liveView: (ttl = 60) => operations.liveView(lifetime.liveView(ttl)),
    beginHandoff: (ttl = 60) => operations.beginHandoff(lifetime.liveView(ttl)),
    resume: operations.resume,
    detach: operations.detach,
    reconnect: operations.reconnect,
    close: lifetime.release,
    cleanupResult: lifetime.cleanupResult,
  } satisfies Omit<BrowserbaseSession<E>, keyof BrowserSession<E>>);
};

export class BrowserbaseBrowser extends Context.Service<
  BrowserbaseBrowser,
  {
    readonly acquire: <E = never, R = never>(
      policy: BrowserPolicy,
      request?: OpenOptions<E, R>,
    ) => Effect.Effect<
      BrowserAcquisition<E>,
      AllocationError | BrowserError | ContextError,
      Scope.Scope | Exclude<R, Scope.Scope>
    >;
    /** Borrowed control of a session this process did not allocate and will not release. */
    readonly attach: <E = never, R = never>(
      reference: SessionReference,
      request: AttachRequest<E, R>,
    ) => Effect.Effect<
      BrowserbaseSession<E>,
      BrowserError | SessionError | E | InitializationError,
      Scope.Scope | Exclude<R, Scope.Scope>
    >;
    readonly open: <E = never, R = never>(
      policy: BrowserPolicy,
      request?: OpenOptions<E, R>,
    ) => Effect.Effect<
      BrowserbaseSession<E>,
      AllocationError | BrowserError | ContextError | E | InitializationError,
      Scope.Scope | Exclude<R, Scope.Scope>
    >;
    /** Race the consumer with typed callback failure and confirm cleanup before normal success. */
    readonly withBrowser: <E = never, R = never, A = unknown, E2 = never, R2 = never>(
      policy: BrowserPolicy,
      request: OpenOptions<E, R>,
      use: (session: BrowserbaseSession<E>) => Effect.Effect<A, E2, R2>,
    ) => Effect.Effect<
      A,
      AllocationError | BrowserError | ContextError | InitializationError | E | E2,
      Exclude<R | R2, Scope.Scope>
    >;
  }
>()("effect-browserbase/Browser") {
  static layer(
    options: BrowserOptions,
  ): Layer.Layer<BrowserbaseBrowser, BrowserError, BrowserbaseClient | BrowserbaseSessions> {
    return Layer.effect(
      BrowserbaseBrowser,
      Effect.gen(function* () {
        const client = yield* BrowserbaseClient;
        const sessions = yield* BrowserbaseSessions;
        const binding = yield* BrowserbaseBrowserBinding;

        if (options.launch.context?.persist === true && options.contextWriter === undefined)
          return yield* BrowserError.make({ operation: "configure", reason: "context-lease" });
        if (Object.prototype.hasOwnProperty.call(options, "bootstrap"))
          return yield* BrowserError.make({
            operation: "configure",
            reason: "configuration",
            outcome: "undispatched",
          });

        const runtime = yield* BrowserRuntime.make({
          implementation: "browserbase-playwright-cdp",
          binding,
          automation: projected(options),
          viewport:
            options.launch.viewport._tag === "Fixed"
              ? { width: options.launch.viewport.width, height: options.launch.viewport.height }
              : { width: 1280, height: 720 },
          preserveViewport: options.launch.viewport._tag !== "Fixed",
          keepAlive: options.launch.keepAlive === true,
        });

        const source =
          <L extends BrowserRuntime.Lifetime, E>(
            remote: BrowserRuntime.Source<L, E, BrowserbaseClient | BrowserbaseSessions>,
          ): BrowserRuntime.Source<L, E> =>
          (cleanup, deadline) =>
            remote(cleanup, deadline).pipe(
              Effect.provideService(BrowserbaseClient, client),
              Effect.provideService(BrowserbaseSessions, sessions),
            );

        const acquire = Effect.fnUntraced(function* <E = never, R = never>(
          policy: BrowserPolicy,
          request: OpenOptions<E, R> = {},
        ) {
          const acquired = yield* runtime.acquire(
            policy,
            source(
              ownedRemote({
                launch: options.launch,
                ...(options.contextWriter === undefined
                  ? {}
                  : { contextWriter: options.contextWriter }),
                ...(options.onCleanup === undefined ? {} : { onCleanup: options.onCleanup }),
                ...(options.onAllocationUncertain === undefined
                  ? {}
                  : { onAllocationUncertain: options.onAllocationUncertain }),
              }),
            ),
            request,
          );

          const connected = yield* Effect.cached(
            acquired.connect.pipe(
              Effect.map((connection) => makeSession(connection, acquired.lifetime)),
            ),
          );

          return {
            reference: acquired.reference,
            attempt: acquired.lifetime.attempt,
            failure: acquired.failure,
            close: acquired.close,
            connect: acquired.connect.pipe(Effect.andThen(connected)),
          } satisfies BrowserAcquisition<E>;
        });

        const attach = Effect.fnUntraced(function* <E = never, R = never>(
          reference: SessionReference,
          request: AttachRequest<E, R>,
        ) {
          const acquired = yield* runtime.acquire(
            request.policy,
            source(
              borrowedRemote({
                reference,
                ...(request.pendingWaitMillis === undefined
                  ? {}
                  : { pendingWaitMillis: request.pendingWaitMillis }),
                ...(options.onCleanup === undefined ? {} : { onCleanup: options.onCleanup }),
              }),
            ),
            {
              ...(request.bootstrap === undefined ? {} : { bootstrap: request.bootstrap }),
              existingTarget: request.target ?? {},
            },
          );

          return yield* acquired.connect.pipe(
            Effect.map((connection) => makeSession(connection, acquired.lifetime)),
          );
        });

        return BrowserbaseBrowser.of({
          acquire,
          attach,
          open: (policy, request) =>
            acquire(policy, request).pipe(Effect.flatMap((acquired) => acquired.connect)),
          withBrowser: (policy, request, use) =>
            BrowserRuntime.withBrowser(
              acquire(policy, request).pipe(Effect.flatMap((acquired) => acquired.connect)),
              use,
            ),
        });
      }),
    );
  }
}

/** Only the automation fields cross the schema boundary; launch and callbacks are separate. */
const projected = (options: BrowserOptions) => ({
  ...(options.actionTimeoutMillis === undefined
    ? {}
    : { actionTimeoutMillis: options.actionTimeoutMillis }),
  ...(options.maxPages === undefined ? {} : { maxPages: options.maxPages }),
  ...(options.initialPage === undefined ? {} : { initialPage: options.initialPage }),
  ...(options.popupPolicy === undefined ? {} : { popupPolicy: options.popupPolicy }),
  ...(options.dialogPolicy === undefined ? {} : { dialogPolicy: options.dialogPolicy }),
  ...(options.pageControl === undefined ? {} : { pageControl: options.pageControl }),
});
