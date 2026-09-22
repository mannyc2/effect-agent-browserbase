import { Context, Effect, Layer, type Option, Redacted, Scope } from "effect";

import * as Bootstrap from "./Bootstrap.ts";
import type { BrowserSession, OpenOptions } from "./Browser.ts";
import { AutomationOptions, BrowserPolicy, Viewport } from "./BrowserData.ts";
import { BrowserError, type InitializationError } from "./Errors.ts";
import { makeBindings, preparePlan } from "./internal/browser/Bindings.ts";
import { compileBootstrap } from "./internal/browser/Bootstrap.ts";
import type { DriverOptions } from "./internal/browser/Driver.ts";
import type { LocalCleanupResult } from "./internal/browser/LocalData.ts";
import { LocalEndpoint, LocalLaunch, type LocalReference } from "./internal/browser/LocalData.ts";
import { borrowedLocal, localEngine, ownedLocal } from "./internal/browser/LocalSession.ts";
import { checked, makeSession } from "./internal/browser/PublicSession.ts";
import { acquireSession } from "./internal/browser/Session.ts";
import { Identifier } from "./References.ts";

export {
  LocalCleanupIssue,
  LocalCleanupResult,
  LocalLaunch,
  LocalReference,
} from "./internal/browser/LocalData.ts";

/** Host-only process configuration. Building this layer neither loads Playwright nor starts Chromium. */
export interface LocalBrowserOptions extends AutomationOptions {
  readonly launch?: LocalLaunch;
  readonly viewport?: Viewport;
  readonly onCleanup?: (result: LocalCleanupResult) => Effect.Effect<void>;
}

/** A local lifetime has modeled browser authority, never Browserbase resource or release authority. */
export interface LocalSession<E = never> extends BrowserSession<E> {
  readonly reference: LocalReference;
  readonly close: Effect.Effect<LocalCleanupResult>;
  readonly cleanupResult: Effect.Effect<Option.Option<LocalCleanupResult>>;
}

export interface LocalAcquisition<E = never> {
  readonly reference: LocalReference;
  readonly failure: Effect.Effect<never, E | InitializationError>;
  readonly connect: Effect.Effect<LocalSession<E>, BrowserError | InitializationError | E>;
  readonly close: Effect.Effect<LocalCleanupResult>;
}

export interface LocalAttachRequest<E = never, R = never> extends OpenOptions<E, R> {
  readonly policy: BrowserPolicy;
  /** Resolve this exact target; without it, multiple open pages are an ambiguity error. */
  readonly target?: { readonly targetId: string };
}

export class LocalBrowser extends Context.Service<
  LocalBrowser,
  {
    readonly acquire: <E = never, R = never>(
      policy: BrowserPolicy,
      request?: OpenOptions<E, R>,
    ) => Effect.Effect<LocalAcquisition<E>, BrowserError, Scope.Scope | Exclude<R, Scope.Scope>>;
    readonly open: <E = never, R = never>(
      policy: BrowserPolicy,
      request?: OpenOptions<E, R>,
    ) => Effect.Effect<
      LocalSession<E>,
      BrowserError | InitializationError | E,
      Scope.Scope | Exclude<R, Scope.Scope>
    >;
    /** A concrete loopback ws://.../devtools/browser/... endpoint; this scope owns only its connection. */
    readonly attach: <E = never, R = never>(
      endpoint: Redacted.Redacted<string>,
      request: LocalAttachRequest<E, R>,
    ) => Effect.Effect<
      LocalSession<E>,
      BrowserError | InitializationError | E,
      Scope.Scope | Exclude<R, Scope.Scope>
    >;
    readonly withBrowser: <E, R, A, E2, R2>(
      policy: BrowserPolicy,
      request: OpenOptions<E, R>,
      use: (session: LocalSession<E>) => Effect.Effect<A, E2, R2>,
    ) => Effect.Effect<
      A,
      BrowserError | InitializationError | E | E2,
      Exclude<R | R2, Scope.Scope>
    >;
  }
>()("effect-browserbase/LocalBrowser") {
  static layer(options: LocalBrowserOptions = {}): Layer.Layer<LocalBrowser, BrowserError> {
    return Layer.effect(
      LocalBrowser,
      Effect.gen(function* () {
        const automation = yield* checked(
          AutomationOptions,
          {
            ...(options.actionTimeoutMillis === undefined
              ? {}
              : { actionTimeoutMillis: options.actionTimeoutMillis }),
            ...(options.maxPages === undefined ? {} : { maxPages: options.maxPages }),
            ...(options.initialPage === undefined ? {} : { initialPage: options.initialPage }),
            ...(options.popupPolicy === undefined ? {} : { popupPolicy: options.popupPolicy }),
            ...(options.dialogPolicy === undefined ? {} : { dialogPolicy: options.dialogPolicy }),
            ...(options.pageControl === undefined ? {} : { pageControl: options.pageControl }),
          },
          "configure",
        );

        const launchInput = yield* checked(LocalLaunch, options.launch ?? {}, "configure");

        const launch = Object.freeze({
          ...launchInput,
          ...(launchInput.args === undefined ? {} : { args: Object.freeze([...launchInput.args]) }),
          ...(launchInput.proxy === undefined
            ? {}
            : { proxy: Object.freeze({ ...launchInput.proxy }) }),
        });

        const viewport = yield* checked(
          Viewport,
          options.viewport ?? { width: 1280, height: 720 },
          "configure",
        );

        const pageControl = automation.pageControl ?? false;
        const popupPolicy = automation.popupPolicy ?? "retain";
        const dialogPolicy = automation.dialogPolicy ?? "dismiss";

        if (pageControl && (popupPolicy === "pause" || dialogPolicy === "pause"))
          return yield* BrowserError.make({
            operation: "configure",
            reason: "unsupported",
            outcome: "undispatched",
          });
        if (Object.prototype.hasOwnProperty.call(options, "bootstrap"))
          return yield* BrowserError.make({
            operation: "configure",
            reason: "configuration",
            outcome: "undispatched",
          });

        const driver: DriverOptions = {
          viewport,
          pageControl,
          popupPolicy,
          dialogPolicy,
          maxPages: automation.maxPages ?? 10,
        };

        const acquire = Effect.fnUntraced(function* <E = never, R = never>(
          policy: BrowserPolicy,
          request: OpenOptions<E, R> = {},
          attachment?: { readonly endpoint: Redacted.Redacted<string>; readonly targetId?: string },
        ) {
          const fixed = yield* checked(BrowserPolicy, policy, "configure");
          const plan = yield* preparePlan<E, R>(request.bootstrap ?? Bootstrap.empty);
          const scope = yield* Scope.fork(yield* Scope.Scope, "sequential");
          const bindings = yield* makeBindings(plan).pipe(Scope.provide(scope));
          const bootstrap = compileBootstrap(plan);

          const selection =
            attachment !== undefined
              ? {
                  newPage: false,
                  preserveViewport: true,
                  ...(attachment.targetId === undefined
                    ? {}
                    : { initialTargetId: attachment.targetId }),
                }
              : automation.initialPage === undefined
                ? {}
                : "targetId" in automation.initialPage
                  ? { initialTargetId: automation.initialPage.targetId }
                  : { newPage: true };

          const acquired = yield* acquireSession(
            {
              maxActions: fixed.maxActions,
              maxElapsedMillis: fixed.maxElapsedMillis,
              actionTimeoutMillis: automation.actionTimeoutMillis ?? 10000,
            },
            {
              remote:
                attachment === undefined
                  ? ownedLocal(launch, options.onCleanup)
                  : borrowedLocal(attachment.endpoint, options.onCleanup),
              engine: localEngine,
              keepAlive: false,
              driver: {
                ...driver,
                ...selection,
                ...(bootstrap === undefined ? {} : { bootstrap }),
              },
              connectBindings: bindings.connect,
              maxReturnedBytes: fixed.maxReturnedBytes,
            },
          ).pipe(Scope.provide(scope));

          const connected = yield* Effect.cached(
            acquired.connect.pipe(
              Effect.map((controls): LocalSession<E> =>
                Object.assign(makeSession(controls, bindings), {
                  reference: controls.reference,
                  close: controls.close,
                  cleanupResult: controls.cleanupResult,
                }),
              ),
            ),
          );

          return {
            reference: acquired.reference,
            failure: bindings.failure,
            close: acquired.close,
            connect: Effect.raceFirst(
              bindings.failure,
              acquired.connect.pipe(Effect.andThen(connected)),
            ).pipe(Effect.onError(() => acquired.close.pipe(Effect.asVoid))),
          } satisfies LocalAcquisition<E>;
        });

        return LocalBrowser.of({
          acquire,
          open: (policy, request) =>
            acquire(policy, request).pipe(Effect.flatMap((acquired) => acquired.connect)),
          attach: (endpoint, request) =>
            Effect.gen(function* () {
              const address = yield* checked(LocalEndpoint, Redacted.value(endpoint), "connect");

              const targetId =
                request.target === undefined
                  ? undefined
                  : yield* checked(Identifier, request.target.targetId, "configure");

              return yield* (yield* acquire(request.policy, request, {
                endpoint: Redacted.make(address),
                ...(targetId === undefined ? {} : { targetId }),
              })).connect;
            }),
          withBrowser: (policy, request, use) =>
            Effect.scoped(
              Effect.gen(function* () {
                const session = yield* (yield* acquire(policy, request)).connect;

                const result = yield* Effect.raceFirst(
                  session.failure,
                  Effect.suspend(() => use(session)),
                );

                const cleanup = yield* session.close;

                if (
                  cleanup.connection !== "closed" ||
                  cleanup.process !== "terminated" ||
                  cleanup.issues.length > 0
                )
                  return yield* BrowserError.make({
                    operation: "close",
                    reason: "failed",
                    outcome: "unknown",
                  });

                return result;
              }),
            ),
        });
      }),
    );
  }
}
