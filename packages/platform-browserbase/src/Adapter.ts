import { Context, Effect, Layer, Schema, type Scope } from "effect";
import {
  BrowserActionResult,
  BrowserNavigationResult,
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
import {
  BrowserbaseBrowser,
  type BoundTarget,
  type BrowserAcquisition,
  type BrowserbaseSession,
  type BrowserOptions,
} from "effect-browserbase/browser";
import type { CleanupResult } from "effect-browserbase/cleanup";
import type { BrowserbaseClient } from "effect-browserbase/client";
import type { AllocationError, ContextError, InitializationError } from "effect-browserbase/errors";
import { BrowserError } from "effect-browserbase/errors";
import type { AllocationAttempt, SessionReference } from "effect-browserbase/references";
import type { BrowserbaseSessions } from "effect-browserbase/sessions";

export const browserbaseInteractiveImplementation = SandboxImplementation.make({
  isolation: "isolated",
  identity: "browserbase-playwright-cdp",
});

/** Agent-facing configuration. The launch recipe and budgets stay the generic package's. */
export type InteractiveOptions = BrowserOptions;

/**
 * One owned browser presented to the Effect Agent runtime. `browser` keeps the generic
 * package's session authority — capture and page control are read from that exact object,
 * never from a copy — while `handle` is the framework's bounded action surface.
 */
export interface BrowserbaseAgentSession<E = never> {
  readonly reference: SessionReference;
  readonly browser: BrowserbaseSession<E>;
  readonly handle: BrowserHandle;
  readonly currentHandle: Effect.Effect<BrowserHandle, BrowserError>;
}

export interface BrowserbaseAgentAcquisition {
  readonly reference: SessionReference;
  readonly attempt: AllocationAttempt;
  readonly connect: Effect.Effect<BrowserbaseAgentSession, BrowserError | InitializationError>;
  readonly close: Effect.Effect<CleanupResult, BrowserError>;
}

const operationError = (
  operation: InteractiveBrowserActionError["operation"],
  error: BrowserError,
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

const decode = <A>(schema: Schema.Codec<A, unknown, never, never>, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(() =>
      BrowserError.make({ operation: "result", reason: "malformed", outcome: "unknown" }),
    ),
  );

const makeHandle = <E>(target: BoundTarget, session: BrowserbaseSession<E>): BrowserHandle => ({
  navigate: (request) =>
    target.navigate(request).pipe(
      Effect.flatMap((result) => decode(BrowserNavigationResult, { url: result.url })),
      Effect.mapError((error) => operationError("navigate", error)),
    ),
  readText: (request) =>
    target.readText(request).pipe(
      Effect.flatMap((result) => decode(BrowserTextResult, { text: result.text })),
      Effect.mapError((error) => operationError("read-text", error)),
    ),
  click: (request) =>
    target.click(request).pipe(
      Effect.flatMap((result) => decode(BrowserActionResult, { url: result.url })),
      Effect.mapError((error) => operationError("click", error)),
    ),
  fill: (request) =>
    target.fill(request).pipe(
      Effect.flatMap((result) => decode(BrowserActionResult, { url: result.url })),
      Effect.mapError((error) => operationError("fill", error)),
    ),
  scroll: (request) =>
    target.scroll(request).pipe(
      Effect.flatMap((result) => decode(BrowserActionResult, { url: result.url })),
      Effect.mapError((error) => operationError("scroll", error)),
    ),
  screenshot: (request) =>
    target.screenshot(request).pipe(
      Effect.flatMap((result) =>
        decode(PageScreenshotResult, {
          implementation: browserbaseInteractiveImplementation,
          mediaType: result.mediaType,
          bytes: result.bytes,
        }),
      ),
      Effect.mapError((error) => operationError("screenshot", error)),
    ),
  close: session.close.pipe(
    Effect.flatMap((result) =>
      result.remote === "confirmed"
        ? Effect.void
        : Effect.fail(
            BrowserError.make({ operation: "close", reason: "provider", outcome: "unknown" }),
          ),
    ),
    Effect.mapError((error) => operationError("close", error)),
  ),
});

/** Adapt this exact generic owner, preserving its callback diagnostics, action budget and capture authority. */
export const fromSession = <E>(browser: BrowserbaseSession<E>): BrowserbaseAgentSession<E> => ({
  reference: browser.reference,
  browser,
  handle: makeHandle(browser.bind(), browser),
  currentHandle: browser.target.pipe(Effect.map(() => makeHandle(browser.bind(), browser))),
});

/** Credentials, leases, and connection lifetime are fixed here, never selectable by a model. */
export class BrowserbaseInteractiveHost extends Context.Service<
  BrowserbaseInteractiveHost,
  {
    readonly acquire: (
      policy: InteractiveBrowserPolicy,
    ) => Effect.Effect<
      BrowserbaseAgentAcquisition,
      AllocationError | BrowserError | ContextError | InteractiveBrowserError,
      Scope.Scope
    >;
    readonly open: (
      policy: InteractiveBrowserPolicy,
    ) => Effect.Effect<
      BrowserbaseAgentSession,
      AllocationError | BrowserError | ContextError | InitializationError | InteractiveBrowserError,
      Scope.Scope
    >;
  }
>()("effect-agent-browserbase/BrowserbaseInteractiveHost") {
  static layer(
    options: InteractiveOptions,
  ): Layer.Layer<
    BrowserbaseInteractiveHost,
    BrowserError,
    BrowserbaseClient | BrowserbaseSessions
  > {
    return Layer.effect(
      BrowserbaseInteractiveHost,
      Effect.gen(function* () {
        const browser = yield* BrowserbaseBrowser;

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

          const acquired: BrowserAcquisition = yield* browser.acquire({
            network: { _tag: "Unrestricted" },
            maxActions: fixed.maxActions,
            maxElapsedMillis: fixed.maxElapsedMillis,
            maxReturnedBytes: fixed.maxReturnedBytes,
          });

          const connected = yield* Effect.cached(acquired.connect.pipe(Effect.map(fromSession)));

          return {
            reference: acquired.reference,
            attempt: acquired.attempt,
            close: acquired.close,
            connect: acquired.connect.pipe(Effect.andThen(connected)),
          } satisfies BrowserbaseAgentAcquisition;
        });

        return BrowserbaseInteractiveHost.of({
          acquire,
          open: (policy) => acquire(policy).pipe(Effect.flatMap((acquired) => acquired.connect)),
        });
      }),
    ).pipe(Layer.provideMerge(BrowserbaseBrowser.layer(options)));
  }
}

/** Provide the original InteractiveBrowser and host controls from one shared Layer. No allocation on build. */
export const browserbaseInteractiveLayer = (
  options: InteractiveOptions,
): Layer.Layer<
  InteractiveBrowser | BrowserbaseInteractiveHost,
  BrowserError,
  BrowserbaseClient | BrowserbaseSessions
> =>
  Layer.effect(
    InteractiveBrowser,
    Effect.gen(function* () {
      const host = yield* BrowserbaseInteractiveHost;

      return InteractiveBrowser.of({
        open: (policy) =>
          host.open(policy).pipe(
            Effect.map((session) => session.handle),
            Effect.mapError((error) =>
              error._tag === "BrowserError" ||
              error._tag === "AllocationError" ||
              error._tag === "ContextError"
                ? operationError(
                    "navigate",
                    error._tag === "BrowserError"
                      ? error
                      : BrowserError.make({
                          operation: "allocate",
                          reason:
                            error._tag === "AllocationError" && error.outcome === "unknown"
                              ? "allocation-unknown"
                              : error.reason,
                          outcome: error.outcome ?? "unknown",
                        }),
                  )
                : error._tag === "InitializationError"
                  ? InteractiveBrowserActionError.make({
                      implementation: browserbaseInteractiveImplementation,
                      operation: "navigate",
                      message: "Browser initialization failed",
                    })
                  : error,
            ),
          ),
      });
    }),
  ).pipe(Layer.provideMerge(BrowserbaseInteractiveHost.layer(options)));
