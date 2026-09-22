import { Effect, type Option, Redacted, Schema, Scope } from "effect";

import * as Bootstrap from "./Bootstrap.ts";
import type { BrowserSession, OpenOptions } from "./Browser.ts";
import {
  ActionResult,
  AutomationOptions,
  BrowserPolicy,
  ClickRequest,
  Identifier,
  InlineFiles,
  type InlineFile,
  type Observation,
  SafeFilename,
  Selector,
  Viewport,
} from "./BrowserData.ts";
import {
  BrowserError,
  Reasons,
  type BrowserOperation,
  type InitializationError,
} from "./Errors.ts";
import {
  bindingImplementation,
  fromNativeAttempt,
  issueBinding,
} from "./internal/browser/Binding.ts";
import { makeBindings, preparePlan } from "./internal/browser/Bindings.ts";
import { compileBootstrap } from "./internal/browser/Bootstrap.ts";
import type { ConnectionCleanup } from "./internal/browser/ConnectionCleanup.ts";
import type { DriverOptions, NativeFileSelection } from "./internal/browser/Driver.ts";
import { connectPlaywrightEndpoint } from "./internal/browser/Playwright.ts";
import { checked, decoded, makeSession } from "./internal/browser/PublicSession.ts";
import { acquireSession } from "./internal/browser/Session.ts";

export {
  cleanupStep,
  noConnection,
  reported,
  type CleanupStep,
  type ConnectionCleanup,
  type ConnectionState,
} from "./internal/browser/ConnectionCleanup.ts";

/** Opaque engine configuration. Only this constructor's issued values can acquire a runtime. */
export interface BrowserBinding {
  readonly _tag: "BrowserBinding";
}

export interface PlaywrightOptions {
  /** A trusted integration validates its own endpoint authority before routing the connection. */
  readonly resolveEndpoint?: (connection: {
    readonly url: Redacted.Redacted<string>;
  }) => Effect.Effect<string, BrowserError>;
  /** Trusted instrumentation of the existing native connection, before the owner starts using it. */
  readonly onConnected?: (connection: {
    readonly native: unknown;
    readonly endpoint: string;
  }) => void;
}

/** A maintained Playwright connection, loaded lazily. No driver or protocol capability is returned. */
export const playwright = (options: PlaywrightOptions = {}): BrowserBinding => {
  const { resolveEndpoint, onConnected } = options;

  return issueBinding(
    { _tag: "BrowserBinding" as const },
    {
      connect: (request) =>
        Effect.gen(function* () {
          const address = yield* decoded(
            Schema.NonEmptyString.check(Schema.isMaxLength(16384)),
            "connect",
            "undispatched",
          )(request.connection);

          const endpoint =
            resolveEndpoint === undefined
              ? address
              : yield* resolveEndpoint({ url: Redacted.make(address) });

          return yield* fromNativeAttempt((attempt, signal) =>
            connectPlaywrightEndpoint(
              endpoint,
              signal,
              attempt.options,
              attempt.events,
              onConnected === undefined ? undefined : (native) => onConnected({ native, endpoint }),
            ),
          ).connect(request);
        }),
    },
  );
};

const defaultBinding = playwright();

/**
 * An integration owns endpoint authority and the meaning of release. Its source must register
 * release in the supplied Scope before returning; the runtime owns only the connection below it.
 */
export interface Lifetime {
  readonly reference: unknown;
  readonly connection: (
    remainingMillis: number,
  ) => Effect.Effect<Redacted.Redacted<string>, BrowserError>;
  readonly release: Effect.Effect<unknown>;
  readonly cleanupResult: Effect.Effect<Option.Option<unknown>>;
  readonly closeChecked: Effect.Effect<void, BrowserError>;
  /**
   * Memory-only evidence that canonical owned cleanup terminated native browser control.
   * Omission is unknown. Borrowed disconnection alone never establishes this fact.
   */
  readonly controlRetired?: Effect.Effect<boolean>;
  readonly verifyReconnect?: Effect.Effect<void, BrowserError>;
}

export type Source<L extends Lifetime, E, R = never> = (
  cleanup: ConnectionCleanup,
  lifetimeDeadline: number,
) => Effect.Effect<L, E, R | Scope.Scope>;

export interface RuntimeOptions {
  readonly implementation: string;
  readonly binding?: BrowserBinding;
  readonly automation?: AutomationOptions;
  readonly viewport?: Viewport;
  readonly preserveViewport?: boolean;
  readonly keepAlive?: boolean;
}

export interface AcquireOptions<E = never, R = never> extends OpenOptions<E, R> {
  /** Attach to an existing page without creating a tab or changing its viewport. */
  readonly existingTarget?: { readonly targetId?: string };
}

/**
 * Resolved host input for an integration constructing its own runtime. Stored paths must already
 * have been authorized by that integration; a session cannot recover these operations afterwards.
 */
export type ResolvedFileSelection =
  | { readonly _tag: "Inline"; readonly files: ReadonlyArray<InlineFile> }
  | { readonly _tag: "Stored"; readonly paths: ReadonlyArray<string> };

export interface FileRequest {
  readonly selector: string;
  readonly selection: ResolvedFileSelection;
}

export class DownloadEvent extends Schema.Class<DownloadEvent>("BrowserDownloadEvent")({
  downloadId: Identifier,
  filename: SafeFilename,
  state: Schema.Literals(["completed", "failed"]),
}) {}

/**
 * Modeled host operations for the integration creating this connection. Native authority stays
 * inside the owner; the integration adds only the capabilities its public session supports.
 */
export interface Integration<Reference> {
  readonly clickForDownload: (request: ClickRequest) => Effect.Effect<DownloadEvent, BrowserError>;
  readonly selectFiles: (request: FileRequest) => Effect.Effect<ActionResult, BrowserError>;
  readonly clickForFileSelection: (
    request: FileRequest,
  ) => Effect.Effect<ActionResult, BrowserError>;
  readonly liveView: <A>(issue: Effect.Effect<A, BrowserError>) => Effect.Effect<A, BrowserError>;
  readonly beginHandoff: <A>(
    issue: Effect.Effect<A, BrowserError>,
  ) => Effect.Effect<{ readonly token: Redacted.Redacted<string>; readonly view: A }, BrowserError>;
  readonly resume: (
    token: Redacted.Redacted<string>,
    operatorReleasedControl: boolean,
  ) => Effect.Effect<Observation, BrowserError>;
  readonly detach: Effect.Effect<
    { readonly reference: Reference; readonly targetId: string },
    BrowserError
  >;
  readonly reconnect: (
    operatorReleasedControl: boolean,
  ) => Effect.Effect<Observation, BrowserError | InitializationError>;
}

export interface Connection<Reference, E = never> {
  /** Preserve this object's identity when adding an integration's public capabilities. */
  readonly session: BrowserSession<E>;
  readonly operations: Integration<Reference>;
}

export interface Acquisition<L extends Lifetime, E = never> {
  readonly reference: L["reference"];
  readonly lifetime: L;
  readonly failure: Effect.Effect<never, E | InitializationError>;
  readonly close: L["release"];
  readonly connect: Effect.Effect<
    Connection<L["reference"], E>,
    BrowserError | InitializationError | E
  >;
}

export interface Runtime {
  readonly acquire: <L extends Lifetime, AE, AR, E = never, R = never>(
    policy: BrowserPolicy,
    source: Source<L, AE, AR>,
    request?: AcquireOptions<E, R>,
  ) => Effect.Effect<
    Acquisition<L, E>,
    AE | BrowserError,
    Scope.Scope | AR | Exclude<R, Scope.Scope>
  >;
}

const StoredPath = Schema.NonEmptyString.check(
  Schema.isMaxLength(4096),
  Schema.makeFilter(
    (value) =>
      value.startsWith("/") &&
      !value.includes("\\") &&
      !value.includes("//") &&
      ![...value].some((character) => character < " " || character === "\x7f") &&
      value.split("/").every((segment) => segment !== "." && segment !== ".."),
  ),
);

const Selection = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Inline"), files: InlineFiles }),
  Schema.Struct({
    _tag: Schema.Literal("Stored"),
    paths: Schema.Array(StoredPath).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  }),
]);

const resolveFiles = (
  selection: ResolvedFileSelection,
  operation: BrowserOperation,
): Effect.Effect<ReadonlyArray<NativeFileSelection>, BrowserError> =>
  checked(Selection, selection, operation).pipe(
    Effect.map((value) =>
      value._tag === "Inline"
        ? value.files.map((file) => ({
            _tag: "Inline" as const,
            name: file.name,
            mediaType: file.mediaType,
            bytes: new Uint8Array(file.bytes),
          }))
        : value.paths.map((path) => ({ _tag: "Remote" as const, path })),
    ),
  );

/** Validate immutable connection configuration without loading a peer or acquiring a lifetime. */
export const make = Effect.fnUntraced(function* (
  options: RuntimeOptions,
): Effect.fn.Return<Runtime, BrowserError> {
  const implementation = yield* checked(
    Schema.NonEmptyString.check(Schema.isMaxLength(128)),
    options.implementation,
    "configure",
  );

  const automation = yield* checked(AutomationOptions, options.automation ?? {}, "configure");

  const viewport = yield* checked(
    Viewport,
    options.viewport ?? { width: 1280, height: 720 },
    "configure",
  );

  const preserveViewport = yield* checked(
    Schema.Boolean,
    options.preserveViewport ?? false,
    "configure",
  );

  const keepAlive = yield* checked(Schema.Boolean, options.keepAlive ?? false, "configure");
  const engine = bindingImplementation(options.binding ?? defaultBinding);

  if (engine === undefined)
    return yield* BrowserError.make({
      operation: "connect",
      reason: Reasons.UnregisteredSession.make({}),
      outcome: "undispatched",
    });

  const pageControl = automation.pageControl ?? false;
  const popupPolicy = automation.popupPolicy ?? "retain";
  const dialogPolicy = automation.dialogPolicy ?? "dismiss";

  if (pageControl && (keepAlive || popupPolicy === "pause" || dialogPolicy === "pause"))
    return yield* BrowserError.make({
      operation: "configure",
      reason: Reasons.Unsupported.make({}),
      outcome: "undispatched",
    });

  const driver: DriverOptions = {
    viewport,
    pageControl,
    maxPages: automation.maxPages ?? 10,
    popupPolicy,
    dialogPolicy,
    preserveViewport,
    ...(automation.initialPage === undefined
      ? {}
      : "targetId" in automation.initialPage
        ? { initialTargetId: automation.initialPage.targetId }
        : { newPage: true }),
  };

  const acquire = Effect.fnUntraced(function* <L extends Lifetime, AE, AR, E = never, R = never>(
    policy: BrowserPolicy,
    source: Source<L, AE, AR>,
    request: AcquireOptions<E, R> = {},
  ) {
    const fixed = yield* checked(BrowserPolicy, policy, "configure");
    const plan = yield* preparePlan<E, R>(request.bootstrap ?? Bootstrap.empty);

    const existing =
      request.existingTarget === undefined
        ? undefined
        : yield* checked(
            Schema.Struct({ targetId: Schema.optionalKey(Identifier) }),
            request.existingTarget,
            "configure",
          );

    // Even a parent with parallel finalizers closes this connection before callback scopes end.
    const scope = yield* Scope.fork(yield* Scope.Scope, "sequential");
    const bindings = yield* makeBindings(plan).pipe(Scope.provide(scope));
    const bootstrap = compileBootstrap(plan);

    const connectionDriver: DriverOptions =
      existing === undefined
        ? driver
        : {
            viewport,
            pageControl,
            maxPages: driver.maxPages,
            popupPolicy,
            dialogPolicy,
            newPage: false,
            preserveViewport: true,
            ...(existing.targetId === undefined ? {} : { initialTargetId: existing.targetId }),
          };

    const acquired = yield* acquireSession(
      {
        maxActions: fixed.maxActions,
        maxElapsedMillis: fixed.maxElapsedMillis,
        actionTimeoutMillis: automation.actionTimeoutMillis ?? 10_000,
        maxHostReads: automation.maxHostReads ?? 10_000,
      },
      {
        implementation,
        remote: source,
        engine,
        keepAlive: existing === undefined && keepAlive,
        driver: { ...connectionDriver, ...(bootstrap === undefined ? {} : { bootstrap }) },
        connectBindings: bindings.connect,
        maxReturnedBytes: fixed.maxReturnedBytes,
      },
    ).pipe(Scope.provide(scope));

    const connected = yield* Effect.cached(
      acquired.connect.pipe(
        Effect.map((controls): Connection<L["reference"], E> => {
          const fileOperation = (
            operation: "select-files" | "file-chooser",
            request: FileRequest,
          ) =>
            checked(Selector, request.selector, operation).pipe(
              Effect.flatMap((selector) =>
                resolveFiles(request.selection, operation).pipe(
                  Effect.flatMap((files) =>
                    operation === "select-files"
                      ? controls.selectFiles(selector, files)
                      : controls.clickForFileSelection(selector, files),
                  ),
                ),
              ),
              Effect.flatMap((url) => decoded(ActionResult, "action-result", "unknown")({ url })),
            );

          return {
            session: makeSession(controls, bindings),
            operations: {
              clickForDownload: (request) =>
                checked(ClickRequest, request, "download-action").pipe(
                  Effect.flatMap((value) => controls.clickForDownload(value.selector)),
                  Effect.flatMap(decoded(DownloadEvent, "download-action", "unknown")),
                ),
              selectFiles: (request) => fileOperation("select-files", request),
              clickForFileSelection: (request) => fileOperation("file-chooser", request),
              liveView: controls.liveView,
              beginHandoff: controls.beginHandoff,
              resume: controls.resume,
              detach: controls.detach,
              reconnect: controls.reconnect,
            },
          };
        }),
      ),
    );

    return {
      reference: acquired.reference,
      lifetime: acquired.lease,
      failure: bindings.failure,
      close: acquired.close,
      connect: Effect.raceFirst(
        bindings.failure,
        acquired.connect.pipe(Effect.andThen(connected)),
      ).pipe(Effect.onError(() => acquired.close.pipe(Effect.asVoid))),
    } satisfies Acquisition<L, E>;
  });

  return { acquire } satisfies Runtime;
});
