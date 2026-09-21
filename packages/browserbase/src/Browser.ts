import { Context, Effect, Layer, type Option, type Redacted, Schema, type Scope } from "effect";

import {
  ActionResult,
  AutomationOptions,
  BrowserPolicy,
  ClickRequest,
  FillRequest,
  type FrameInfo,
  NavigateRequest,
  NavigationResult,
  type Observation,
  ObservedElement,
  type PageInfo,
  ReadTextRequest,
  ScreenshotRequest,
  ScreenshotResult,
  ScrollRequest,
  type Target,
  TextResult,
  Viewport,
} from "./BrowserData.ts";
import type { CleanupResult } from "./Cleanup.ts";
import { BrowserbaseClient } from "./Client.ts";
import { type AllocationError, BrowserError, type ContextError } from "./Errors.ts";
import { associate } from "./internal/browser/Association.ts";
import type { LiveView } from "./internal/browser/LiveView.ts";
import { associatePageControl } from "./internal/browser/PageControlAssociation.ts";
import {
  acquireSession,
  type BoundControls,
  type SessionControls,
} from "./internal/browser/Session.ts";
import type { ContextWriterPermit } from "./internal/session/WriterFacts.ts";
import type { LaunchRecipe } from "./Launch.ts";
import { Identifier, type AllocationAttempt, type SessionReference } from "./References.ts";
import { BrowserbaseSessions } from "./Sessions.ts";
import { DownloadObservation } from "./Transfers.ts";

export type { LiveView } from "./internal/browser/LiveView.ts";

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

/** One selected page and frame at one connection generation, never the current DOM. */
export interface BoundTarget {
  readonly navigate: (request: NavigateRequest) => Effect.Effect<NavigationResult, BrowserError>;
  readonly readText: (request: ReadTextRequest) => Effect.Effect<TextResult, BrowserError>;
  readonly click: (request: ClickRequest) => Effect.Effect<ActionResult, BrowserError>;
  readonly fill: (request: FillRequest) => Effect.Effect<ActionResult, BrowserError>;
  readonly scroll: (request: ScrollRequest) => Effect.Effect<ActionResult, BrowserError>;
  readonly screenshot: (
    request: ScreenshotRequest,
  ) => Effect.Effect<ScreenshotResult, BrowserError>;
}

/**
 * Host control over one owned browser. This is not a serializable model value: copying a
 * session object cannot copy its capture, page-control or connection authority.
 */
export interface BrowserbaseSession {
  readonly reference: SessionReference;
  readonly bind: () => BoundTarget;
  /** Re-reads the live selection first, so a stale generation fails before any dispatch. */
  readonly currentTarget: Effect.Effect<BoundTarget, BrowserError>;
  readonly target: Effect.Effect<Target, BrowserError>;
  readonly observe: (options?: {
    readonly maxTextBytes?: number;
    readonly maxControls?: number;
  }) => Effect.Effect<Observation, BrowserError>;
  readonly clickElement: (reference: ObservedElement) => Effect.Effect<ActionResult, BrowserError>;
  readonly fillElement: (
    reference: ObservedElement,
    value: string,
  ) => Effect.Effect<ActionResult, BrowserError>;
  readonly pages: Effect.Effect<ReadonlyArray<PageInfo>, BrowserError>;
  readonly frames: Effect.Effect<ReadonlyArray<FrameInfo>, BrowserError>;
  readonly selectPage: (pageId: string) => Effect.Effect<BoundTarget, BrowserError>;
  readonly selectFrame: (frameId: string) => Effect.Effect<BoundTarget, BrowserError>;
  /** Create a tab without selecting it. */
  readonly createPage: Effect.Effect<string, BrowserError>;
  readonly closePage: (pageId: string) => Effect.Effect<void, BrowserError>;
  readonly resizeViewport: (viewport: Viewport) => Effect.Effect<void, BrowserError>;
  readonly waitFor: (request: {
    readonly selector: string;
    readonly state: "visible" | "hidden" | "attached" | "detached";
  }) => Effect.Effect<void, BrowserError>;
  /** Navigation observation is registered before the single click dispatch. */
  readonly clickAndWait: (request: ClickRequest) => Effect.Effect<ActionResult, BrowserError>;
  readonly clickForDownload: (
    request: ClickRequest,
  ) => Effect.Effect<DownloadObservation, BrowserError>;
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
  ) => Effect.Effect<Observation, BrowserError>;
  readonly close: Effect.Effect<CleanupResult, BrowserError>;
  readonly cleanupResult: Effect.Effect<Option.Option<CleanupResult>>;
}

export interface BrowserAcquisition {
  readonly reference: SessionReference;
  readonly attempt: AllocationAttempt;
  readonly connect: Effect.Effect<BrowserbaseSession, BrowserError>;
  readonly close: Effect.Effect<CleanupResult, BrowserError>;
}

const checked = <A>(
  schema: Schema.Codec<A, unknown, never, never>,
  value: unknown,
  operation: string,
) =>
  Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() =>
      BrowserError.make({ operation, reason: "configuration", outcome: "undispatched" }),
    ),
  );

const decoded =
  <A>(schema: Schema.Codec<A, unknown, never, never>, operation: string) =>
  (value: unknown) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError(() => BrowserError.make({ operation, reason: "malformed" })),
    );

const action = decoded(ActionResult, "action-result");

const makeTarget = (bound: BoundControls): BoundTarget => ({
  navigate: (request) =>
    checked(NavigateRequest, request, "navigate").pipe(
      Effect.flatMap((value) => bound.navigate(value.url)),
      Effect.flatMap(decoded(NavigationResult, "navigate")),
    ),
  readText: (request) =>
    checked(ReadTextRequest, request, "read-text").pipe(
      Effect.flatMap((value) => bound.readText(value.selector)),
      Effect.flatMap((text) => decoded(TextResult, "read-text")({ text })),
    ),
  click: (request) =>
    checked(ClickRequest, request, "click").pipe(
      Effect.flatMap((value) => bound.click(value.selector)),
      Effect.flatMap((url) => action({ url })),
    ),
  fill: (request) =>
    checked(FillRequest, request, "fill").pipe(
      Effect.flatMap((value) => bound.fill(value.selector, value.value)),
      Effect.flatMap((url) => action({ url })),
    ),
  scroll: (request) =>
    checked(ScrollRequest, request, "scroll").pipe(
      Effect.flatMap((value) => bound.scroll(value.deltaX, value.deltaY)),
      Effect.flatMap((url) => action({ url })),
    ),
  screenshot: (request) =>
    checked(ScreenshotRequest, request, "screenshot").pipe(
      Effect.flatMap((value) => bound.screenshot(value.fullPage)),
      Effect.flatMap((bytes) =>
        decoded(
          ScreenshotResult,
          "screenshot",
        )({ mediaType: "image/png", bytes: new Uint8Array(bytes) }),
      ),
    ),
});

const makeSession = (controls: SessionControls): BrowserbaseSession => {
  const currentTarget = controls.currentTarget.pipe(Effect.map(() => makeTarget(controls.bind())));

  const Wait = Schema.Struct({
    selector: ClickRequest.fields.selector,
    state: Schema.Literals(["visible", "hidden", "attached", "detached"]),
  });

  const navigate = (url: string) => action({ url });

  const session: BrowserbaseSession = {
    reference: controls.reference,
    bind: () => makeTarget(controls.bind()),
    currentTarget,
    target: controls.currentTarget,
    observe: (options = {}) => controls.observe(options.maxTextBytes, options.maxControls),
    clickElement: (reference) =>
      checked(ObservedElement, reference, "click").pipe(
        Effect.flatMap((value) => controls.bind().click(value)),
        Effect.flatMap(navigate),
      ),
    fillElement: (reference, value) =>
      checked(ObservedElement, reference, "fill").pipe(
        Effect.flatMap((element) =>
          checked(FillRequest.fields.value, value, "fill").pipe(
            Effect.flatMap((text) => controls.bind().fill(element, text)),
          ),
        ),
        Effect.flatMap(navigate),
      ),
    pages: controls.pages,
    frames: controls.frames,
    selectPage: (id) =>
      checked(Identifier, id, "select-page").pipe(
        Effect.flatMap(controls.selectPage),
        Effect.andThen(currentTarget),
      ),
    selectFrame: (id) =>
      checked(Identifier, id, "select-frame").pipe(
        Effect.flatMap(controls.selectFrame),
        Effect.andThen(currentTarget),
      ),
    createPage: controls.createPage(),
    closePage: (id) =>
      checked(Identifier, id, "close-page").pipe(Effect.flatMap(controls.closePage)),
    resizeViewport: (viewport) =>
      checked(Viewport, viewport, "resize").pipe(Effect.flatMap(controls.resize)),
    waitFor: (request) =>
      checked(Wait, request, "wait").pipe(
        Effect.flatMap((value) => controls.waitFor(value.selector, value.state)),
      ),
    clickAndWait: (request) =>
      checked(ClickRequest, request, "click-and-wait").pipe(
        Effect.flatMap((value) => controls.clickAndWait(value.selector)),
        Effect.flatMap((url) => action({ url })),
      ),
    clickForDownload: (request) =>
      checked(ClickRequest, request, "download-action").pipe(
        Effect.flatMap((value) => controls.clickForDownload(value.selector)),
        Effect.flatMap((raw) =>
          decoded(
            DownloadObservation,
            "download-action",
          )({ ...raw, reference: controls.reference }),
        ),
      ),
    liveView: (ttl = 60) => controls.liveView(ttl),
    beginHandoff: (ttl = 60) => controls.beginHandoff(ttl),
    resume: (token, released) => controls.resume(token, released),
    detach: controls.detach,
    reconnect: (released) => controls.reconnect(released),
    close: controls.close,
    cleanupResult: controls.cleanupResult,
  };

  associate(session, controls.capture);
  associatePageControl(session, controls.pageControl);

  return session;
};

/**
 * Credentials, budgets and connection lifetime are fixed when this Layer is built. Building it
 * allocates nothing and loads no native peer; every acquisition is scoped by its caller.
 */
export class BrowserbaseBrowser extends Context.Service<
  BrowserbaseBrowser,
  {
    readonly acquire: (
      policy: BrowserPolicy,
    ) => Effect.Effect<
      BrowserAcquisition,
      AllocationError | BrowserError | ContextError,
      Scope.Scope
    >;
    readonly open: (
      policy: BrowserPolicy,
    ) => Effect.Effect<
      BrowserbaseSession,
      AllocationError | BrowserError | ContextError,
      Scope.Scope
    >;
  }
>()("@effect-agent/browserbase/Browser") {
  static layer(
    options: BrowserOptions,
  ): Layer.Layer<BrowserbaseBrowser, BrowserError, BrowserbaseClient | BrowserbaseSessions> {
    return Layer.effect(
      BrowserbaseBrowser,
      Effect.gen(function* () {
        const client = yield* BrowserbaseClient;
        const sessions = yield* BrowserbaseSessions;
        const automation = yield* checked(AutomationOptions, projected(options), "configure");

        const viewport = yield* checked(
          Viewport,
          options.launch.viewport._tag === "Fixed"
            ? { width: options.launch.viewport.width, height: options.launch.viewport.height }
            : { width: 1280, height: 720 },
          "configure",
        );

        const actionTimeoutMillis = automation.actionTimeoutMillis ?? 10_000;
        const maxPages = automation.maxPages ?? 10;
        const pageControl = automation.pageControl ?? false;
        const popupPolicy = automation.popupPolicy ?? "retain";
        const dialogPolicy = automation.dialogPolicy ?? "dismiss";

        if (
          pageControl &&
          (options.launch.keepAlive === true || popupPolicy === "pause" || dialogPolicy === "pause")
        )
          return yield* BrowserError.make({
            operation: "configure",
            reason: "unsupported",
            outcome: "undispatched",
          });

        if (options.launch.context?.persist === true && options.contextWriter === undefined)
          return yield* BrowserError.make({ operation: "configure", reason: "context-lease" });

        const driver = {
          pageControl,
          viewport,
          maxPages,
          popupPolicy,
          dialogPolicy,
          ...(automation.initialPage === undefined
            ? {}
            : "targetId" in automation.initialPage
              ? { initialTargetId: automation.initialPage.targetId }
              : { newPage: true }),
        };

        const acquire = Effect.fnUntraced(function* (policy: BrowserPolicy) {
          const fixed = yield* checked(BrowserPolicy, policy, "configure");

          const acquired = yield* acquireSession(
            {
              maxActions: fixed.maxActions,
              maxElapsedMillis: fixed.maxElapsedMillis,
              actionTimeoutMillis,
            },
            {
              launch: options.launch,
              driver,
              maxReturnedBytes: fixed.maxReturnedBytes,
              ...(options.contextWriter === undefined
                ? {}
                : { contextWriter: options.contextWriter }),
              ...(options.onCleanup === undefined ? {} : { onCleanup: options.onCleanup }),
              ...(options.onAllocationUncertain === undefined
                ? {}
                : { onAllocationUncertain: options.onAllocationUncertain }),
            },
          ).pipe(
            // The Layer owns the one account and resource service; acquisition never re-resolves them.
            Effect.provideService(BrowserbaseClient, client),
            Effect.provideService(BrowserbaseSessions, sessions),
          );

          // One public session object is shared by repeated connect calls in this scope.
          const connected = yield* Effect.cached(acquired.connect.pipe(Effect.map(makeSession)));

          return {
            reference: acquired.reference,
            attempt: acquired.attempt,
            close: acquired.close,
            connect: acquired.connect.pipe(Effect.andThen(connected)),
          } satisfies BrowserAcquisition;
        });

        return BrowserbaseBrowser.of({
          acquire,
          open: (policy) => acquire(policy).pipe(Effect.flatMap((acquired) => acquired.connect)),
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
