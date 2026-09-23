import { Crypto, Effect, Option, Redacted } from "effect";

import type { Lifetime, Source } from "../../BrowserRuntime.ts";
import { BrowserError, Reasons } from "../../Errors.ts";
import { cleanupStep, reported, type ConnectionCleanup } from "../browser/ConnectionCleanup.ts";
import { checked } from "../browser/PublicSession.ts";
import { randomUuid } from "../browser/Random.ts";
import {
  ChromiumCleanupIssue,
  ChromiumCleanupResult,
  ChromiumEndpoint,
  ChromiumReference,
  type ChromiumLaunch,
} from "./Data.ts";
import { launch, type ChromiumProcess } from "./Process.ts";

export interface ChromiumLease extends Lifetime {
  readonly reference: ChromiumReference;
  readonly closeChecked: Effect.Effect<ChromiumCleanupResult, BrowserError>;
  readonly release: Effect.Effect<ChromiumCleanupResult>;
  readonly cleanupResult: Effect.Effect<Option.Option<ChromiumCleanupResult>>;
}

/** Each teardown step runs even when a preceding step fails. Only observed exit permits profile removal. */
export const makeChromiumCleanup = Effect.fnUntraced(function* (
  reference: ChromiumReference,
  local: ConnectionCleanup,
  process: ChromiumProcess | undefined,
) {
  let latest: ChromiumCleanupResult | undefined;

  const close = yield* Effect.cached(
    Effect.uninterruptible(
      Effect.gen(function* () {
        const issues: ChromiumCleanupIssue[] = [];

        const step = <A, E>(name: ChromiumCleanupIssue["step"], action: Effect.Effect<A, E>) =>
          cleanupStep(action, 3000).pipe(
            Effect.tap((result) =>
              Effect.sync(() => {
                if (result._tag === "Failure")
                  issues.push(ChromiumCleanupIssue.make({ step: name, reason: result.reason }));
              }),
            ),
          );

        yield* step("fence", local.fence);
        yield* step("capture", local.capture);
        yield* step("initialization", local.initialization);
        const disconnected = yield* step("disconnect", local.disconnect);

        const terminated =
          process === undefined ? undefined : yield* step("terminate", process.terminate);

        if (process !== undefined && terminated !== undefined && terminated._tag === "Success")
          yield* step("profile", process.removeProfile);

        const result = ChromiumCleanupResult.make({
          reference,
          ownership: process === undefined ? "borrowed" : "owned",
          connection: disconnected._tag === "Success" ? disconnected.value : "failed",
          process:
            terminated === undefined
              ? "not-owned"
              : terminated._tag === "Success"
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

const acquireChromium =
  (
    endpoint: Redacted.Redacted<string> | undefined,
    options: ChromiumLaunch,
    onCleanup?: (result: ChromiumCleanupResult) => Effect.Effect<void>,
  ): Source<ChromiumLease, BrowserError, Crypto.Crypto> =>
  (local) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        // Drawn first: a draw after the spawn would sit between it and finalizer registration.
        const id = yield* randomUuid(yield* Crypto.Crypto);
        // The process cannot escape between spawn and finalizer registration. Startup waiting happens
        // later in connect, where it is interruptible and the owning finalizer is already installed.
        const process = endpoint === undefined ? yield* launch(options) : undefined;
        const reference = Object.freeze(ChromiumReference.make({ provider: "chromium", id }));

        const cleanup = yield* makeChromiumCleanup(reference, local, process);
        let closing = false;

        const release = yield* Effect.cached(
          Effect.gen(function* () {
            closing = true;
            const result = yield* cleanup.close;

            if (onCleanup !== undefined) yield* reported(Effect.suspend(() => onCleanup(result)));

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
                    reason: Reasons.Closed.make({}),
                    outcome: "undispatched",
                  }),
                );
              if (process !== undefined) return process.connection(timeoutMillis);

              return endpoint === undefined
                ? Effect.fail(
                    BrowserError.make({
                      operation: "connect",
                      reason: Reasons.Configuration.make({}),
                      outcome: "undispatched",
                    }),
                  )
                : checked(ChromiumEndpoint, Redacted.value(endpoint), "connect").pipe(
                    Effect.map(Redacted.make),
                  );
            }),
          release,
          closeChecked: release.pipe(
            Effect.filterOrFail(
              (result) =>
                result.connection === "closed" &&
                result.issues.length === 0 &&
                (result.ownership === "borrowed"
                  ? result.process === "not-owned"
                  : result.process === "terminated"),
              () =>
                BrowserError.make({
                  operation: "close",
                  reason: Reasons.Failed.make({}),
                  outcome: "unknown",
                }),
            ),
          ),
          cleanupResult: cleanup.result,
          controlRetired: cleanup.result.pipe(
            Effect.map(
              (result) =>
                Option.isSome(result) &&
                result.value.ownership === "owned" &&
                result.value.process === "terminated",
            ),
          ),
        } satisfies ChromiumLease;
      }),
    );

export const ownedChromium = (
  options: ChromiumLaunch,
  onCleanup?: (result: ChromiumCleanupResult) => Effect.Effect<void>,
) => acquireChromium(undefined, options, onCleanup);

export const borrowedChromium = (
  endpoint: Redacted.Redacted<string>,
  onCleanup?: (result: ChromiumCleanupResult) => Effect.Effect<void>,
) => acquireChromium(endpoint, {}, onCleanup);
