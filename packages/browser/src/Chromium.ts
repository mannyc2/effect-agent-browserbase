import { Context, Crypto, Effect, Layer, type Option, Redacted, type Scope } from "effect";

import type { BrowserSession, OpenOptions } from "./Browser.ts";
import type { AutomationOptions, BrowserPolicy, Viewport } from "./BrowserData.ts";
import * as BrowserRuntime from "./BrowserRuntime.ts";
import { BrowserError, Reasons, type InitializationError } from "./Errors.ts";
import { checked } from "./internal/browser/PublicSession.ts";
import {
  ChromiumEndpoint,
  ChromiumLaunch,
  type ChromiumCleanupResult,
  type ChromiumReference,
} from "./internal/chromium/Data.ts";
import { borrowedChromium, ownedChromium } from "./internal/chromium/Session.ts";

export {
  ChromiumCleanupIssue,
  ChromiumCleanupResult,
  ChromiumLaunch,
  ChromiumReference,
} from "./internal/chromium/Data.ts";

/** Host-only process configuration. Building this layer neither loads Playwright nor starts Chromium. */
export interface ChromiumOptions extends AutomationOptions {
  readonly launch?: ChromiumLaunch;
  readonly viewport?: Viewport;
  readonly onCleanup?: (result: ChromiumCleanupResult) => Effect.Effect<void>;
}

/** An owned or borrowed Chromium lifetime with one modeled browser connection. */
export interface ChromiumSession<E = never> extends BrowserSession<E> {
  readonly reference: ChromiumReference;
  readonly closeChecked: Effect.Effect<ChromiumCleanupResult, BrowserError>;
  readonly close: Effect.Effect<ChromiumCleanupResult>;
  readonly cleanupResult: Effect.Effect<Option.Option<ChromiumCleanupResult>>;
}

export interface ChromiumAcquisition<E = never> {
  readonly reference: ChromiumReference;
  readonly failure: Effect.Effect<never, E | InitializationError>;
  readonly connect: Effect.Effect<ChromiumSession<E>, BrowserError | InitializationError | E>;
  readonly close: Effect.Effect<ChromiumCleanupResult>;
}

export interface ChromiumAttachRequest<E = never, R = never> extends OpenOptions<E, R> {
  readonly policy: BrowserPolicy;
  /** Resolve this exact target; without it, multiple open pages are an ambiguity error. */
  readonly target?: { readonly targetId: string };
}

export class Chromium extends Context.Service<
  Chromium,
  {
    readonly acquire: <E = never, R = never>(
      policy: BrowserPolicy,
      request?: OpenOptions<E, R>,
    ) => Effect.Effect<ChromiumAcquisition<E>, BrowserError, Scope.Scope | Exclude<R, Scope.Scope>>;
    readonly launch: <E = never, R = never>(
      policy: BrowserPolicy,
      request?: OpenOptions<E, R>,
    ) => Effect.Effect<
      ChromiumSession<E>,
      BrowserError | InitializationError | E,
      Scope.Scope | Exclude<R, Scope.Scope>
    >;
    /** A concrete loopback ws://.../devtools/browser/... endpoint; this scope owns only its connection. */
    readonly attach: <E = never, R = never>(
      endpoint: Redacted.Redacted<string>,
      request: ChromiumAttachRequest<E, R>,
    ) => Effect.Effect<
      ChromiumSession<E>,
      BrowserError | InitializationError | E,
      Scope.Scope | Exclude<R, Scope.Scope>
    >;
  }
>()("effect-browser/Chromium") {
  /** Launch through the configured service; compose with Browser.scoped for supervised ownership. */
  static launch<E = never, R = never>(policy: BrowserPolicy, request?: OpenOptions<E, R>) {
    return Effect.flatMap(Chromium, (browser) => browser.launch(policy, request));
  }

  /** Acquire the process lifetime before connecting, using the caller's scope. */
  static acquire<E = never, R = never>(policy: BrowserPolicy, request?: OpenOptions<E, R>) {
    return Effect.flatMap(Chromium, (browser) => browser.acquire(policy, request));
  }

  /** Borrow a concrete loopback endpoint; cleanup never terminates its external process. */
  static attach<E = never, R = never>(
    endpoint: Redacted.Redacted<string>,
    request: ChromiumAttachRequest<E, R>,
  ) {
    return Effect.flatMap(Chromium, (browser) => browser.attach(endpoint, request));
  }

  /** Chromium references, connection ids and handoff tokens come from the required `Crypto`. */
  static layer(options: ChromiumOptions = {}): Layer.Layer<Chromium, BrowserError, Crypto.Crypto> {
    return Layer.effect(
      Chromium,
      Effect.gen(function* () {
        const launchInput = yield* checked(ChromiumLaunch, options.launch ?? {}, "configure");

        const launch = Object.freeze({
          ...launchInput,
          ...(launchInput.args === undefined ? {} : { args: Object.freeze([...launchInput.args]) }),
          ...(launchInput.proxy === undefined
            ? {}
            : { proxy: Object.freeze({ ...launchInput.proxy }) }),
        });

        if (Object.prototype.hasOwnProperty.call(options, "bootstrap"))
          return yield* BrowserError.make({
            operation: "configure",
            reason: Reasons.Configuration.make({}),
            outcome: "undispatched",
          });

        const runtime = yield* BrowserRuntime.make({
          implementation: "chromium-playwright-cdp",
          ...(options.viewport === undefined ? {} : { viewport: options.viewport }),
          automation: {
            ...(options.actionTimeoutMillis === undefined
              ? {}
              : { actionTimeoutMillis: options.actionTimeoutMillis }),
            ...(options.maxPages === undefined ? {} : { maxPages: options.maxPages }),
            ...(options.maxHostReads === undefined ? {} : { maxHostReads: options.maxHostReads }),
            ...(options.initialPage === undefined ? {} : { initialPage: options.initialPage }),
            ...(options.popupPolicy === undefined ? {} : { popupPolicy: options.popupPolicy }),
            ...(options.dialogPolicy === undefined ? {} : { dialogPolicy: options.dialogPolicy }),
            ...(options.pageControl === undefined ? {} : { pageControl: options.pageControl }),
          },
        });

        const crypto = yield* Crypto.Crypto;

        const acquire = Effect.fnUntraced(function* <E = never, R = never>(
          policy: BrowserPolicy,
          request: OpenOptions<E, R> = {},
          attachment?: { readonly endpoint: Redacted.Redacted<string>; readonly targetId?: string },
        ) {
          const source =
            attachment === undefined
              ? ownedChromium(launch, options.onCleanup)
              : borrowedChromium(attachment.endpoint, options.onCleanup);

          const acquired = yield* runtime.acquire(
            policy,
            (cleanup, deadline) =>
              source(cleanup, deadline).pipe(Effect.provideService(Crypto.Crypto, crypto)),
            {
              ...request,
              ...(attachment === undefined
                ? {}
                : {
                    existingTarget:
                      attachment.targetId === undefined ? {} : { targetId: attachment.targetId },
                  }),
            },
          );

          const connected = yield* Effect.cached(
            acquired.connect.pipe(
              Effect.map(({ session }): ChromiumSession<E> =>
                Object.assign(session, {
                  reference: acquired.reference,
                  closeChecked: session.closeChecked.pipe(
                    Effect.andThen(acquired.lifetime.closeChecked),
                  ),
                  close: acquired.close,
                  cleanupResult: acquired.lifetime.cleanupResult,
                }),
              ),
            ),
          );

          return {
            reference: acquired.reference,
            failure: acquired.failure,
            close: acquired.close,
            connect: acquired.connect.pipe(Effect.andThen(connected)),
          } satisfies ChromiumAcquisition<E>;
        });

        return Chromium.of({
          acquire,
          launch: (policy, request) =>
            acquire(policy, request).pipe(Effect.flatMap((acquired) => acquired.connect)),
          attach: (endpoint, request) =>
            Effect.gen(function* () {
              const address = yield* checked(ChromiumEndpoint, Redacted.value(endpoint), "connect");

              return yield* (yield* acquire(request.policy, request, {
                endpoint: Redacted.make(address),
                ...(request.target === undefined ? {} : { targetId: request.target.targetId }),
              })).connect;
            }),
        });
      }),
    );
  }
}
