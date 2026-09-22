import { Cause, Effect, Exit, Option, Redacted, Schema } from "effect";

import { BrowserError } from "../../Errors.ts";
import { reported, type LocalCleanup } from "../session/Cleanup.ts";
import { fromNativeAttempt } from "./Binding.ts";
import {
  LocalCleanupIssue,
  LocalCleanupResult,
  LocalEndpoint,
  LocalReference,
  type LocalLaunch,
} from "./LocalData.ts";
import { launch, type LocalProcess } from "./LocalProcess.ts";
import { connectPlaywrightEndpoint } from "./Playwright.ts";
import { checked } from "./PublicSession.ts";
import type { RemoteSource, SessionLease } from "./Session.ts";

export interface LocalLease extends SessionLease {
  readonly reference: LocalReference;
  readonly release: Effect.Effect<LocalCleanupResult>;
  readonly cleanupResult: Effect.Effect<Option.Option<LocalCleanupResult>>;
}

/** Same maintained driver, with a separately validated host endpoint and no provider identity. */
export const localEngine = fromNativeAttempt(async (request, signal) => {
  if (!Schema.is(LocalEndpoint)(request.connection))
    throw BrowserError.make({
      operation: "connect",
      reason: "configuration",
      outcome: "undispatched",
    });

  return connectPlaywrightEndpoint(request.connection, signal, request.options, request.events);
});

/** Each teardown step runs even when a preceding step fails. Only observed exit permits profile removal. */
export const makeLocalCleanup = Effect.fnUntraced(function* (
  reference: LocalReference,
  local: LocalCleanup,
  process: LocalProcess | undefined,
) {
  let latest: LocalCleanupResult | undefined;

  const close = yield* Effect.cached(
    Effect.uninterruptible(
      Effect.gen(function* () {
        const issues: LocalCleanupIssue[] = [];

        const step = <A, E>(name: LocalCleanupIssue["step"], action: Effect.Effect<A, E>) =>
          action.pipe(
            Effect.interruptible,
            Effect.timeoutOrElse({
              duration: 3000,
              orElse: () => Effect.fail(LocalCleanupIssue.make({ step: name, reason: "timeout" })),
            }),
            Effect.exit,
            Effect.tap((exit) =>
              Effect.sync(() => {
                if (Exit.isSuccess(exit)) return;
                const error = Cause.findErrorOption(exit.cause);

                issues.push(
                  LocalCleanupIssue.make({
                    step: name,
                    reason:
                      Option.isSome(error) && error.value instanceof LocalCleanupIssue
                        ? error.value.reason
                        : Cause.hasInterrupts(exit.cause)
                          ? "interrupted"
                          : "failed",
                  }),
                );
              }),
            ),
          );

        yield* step("fence", local.fence);
        yield* step("capture", local.capture);
        yield* step("initialization", local.initialization);
        const disconnected = yield* step("disconnect", local.disconnect);

        const terminated =
          process === undefined ? undefined : yield* step("terminate", process.terminate);

        if (process !== undefined && terminated !== undefined && Exit.isSuccess(terminated))
          yield* step("profile", process.removeProfile);

        const result = LocalCleanupResult.make({
          reference,
          ownership: process === undefined ? "borrowed" : "owned",
          connection: Exit.isSuccess(disconnected) ? disconnected.value : "failed",
          process:
            terminated === undefined
              ? "not-owned"
              : Exit.isSuccess(terminated)
                ? "terminated"
                : "unknown",
          issues,
        });

        Object.freeze(result.issues);
        latest = Object.freeze(result);

        return latest;
      }),
    ),
  );

  return { close, result: Effect.sync(() => Option.fromNullishOr(latest)) };
});

const acquireLocal =
  (
    endpoint: Redacted.Redacted<string> | undefined,
    options: LocalLaunch,
    onCleanup?: (result: LocalCleanupResult) => Effect.Effect<void>,
  ): RemoteSource<LocalLease, BrowserError, never> =>
  (local) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        // The process cannot escape between spawn and finalizer registration. Startup waiting happens
        // later in connect, where it is interruptible and the owning finalizer is already installed.
        const process = endpoint === undefined ? yield* launch(options) : undefined;

        const reference = Object.freeze(
          LocalReference.make({ provider: "local", id: globalThis.crypto.randomUUID() }),
        );

        const cleanup = yield* makeLocalCleanup(reference, local, process);
        let closing = false;

        const release = yield* Effect.cached(
          Effect.gen(function* () {
            closing = true;
            const result = yield* cleanup.close;

            if (onCleanup !== undefined) yield* reported(onCleanup(result));

            return result;
          }).pipe(Effect.uninterruptible),
        );

        yield* Effect.addFinalizer(() => release.pipe(Effect.asVoid));

        return {
          reference,
          connection: (timeoutMillis) =>
            Effect.suspend(() => {
              if (closing)
                return Effect.fail(
                  BrowserError.make({
                    operation: "connect",
                    reason: "closed",
                    outcome: "undispatched",
                  }),
                );
              if (process !== undefined) return process.connection(timeoutMillis);

              return endpoint === undefined
                ? Effect.fail(
                    BrowserError.make({
                      operation: "connect",
                      reason: "configuration",
                      outcome: "undispatched",
                    }),
                  )
                : checked(LocalEndpoint, Redacted.value(endpoint), "connect").pipe(
                    Effect.map(Redacted.make),
                  );
            }),
          release,
          cleanupResult: cleanup.result,
        } satisfies LocalLease;
      }),
    );

export const ownedLocal = (
  options: LocalLaunch,
  onCleanup?: (result: LocalCleanupResult) => Effect.Effect<void>,
) => acquireLocal(undefined, options, onCleanup);

export const borrowedLocal = (
  endpoint: Redacted.Redacted<string>,
  onCleanup?: (result: LocalCleanupResult) => Effect.Effect<void>,
) => acquireLocal(endpoint, {}, onCleanup);
