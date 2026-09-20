import { type Option, type Redacted, Context, Effect, Layer, Schema, type Scope } from "effect";
import {
  BrowserActionResult,
  BrowserClickRequest,
  BrowserFillRequest,
  BrowserNavigateRequest,
  BrowserNavigationResult,
  BrowserReadTextRequest,
  BrowserScreenshotRequest,
  BrowserScrollRequest,
  BrowserTextResult,
  InteractiveBrowser,
  InteractiveBrowserActionError,
  InteractiveBrowserBusyError,
  InteractiveBrowserExpiredError,
  InteractiveBrowserPolicy,
  InteractiveBrowserPolicyDeniedError,
  InteractiveBrowserProtocolError,
  InteractiveBrowserUnsupportedError,
  type BrowserHandle,
  type InteractiveBrowserError,
} from "effect-agent/interactive-browser";
import { PageScreenshotResult } from "effect-agent/page-screenshot";
import { SandboxImplementation } from "effect-agent/sandbox";

import { associate } from "./internal/Association.ts";
import { decode, httpOptions, makeHttp, type BrowserbaseOptions } from "./internal/Http.ts";
import { associatePageControl } from "./internal/PageControlAssociation.ts";
import { makeProvider } from "./internal/Provider.ts";
import {
  acquireSession,
  type BoundControls,
  type ContextLease,
  type SessionControls,
} from "./internal/Session.ts";
import type {
  AllocationAttempt,
  CleanupResult,
  FrameInfo,
  Observation,
  PageInfo,
  SessionReference,
  Target,
} from "./Types.ts";
import {
  BrowserbaseError,
  DownloadObservation,
  Identifier,
  ObservedElement,
  Viewport,
} from "./Types.ts";
export type { BrowserbaseOptions } from "./internal/Http.ts";
export type { ContextLease } from "./internal/Session.ts";

export const browserbaseInteractiveImplementation = SandboxImplementation.make({
  isolation: "isolated",
  identity: "browserbase-playwright-cdp",
});

export interface InteractiveOptions extends BrowserbaseOptions {
  /** Opt-in native lifecycle/focus ownership; incompatible with keepAlive and handoff-dependent pause policies. */
  readonly pageControl?: boolean;
  readonly actionTimeoutMillis?: number;
  readonly viewport?: Viewport;
  readonly initialPage?: { readonly targetId: string } | { readonly newPage: true };
  readonly maxPages?: number;
  readonly popupPolicy?: "retain" | "close" | "pause";
  readonly dialogPolicy?: "dismiss" | "pause";
  readonly recordSession?: boolean;
  readonly keepAlive?: boolean;
  readonly context?: { readonly id: string; readonly persist: boolean };
  /** Mandatory for persistent writers. The host must quarantine a lease after an unconfirmed close. */
  readonly contextLease?: (request: {
    readonly projectId: string;
    readonly contextId: string;
  }) => Effect.Effect<ContextLease, BrowserbaseError>;
  readonly onCleanup?: (result: CleanupResult) => Effect.Effect<void>;
  readonly onAllocationUncertain?: (attempt: AllocationAttempt) => Effect.Effect<void>;
}

export interface LiveView {
  readonly session: Redacted.Redacted<string>;
  readonly pages: ReadonlyArray<{
    readonly liveViewPageId: string;
    readonly url: Redacted.Redacted<string>;
  }>;
  readonly requestedTtlSeconds: number;
}

export interface Handoff {
  readonly token: Redacted.Redacted<string>;
  readonly view: LiveView;
}

export interface Resumed {
  readonly handle: BrowserHandle;
  readonly observation: Observation;
}

/** Host control is not a serializable Tool value. A selected page/frame change returns a new handle. */
export interface BrowserbaseSession {
  readonly reference: SessionReference;
  readonly handle: BrowserHandle;
  readonly currentHandle: Effect.Effect<BrowserHandle, BrowserbaseError>;
  readonly target: Effect.Effect<Target, BrowserbaseError>;
  readonly observe: (options?: {
    readonly maxTextBytes?: number;
    readonly maxControls?: number;
  }) => Effect.Effect<Observation, BrowserbaseError>;
  readonly clickElement: (
    reference: ObservedElement,
  ) => Effect.Effect<BrowserActionResult, BrowserbaseError>;
  readonly fillElement: (
    reference: ObservedElement,
    value: string,
  ) => Effect.Effect<BrowserActionResult, BrowserbaseError>;
  readonly pages: Effect.Effect<ReadonlyArray<PageInfo>, BrowserbaseError>;
  readonly frames: Effect.Effect<ReadonlyArray<FrameInfo>, BrowserbaseError>;
  readonly selectPage: (pageId: string) => Effect.Effect<BrowserHandle, BrowserbaseError>;
  readonly selectFrame: (frameId: string) => Effect.Effect<BrowserHandle, BrowserbaseError>;
  /** Create a tab without selecting it. */
  readonly createPage: Effect.Effect<string, BrowserbaseError>;
  readonly closePage: (pageId: string) => Effect.Effect<void, BrowserbaseError>;
  readonly resizeViewport: (viewport: Viewport) => Effect.Effect<void, BrowserbaseError>;
  readonly waitFor: (request: {
    readonly selector: string;
    readonly state: "visible" | "hidden" | "attached" | "detached";
  }) => Effect.Effect<void, BrowserbaseError>;
  /** Navigation observation is registered before the single click dispatch. */
  readonly clickAndWait: (
    request: BrowserClickRequest,
  ) => Effect.Effect<BrowserActionResult, BrowserbaseError>;
  readonly clickForDownload: (
    request: BrowserClickRequest,
  ) => Effect.Effect<DownloadObservation, BrowserbaseError>;
  readonly liveView: (expiresInSeconds?: number) => Effect.Effect<LiveView, BrowserbaseError>;
  readonly beginHandoff: (expiresInSeconds?: number) => Effect.Effect<Handoff, BrowserbaseError>;
  readonly resume: (
    token: Redacted.Redacted<string>,
    operatorReleasedControl: boolean,
  ) => Effect.Effect<Resumed, BrowserbaseError>;
  readonly detach: Effect.Effect<
    { readonly reference: SessionReference; readonly targetId: string },
    BrowserbaseError
  >;
  readonly reconnect: (
    operatorReleasedControl: boolean,
  ) => Effect.Effect<Resumed, BrowserbaseError>;
  readonly close: Effect.Effect<CleanupResult, BrowserbaseError>;
  readonly cleanupResult: Effect.Effect<Option.Option<CleanupResult>>;
}

export interface BrowserbaseAcquisition {
  readonly reference: SessionReference;
  readonly attempt: AllocationAttempt;
  readonly connect: Effect.Effect<BrowserbaseSession, BrowserbaseError>;
  readonly close: Effect.Effect<CleanupResult, BrowserbaseError>;
}

const operationError = (
  operation: InteractiveBrowserActionError["operation"],
  error: BrowserbaseError,
): InteractiveBrowserError => {
  const implementation = browserbaseInteractiveImplementation;

  switch (error.reason) {
    case "busy":
      return InteractiveBrowserBusyError.make({
        implementation,
        message: "Browser control is busy or handed to an operator",
      });
    case "closed":
    case "expired":
    case "disconnected":
    case "stale":
      return InteractiveBrowserExpiredError.make({
        implementation,
        message: "This browser handle or target is no longer usable",
      });
    case "configuration":
      return InteractiveBrowserPolicyDeniedError.make({
        implementation,
        message: "The browser request is malformed",
      });
    case "malformed":
      return InteractiveBrowserProtocolError.make({
        implementation,
        message: "The browser returned an invalid bounded result",
      });
    default:
      return InteractiveBrowserActionError.make({
        implementation,
        operation,
        message:
          error.outcome === "undispatched"
            ? "The browser action was not dispatched"
            : error.outcome === "rejected"
              ? "The browser action was rejected"
              : "The browser action failed; its outcome may be unknown",
      });
  }
};

const actionResult = (url: string) => decode(BrowserActionResult, { url }, "action-result");

const checked = <A>(
  schema: Schema.Codec<A, unknown, never, never>,
  value: unknown,
  operation: string,
) =>
  Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() =>
      BrowserbaseError.make({ operation, reason: "configuration", outcome: "undispatched" }),
    ),
  );

const makeHandle = (bound: BoundControls, controls: SessionControls): BrowserHandle => ({
  navigate: (request) =>
    checked(BrowserNavigateRequest, request, "navigate").pipe(
      Effect.flatMap((r) => bound.navigate(r.url)),
      Effect.flatMap((url) => decode(BrowserNavigationResult, { url }, "navigate")),
      Effect.mapError((error) => operationError("navigate", error)),
    ),
  readText: (request) =>
    checked(BrowserReadTextRequest, request, "read-text").pipe(
      Effect.flatMap((r) => bound.readText(r.selector)),
      Effect.flatMap((text) => decode(BrowserTextResult, { text }, "read-text")),
      Effect.mapError((error) => operationError("read-text", error)),
    ),
  click: (request) =>
    checked(BrowserClickRequest, request, "click").pipe(
      Effect.flatMap((r) => bound.click(r.selector)),
      Effect.flatMap(actionResult),
      Effect.mapError((error) => operationError("click", error)),
    ),
  fill: (request) =>
    checked(BrowserFillRequest, request, "fill").pipe(
      Effect.flatMap((r) => bound.fill(r.selector, r.value)),
      Effect.flatMap(actionResult),
      Effect.mapError((error) => operationError("fill", error)),
    ),
  scroll: (request) =>
    checked(BrowserScrollRequest, request, "scroll").pipe(
      Effect.flatMap((r) => bound.scroll(r.deltaX, r.deltaY)),
      Effect.flatMap(actionResult),
      Effect.mapError((error) => operationError("scroll", error)),
    ),
  screenshot: (request) =>
    checked(BrowserScreenshotRequest, request, "screenshot").pipe(
      Effect.flatMap((r) => bound.screenshot(r.fullPage)),
      Effect.flatMap((bytes) =>
        decode(
          PageScreenshotResult,
          {
            implementation: browserbaseInteractiveImplementation,
            mediaType: "image/png",
            bytes: new Uint8Array(bytes),
          },
          "screenshot",
        ),
      ),
      Effect.mapError((error) => operationError("screenshot", error)),
    ),
  close: controls.close.pipe(
    Effect.flatMap((result) =>
      result.remote === "confirmed"
        ? Effect.void
        : Effect.fail(
            BrowserbaseError.make({ operation: "close", reason: "provider", outcome: "unknown" }),
          ),
    ),
    Effect.mapError((error) => operationError("close", error)),
  ),
});

const makeSession = (controls: SessionControls): BrowserbaseSession => {
  const currentHandle = controls.currentTarget.pipe(
    Effect.map(() => makeHandle(controls.bind(), controls)),
  );

  const Wait = Schema.Struct({
    selector: BrowserClickRequest.fields.selector,
    state: Schema.Literals(["visible", "hidden", "attached", "detached"]),
  });

  const session: BrowserbaseSession = {
    reference: controls.reference,
    handle: makeHandle(controls.bind(), controls),
    currentHandle,
    target: controls.currentTarget,
    observe: (options = {}) => controls.observe(options.maxTextBytes, options.maxControls),
    clickElement: (reference) =>
      checked(ObservedElement, reference, "click").pipe(
        Effect.flatMap((r) => controls.bind().click(r)),
        Effect.flatMap(actionResult),
      ),
    fillElement: (reference, value) =>
      checked(ObservedElement, reference, "fill").pipe(
        Effect.flatMap((r) =>
          checked(BrowserFillRequest.fields.value, value, "fill").pipe(
            Effect.flatMap((v) => controls.bind().fill(r, v)),
          ),
        ),
        Effect.flatMap(actionResult),
      ),
    pages: controls.pages,
    frames: controls.frames,
    selectPage: (id) =>
      checked(Identifier, id, "select-page").pipe(
        Effect.flatMap(controls.selectPage),
        Effect.andThen(currentHandle),
      ),
    selectFrame: (id) =>
      checked(Identifier, id, "select-frame").pipe(
        Effect.flatMap(controls.selectFrame),
        Effect.andThen(currentHandle),
      ),
    createPage: controls.createPage(),
    closePage: (id) =>
      checked(Identifier, id, "close-page").pipe(Effect.flatMap(controls.closePage)),
    resizeViewport: (viewport) =>
      checked(Viewport, viewport, "resize").pipe(Effect.flatMap(controls.resize)),
    waitFor: (request) =>
      checked(Wait, request, "wait").pipe(
        Effect.flatMap((r) => controls.waitFor(r.selector, r.state)),
      ),
    clickAndWait: (request) =>
      checked(BrowserClickRequest, request, "click-and-wait").pipe(
        Effect.flatMap((r) => controls.clickAndWait(r.selector)),
        Effect.flatMap(actionResult),
      ),
    clickForDownload: (request) =>
      checked(BrowserClickRequest, request, "download-action").pipe(
        Effect.flatMap((r) => controls.clickForDownload(r.selector)),
        Effect.flatMap((raw) =>
          decode(DownloadObservation, { ...raw, reference: controls.reference }, "download-action"),
        ),
      ),
    liveView: (ttl = 60) => controls.liveView(ttl),
    beginHandoff: (ttl = 60) => controls.beginHandoff(ttl),
    resume: (token, released) =>
      controls.resume(token, released).pipe(
        Effect.map((observation) => ({
          observation,
          handle: makeHandle(controls.bind(), controls),
        })),
      ),
    detach: controls.detach,
    reconnect: (released) =>
      controls.reconnect(released).pipe(
        Effect.map((observation) => ({
          observation,
          handle: makeHandle(controls.bind(), controls),
        })),
      ),
    close: controls.close,
    cleanupResult: controls.cleanupResult,
  };

  associate(session, controls.capture);
  associatePageControl(session, controls.pageControl);

  return session;
};

/** Credentials, leases, and connection lifetime are fixed here, never selectable by a model. */
export class BrowserbaseInteractiveHost extends Context.Service<
  BrowserbaseInteractiveHost,
  {
    readonly acquire: (
      policy: InteractiveBrowserPolicy,
    ) => Effect.Effect<
      BrowserbaseAcquisition,
      BrowserbaseError | InteractiveBrowserError,
      Scope.Scope
    >;
    readonly open: (
      policy: InteractiveBrowserPolicy,
    ) => Effect.Effect<BrowserbaseSession, BrowserbaseError | InteractiveBrowserError, Scope.Scope>;
    readonly reconcile: (
      reference: SessionReference,
    ) => Effect.Effect<CleanupResult, BrowserbaseError>;
  }
>()("@effect-agent/platform-browserbase/BrowserbaseInteractiveHost") {
  static layer(options: InteractiveOptions) {
    return Layer.effect(
      this,
      Effect.gen(function* () {
        const http = yield* makeHttp(httpOptions(options));
        const provider = makeProvider(http, options.projectId);

        const viewport = yield* checked(
          Viewport,
          options.viewport ?? { width: 1280, height: 720 },
          "configure",
        );

        const actionTimeoutMillis = options.actionTimeoutMillis ?? 10000;
        const maxPages = options.maxPages ?? 10;

        if (
          !Number.isSafeInteger(actionTimeoutMillis) ||
          actionTimeoutMillis < 1 ||
          actionTimeoutMillis > 60000 ||
          !Number.isSafeInteger(maxPages) ||
          maxPages < 1 ||
          maxPages > 32
        ) {
          return yield* BrowserbaseError.make({ operation: "configure", reason: "configuration" });
        }

        const context =
          options.context === undefined
            ? undefined
            : yield* checked(
                Schema.Struct({ id: Identifier, persist: Schema.Boolean }),
                options.context,
                "configure",
              );

        if (context?.persist && options.contextLease === undefined)
          return yield* BrowserbaseError.make({ operation: "configure", reason: "context-lease" });

        const popupPolicy = yield* checked(
          Schema.Literals(["retain", "close", "pause"]),
          options.popupPolicy ?? "retain",
          "configure",
        );

        const dialogPolicy = yield* checked(
          Schema.Literals(["dismiss", "pause"]),
          options.dialogPolicy ?? "dismiss",
          "configure",
        );

        const initialPage =
          options.initialPage === undefined
            ? undefined
            : yield* checked(
                Schema.Union([
                  Schema.Struct({ targetId: Identifier }),
                  Schema.Struct({ newPage: Schema.Literal(true) }),
                ]),
                options.initialPage,
                "configure",
              );

        const pageControl = yield* checked(
          Schema.Boolean,
          options.pageControl ?? false,
          "configure",
        );

        const driver = {
          pageControl,
          viewport,
          maxPages,
          popupPolicy,
          dialogPolicy,
          ...(initialPage === undefined
            ? {}
            : "targetId" in initialPage
              ? { initialTargetId: initialPage.targetId }
              : { newPage: true }),
        };

        const recordSession = yield* checked(
          Schema.Boolean,
          options.recordSession ?? false,
          "configure",
        );

        const keepAlive = yield* checked(Schema.Boolean, options.keepAlive ?? false, "configure");

        if (pageControl && (keepAlive || popupPolicy === "pause" || dialogPolicy === "pause"))
          return yield* BrowserbaseError.make({
            operation: "configure",
            reason: "unsupported",
            outcome: "undispatched",
          });

        const settings = {
          viewport,
          driver,
          recordSession,
          keepAlive,
          ...(context === undefined ? {} : { context }),
          ...(options.contextLease === undefined ? {} : { contextLease: options.contextLease }),
          ...(options.onCleanup === undefined ? {} : { onCleanup: options.onCleanup }),
          ...(options.onAllocationUncertain === undefined
            ? {}
            : { onAllocationUncertain: options.onAllocationUncertain }),
        };

        const acquire = Effect.fnUntraced(function* (policy: InteractiveBrowserPolicy) {
          const fixed = yield* Schema.decodeEffect(InteractiveBrowserPolicy)(policy).pipe(
            Effect.mapError(() =>
              InteractiveBrowserPolicyDeniedError.make({
                implementation: browserbaseInteractiveImplementation,
                message: "The browser policy is malformed",
              }),
            ),
          );

          if (fixed.network._tag !== "Unrestricted")
            return yield* InteractiveBrowserUnsupportedError.make({
              implementation: browserbaseInteractiveImplementation,
              feature: "policy",
              message:
                fixed.network._tag === "PublicWeb"
                  ? "Browserbase does not establish connection-time public-address containment"
                  : "ExactHosts is not enabled: default-context setup, redirects, popups, and service-worker coverage are not proven",
            });

          const acquired = yield* acquireSession(
            provider,
            options.projectId,
            {
              maxActions: fixed.maxActions,
              maxElapsedMillis: fixed.maxElapsedMillis,
              actionTimeoutMillis,
            },
            { ...settings, maxReturnedBytes: fixed.maxReturnedBytes },
          );

          // One public session object is shared by repeated connect calls in this acquisition's scope.
          const connected = yield* Effect.cached(acquired.connect.pipe(Effect.map(makeSession)));

          return {
            reference: acquired.reference,
            attempt: acquired.attempt,
            close: acquired.close,
            connect: acquired.connect.pipe(Effect.andThen(connected)),
          };
        });

        return BrowserbaseInteractiveHost.of({
          acquire,
          open: (policy) => acquire(policy).pipe(Effect.flatMap((acquired) => acquired.connect)),
          reconcile: (reference) => provider.reconcile(reference),
        });
      }),
    );
  }
}

/** Provide the original InteractiveBrowser and host controls from one shared Layer. No allocation on build. */
export const browserbaseInteractiveLayer = (options: InteractiveOptions) =>
  Layer.effect(
    InteractiveBrowser,
    Effect.gen(function* () {
      const host = yield* BrowserbaseInteractiveHost;

      return InteractiveBrowser.of({
        open: (policy) =>
          host.open(policy).pipe(
            Effect.map((session) => session.handle),
            Effect.mapError((error) =>
              Schema.is(BrowserbaseError)(error) ? operationError("navigate", error) : error,
            ),
          ),
      });
    }),
  ).pipe(Layer.provideMerge(BrowserbaseInteractiveHost.layer(options)));
