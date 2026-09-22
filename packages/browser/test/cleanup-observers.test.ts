import { expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Option, Redacted } from "effect";
import * as Browser from "effect-browser/browser";
import { BrowserError, Reasons } from "effect-browser/errors";
import { TestClock } from "effect/testing";

import * as Bootstrap from "../src/Bootstrap.ts";
import type { ChromiumCleanupResult } from "../src/Chromium.ts";
import { makeBindings } from "../src/internal/browser/Bindings.ts";
import type { Driver } from "../src/internal/browser/Driver.ts";
import { makeSession } from "../src/internal/browser/PublicSession.ts";
import { acquireSession } from "../src/internal/browser/Session.ts";
import { borrowedChromium, type ChromiumLease } from "../src/internal/chromium/Session.ts";

const endpoint = Redacted.make("ws://127.0.0.1:9222/devtools/browser/cleanup-fixture");

for (const mode of ["success", "construction-throw", "defect", "interrupt", "timeout"] as const) {
  it.effect(`cleanup notification ${mode} preserves the cached receipt and one teardown`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const reports: ChromiumCleanupResult[] = [];
        const calls: string[] = [];
        let notificationFinalizers = 0;

        const mark = (step: string) =>
          Effect.sync(() => {
            calls.push(step);
          });

        const lease = yield* borrowedChromium(endpoint, (receipt) => {
          reports.push(receipt);
          Deferred.doneUnsafe(entered, Effect.void);
          if (mode === "construction-throw") throw new Error("PRIVATE-NOTIFICATION-CONSTRUCTION");

          const action =
            mode === "defect"
              ? Effect.die("PRIVATE-NOTIFICATION-DEFECT")
              : mode === "interrupt"
                ? Effect.interrupt
                : mode === "timeout"
                  ? Effect.never
                  : Effect.void;

          return action.pipe(
            Effect.ensuring(
              Effect.sync(() => {
                notificationFinalizers++;
              }),
            ),
          );
        })(
          {
            fence: mark("fence"),
            capture: mark("capture"),
            initialization: mark("initialization"),
            disconnect: mark("disconnect").pipe(Effect.as("closed" as const)),
          },
          60_000,
        );

        const closing = yield* Effect.all([lease.release, lease.closeChecked, lease.release], {
          concurrency: 3,
        }).pipe(Effect.forkChild);

        yield* Deferred.await(entered);
        // Receipt publication is complete before the optional observer gets to run or fail.
        expect(Option.getOrUndefined(yield* lease.cleanupResult)).toBe(reports[0]);
        if (mode === "timeout") yield* TestClock.adjust(2001);
        const [first, checked, repeated] = yield* Fiber.join(closing);

        expect(checked).toBe(first);
        expect(repeated).toBe(first);
        expect(yield* lease.closeChecked).toBe(first);
        expect(reports).toHaveLength(1);
        expect(reports[0]).toBe(first);
        expect(calls).toEqual(["fence", "capture", "initialization", "disconnect"]);
        expect(notificationFinalizers).toBe(mode === "construction-throw" ? 0 : 1);
        expect(first).toMatchObject({
          ownership: "borrowed",
          connection: "closed",
          process: "not-owned",
          issues: [],
        });
        expect(Object.isFrozen(first)).toBe(true);
        expect(Object.isFrozen(first.issues)).toBe(true);
        expect(JSON.stringify(first)).not.toContain("PRIVATE-");
      }),
    ),
  );
}

/** Only native connection/teardown is injected; the actual owner, scopes and receipt source run. */
const cleanupFixture = () => {
  const receipts: ChromiumCleanupResult[] = [];
  let connections = 0;
  let disconnections = 0;
  let lease: ChromiumLease | undefined;

  const disconnectFailure = BrowserError.make({
    operation: "close",
    reason: Reasons.Failed.make({}),
    outcome: "unknown",
  });

  const open = Effect.gen(function* () {
    const bindings = yield* makeBindings(Bootstrap.empty);

    const driver = {
      selected: () => ({ pageId: "page", frameId: "frame" }),
      selectedTargetId: async () => "target",
      documentReadiness: async () => ({ _tag: "Ready" as const }),
      invalidateObservation: () => {},
      disconnect: async () => {
        disconnections++;
        throw disconnectFailure;
      },
    } satisfies Pick<
      Driver,
      "selected" | "selectedTargetId" | "documentReadiness" | "invalidateObservation" | "disconnect"
    >;

    const acquired = yield* acquireSession(
      { maxActions: 10, maxHostReads: 10, maxElapsedMillis: 60_000, actionTimeoutMillis: 1000 },
      {
        implementation: "cleanup-fixture",
        engine: {
          connect: (request) =>
            Effect.sync(() => {
              connections++;
              request.onSettled();

              // Every native method the test uses is above; an unexpected method is a fixture defect.
              return driver as unknown as Driver;
            }),
        },
        remote: borrowedChromium(endpoint, (receipt) =>
          Effect.sync(() => {
            receipts.push(receipt);
          }),
        ),
        keepAlive: false,
        connectBindings: bindings.connect,
        maxReturnedBytes: 65536,
        driver: {
          viewport: { width: 640, height: 480 },
          popupPolicy: "retain",
          dialogPolicy: "dismiss",
          maxPages: 1,
        },
      },
    );

    lease = acquired.lease;

    return makeSession(yield* acquired.connect, bindings);
  });

  return { open, receipts, counts: () => ({ connections, disconnections }), lease: () => lease };
};

for (const mode of [
  "outer-timeout",
  "direct-interruption",
  "body-failure",
  "awaited-success",
] as const) {
  it.effect(
    `${mode} keeps cleanup evidence outside the workflow race and never retries teardown`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = cleanupFixture();
          const entered = yield* Deferred.make<void>();
          const bodyFailure = { _tag: "ConsumerFailure", detail: "PRIVATE-CONSUMER" };

          const workflow = Browser.scoped(fixture.open, () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              if (mode === "body-failure") return yield* Effect.fail(bodyFailure);
              if (mode === "awaited-success") return "body completed";

              return yield* Effect.never;
            }),
          );

          if (mode === "outer-timeout") {
            const fiber = yield* workflow.pipe(Effect.timeoutOption(50), Effect.forkChild);

            yield* Deferred.await(entered);
            yield* TestClock.adjust(51);
            expect(Option.isNone(yield* Fiber.join(fiber))).toBe(true);
          } else {
            const exit =
              mode === "direct-interruption"
                ? yield* Effect.gen(function* () {
                    const fiber = yield* workflow.pipe(Effect.forkChild);

                    yield* Deferred.await(entered);
                    yield* Fiber.interrupt(fiber);

                    return yield* Fiber.await(fiber);
                  })
                : yield* Effect.exit(workflow);

            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit)) {
              const errors = exit.cause.reasons
                .filter(Cause.isFailReason)
                .map((reason) => reason.error);

              expect(errors).toContainEqual(
                expect.objectContaining({
                  _tag: "BrowserError",
                  operation: "close",
                  reason: { _tag: "Failed" },
                  outcome: "unknown",
                }),
              );
              if (mode === "body-failure") expect(errors).toContain(bodyFailure);
              if (mode === "direct-interruption")
                expect(Cause.hasInterrupts(exit.cause)).toBe(true);
            }
          }
          expect(fixture.receipts).toHaveLength(1);
          const receipt = fixture.receipts[0];

          expect(receipt).toMatchObject({
            connection: "failed",
            process: "not-owned",
            issues: [{ step: "disconnect", reason: "failed" }],
          });
          expect(fixture.counts()).toEqual({ connections: 1, disconnections: 1 });
          const lease = fixture.lease();

          expect(lease).toBeDefined();
          if (lease !== undefined) {
            expect(Option.getOrUndefined(yield* lease.cleanupResult)).toBe(receipt);
            expect(yield* lease.release).toBe(receipt);
            expect(yield* lease.closeChecked.pipe(Effect.result)).toMatchObject({
              _tag: "Failure",
              failure: { operation: "close", outcome: "unknown" },
            });
          }
          expect(fixture.receipts).toHaveLength(1);
          expect(fixture.counts()).toEqual({ connections: 1, disconnections: 1 });
        }),
      ),
  );
}
