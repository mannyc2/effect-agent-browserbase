import { Context, Effect, Layer, Schema, Scope } from "effect";
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
import type { BoundTarget, BrowserSession } from "effect-browser/browser";
import { BrowserPolicy } from "effect-browser/browser-data";
import { BrowserError } from "effect-browser/errors";

/**
 * One owned browser presented to the Effect Agent runtime. `browser` keeps the generic
 * package's session authority — capture and page control are read from that exact object,
 * never from a copy — while `handle` is the framework's bounded action surface.
 */
export interface AgentSession<E = never> {
  readonly browser: BrowserSession<E>;
  readonly handle: BrowserHandle;
  readonly currentHandle: Effect.Effect<BrowserHandle, BrowserError>;
}

/** Retains the concrete owner's reference, capabilities and callback errors. */
export interface AdaptedSession<S extends BrowserSession<unknown>> {
  readonly browser: S;
  readonly handle: BrowserHandle;
  readonly currentHandle: Effect.Effect<BrowserHandle, BrowserError>;
}

interface Failure {
  readonly reason: BrowserError["reason"];
  readonly outcome?: BrowserError["outcome"];
}

const operationError = (
  operation: InteractiveBrowserActionError["operation"],
  error: Failure,
  implementation: SandboxImplementation,
): InteractiveBrowserError => {
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
    Effect.mapError((): Failure => ({ reason: "malformed", outcome: "unknown" })),
  );

const makeHandle = (
  target: BoundTarget,
  close: Effect.Effect<void, BrowserError>,
  implementation: SandboxImplementation,
): BrowserHandle => ({
  navigate: (request) =>
    target.navigate(request).pipe(
      Effect.flatMap((result) => decode(BrowserNavigationResult, { url: result.url })),
      Effect.mapError((error) => operationError("navigate", error, implementation)),
    ),
  readText: (request) =>
    target.readText(request).pipe(
      Effect.flatMap((result) => decode(BrowserTextResult, { text: result.text })),
      Effect.mapError((error) => operationError("read-text", error, implementation)),
    ),
  click: (request) =>
    target.click(request).pipe(
      Effect.flatMap((result) => decode(BrowserActionResult, { url: result.url })),
      Effect.mapError((error) => operationError("click", error, implementation)),
    ),
  fill: (request) =>
    target.fill(request).pipe(
      Effect.flatMap((result) => decode(BrowserActionResult, { url: result.url })),
      Effect.mapError((error) => operationError("fill", error, implementation)),
    ),
  scroll: (request) =>
    target.scroll(request).pipe(
      Effect.flatMap((result) => decode(BrowserActionResult, { url: result.url })),
      Effect.mapError((error) => operationError("scroll", error, implementation)),
    ),
  screenshot: (request) =>
    target.screenshot(request).pipe(
      Effect.flatMap((result) =>
        decode(PageScreenshotResult, {
          implementation,
          mediaType: result.mediaType,
          bytes: result.bytes,
        }),
      ),
      Effect.mapError((error) => operationError("screenshot", error, implementation)),
    ),
  close: close.pipe(Effect.mapError((error) => operationError("close", error, implementation))),
});

/** Adapt the exact owner; no acquisition, connection, receipt interpretation or session copying. */
export const fromSession = <S extends BrowserSession<unknown>>(browser: S): AdaptedSession<S> => {
  const implementation = SandboxImplementation.make({
    isolation: "isolated",
    identity: browser.implementation,
  });

  return {
    browser,
    handle: makeHandle(browser.bind(), browser.closeChecked, implementation),
    currentHandle: browser.currentTarget.pipe(
      Effect.map((target) => makeHandle(target, browser.closeChecked, implementation)),
    ),
  };
};

/** The host selects acquisition; the same framework implementation supports every browser owner. */
export interface InteractiveOptions<E = never, R = never> {
  readonly implementation: string;
  readonly open: (
    policy: BrowserPolicy,
  ) => Effect.Effect<BrowserSession<unknown>, E, R | Scope.Scope>;
}

/**
 * Capture the opener's services at Layer construction, but use each caller's execution Scope.
 * Expected acquisition errors are sanitized for the framework. Hosts that need the original
 * acquisition/callback errors use their owner directly and adapt it through fromSession.
 */
export const interactiveLayer = <E, R>(
  options: InteractiveOptions<E, R>,
): Layer.Layer<InteractiveBrowser, never, Exclude<R, Scope.Scope>> =>
  Layer.effect(
    InteractiveBrowser,
    Effect.gen(function* () {
      const context = yield* Effect.context<R | Scope.Scope>();
      const open = options.open;

      const implementation = SandboxImplementation.make({
        isolation: "isolated",
        identity: options.implementation,
      });

      return InteractiveBrowser.of({
        open: (policy) =>
          Effect.gen(function* () {
            const scope = yield* Scope.Scope;

            const fixed = yield* Schema.decodeEffect(InteractiveBrowserPolicy)(policy).pipe(
              Effect.mapError(() =>
                InteractiveBrowserPolicyDeniedError.make({
                  implementation,
                  message: "The browser policy is malformed",
                }),
              ),
            );

            if (fixed.network._tag !== "Unrestricted")
              return yield* InteractiveBrowserUnsupportedError.make({
                implementation,
                feature: "policy",
                message:
                  "This browser integration does not establish the requested network containment",
              });

            const browser = yield* Effect.suspend(() =>
              open(
                BrowserPolicy.make({
                  network: { _tag: "Unrestricted" },
                  maxActions: fixed.maxActions,
                  maxElapsedMillis: fixed.maxElapsedMillis,
                  maxReturnedBytes: fixed.maxReturnedBytes,
                }),
              ),
            ).pipe(
              Effect.provideContext(Context.add(context, Scope.Scope, scope)),
              Effect.mapError((error) =>
                Schema.is(BrowserError)(error)
                  ? operationError("navigate", error, implementation)
                  : InteractiveBrowserActionError.make({
                      implementation,
                      operation: "navigate",
                      message:
                        "Browser acquisition or initialization failed; its outcome may be unknown",
                    }),
              ),
            );

            return fromSession(browser).handle;
          }),
      });
    }),
  );
