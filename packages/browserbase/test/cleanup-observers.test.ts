import { expect, it } from "@effect/vitest";
import {
  Clock,
  Deferred,
  Effect,
  ErrorReporter,
  Exit,
  Fiber,
  Layer,
  Option,
  Redacted,
} from "effect";
import { BrowserError, Reasons } from "effect-browser/errors";
import { TestClock } from "effect/testing";
import { FetchHttpClient } from "effect/unstable/http";

import type { CleanupResult } from "../src/Cleanup.ts";
import { BrowserbaseClient } from "../src/Client.ts";
import { borrowedRemote, ownedRemote } from "../src/internal/session/Browser.ts";
import { makeCleanup } from "../src/internal/session/Cleanup.ts";
import { SessionReference } from "../src/References.ts";
import { BrowserbaseSessions } from "../src/Sessions.ts";

const reference = SessionReference.make({
  provider: "browserbase",
  projectId: "project-1",
  sessionId: "session-1",
});

const launch = {
  remoteTimeoutSeconds: 60,
  viewport: { _tag: "ProviderManaged" },
  provider: {},
} as const;

const layers = BrowserbaseSessions.layer.pipe(
  Layer.provideMerge(
    BrowserbaseClient.layer({
      projectId: "project-1",
      apiKey: Redacted.make("fixture-not-a-credential"),
    }),
  ),
);

/** Real provider parsing, lifetime and cleanup; only transport/native teardown are injected. */
const fixture = (disconnectFails = false) => {
  const calls: string[] = [];
  let released = false;

  const metadata = () => ({
    id: reference.sessionId,
    projectId: reference.projectId,
    status: released ? "COMPLETED" : "RUNNING",
    createdAt: "2026-09-22T00:00:00Z",
    startedAt: "2026-09-22T00:00:00Z",
    updatedAt: "2026-09-22T00:00:00Z",
    expiresAt: "2026-09-22T00:01:00Z",
    keepAlive: false,
    proxyBytes: 0,
    region: "us-east-1",
    connectUrl: "wss://connect.browserbase.com/?session=session-1",
  });

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const pathname = new URL(request.url).pathname;

    if (request.method === "POST" && pathname === "/v1/sessions") {
      calls.push("allocate");

      return Response.json(metadata());
    }
    if (request.method === "POST" && pathname === "/v1/sessions/session-1") {
      calls.push("release");
      released = true;

      return Response.json(metadata());
    }
    if (request.method === "GET" && pathname === "/v1/sessions/session-1") {
      calls.push("status");

      return Response.json(metadata());
    }
    throw new Error("Unexpected fixture provider request");
  };

  const local = {
    fence: Effect.sync(() => {
      calls.push("fence");
    }),
    capture: Effect.sync(() => {
      calls.push("capture");
    }),
    initialization: Effect.sync(() => {
      calls.push("initialization");
    }),
    disconnect: Effect.suspend(() => {
      calls.push("disconnect");

      return disconnectFails
        ? Effect.fail(
            BrowserError.make({
              operation: "close",
              reason: Reasons.Failed.make({}),
              outcome: "unknown",
            }),
          )
        : Effect.succeed("closed" as const);
    }),
  };

  const run = <A, E, R>(program: Effect.Effect<A, E, R>) =>
    program.pipe(Effect.provide(layers), Effect.provideService(FetchHttpClient.Fetch, fetch));

  return { calls, local, run };
};

for (const ownership of ["owned", "borrowed"] as const) {
  for (const mode of ["success", "construction-throw", "defect", "interrupt", "timeout"] as const) {
    it.effect(
      `${ownership} cleanup contains ${mode} notification without changing its receipt`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = fixture();
            const entered = yield* Deferred.make<void>();
            const reports: CleanupResult[] = [];
            let notificationFinalizers = 0;

            const notify = (receipt: CleanupResult) => {
              reports.push(receipt);
              Deferred.doneUnsafe(entered, Effect.void);
              if (mode === "construction-throw")
                throw new Error("PRIVATE-NOTIFICATION-CONSTRUCTION");

              const work =
                mode === "defect"
                  ? Effect.die("PRIVATE-NOTIFICATION-DEFECT")
                  : mode === "interrupt"
                    ? Effect.interrupt
                    : mode === "timeout"
                      ? Effect.never
                      : Effect.void;

              return work.pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    notificationFinalizers++;
                  }),
                ),
              );
            };

            const deadline = Number(yield* Clock.monotonicTimeNanos) / 1_000_000 + 60_000;

            const lease =
              ownership === "owned"
                ? yield* f.run(ownedRemote({ launch, onCleanup: notify })(f.local, deadline))
                : yield* f.run(borrowedRemote({ reference, onCleanup: notify })(f.local, deadline));

            const closing = yield* f
              .run(
                Effect.all([lease.release, lease.closeChecked, lease.release], { concurrency: 3 }),
              )
              .pipe(Effect.forkChild);

            yield* Deferred.await(entered);
            expect(Option.getOrUndefined(yield* lease.cleanupResult)).toBe(reports[0]);
            if (mode === "timeout") yield* TestClock.adjust(2001);
            const [first, checked, repeated] = yield* Fiber.join(closing);

            expect(checked).toBe(first);
            expect(repeated).toBe(first);
            expect(yield* f.run(lease.closeChecked)).toBe(first);
            expect(reports).toHaveLength(1);
            expect(reports[0]).toBe(first);
            expect(notificationFinalizers).toBe(mode === "construction-throw" ? 0 : 1);
            expect(f.calls.filter((call) => call === "allocate")).toHaveLength(
              ownership === "owned" ? 1 : 0,
            );
            expect(f.calls.filter((call) => call === "release")).toHaveLength(
              ownership === "owned" ? 1 : 0,
            );
            expect(f.calls.filter((call) => call === "disconnect")).toHaveLength(1);
            expect(first).toMatchObject({
              ownership,
              local: "closed",
              remote: ownership === "owned" ? "confirmed" : "not-owned",
              releaseRequested: ownership === "owned",
              issues: [],
            });
            expect(Object.isFrozen(first)).toBe(true);
            expect(Object.isFrozen(first.issues)).toBe(true);
            expect(JSON.stringify(first)).not.toContain("PRIVATE-");
          }),
        ),
    );
  }

  it.effect(
    `${ownership} diagnostics failure cannot suppress the receipt observer or checked-close failure`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = fixture(true);
          const reports: CleanupResult[] = [];
          let diagnostics = 0;

          const reporter = ErrorReporter.make(() => {
            diagnostics++;
            throw new Error("PRIVATE-DIAGNOSTICS-FAILURE");
          });

          const notify = (receipt: CleanupResult) =>
            Effect.sync(() => {
              reports.push(receipt);
            });

          const deadline = Number(yield* Clock.monotonicTimeNanos) / 1_000_000 + 60_000;

          const lease =
            ownership === "owned"
              ? yield* f.run(ownedRemote({ launch, onCleanup: notify })(f.local, deadline))
              : yield* f.run(borrowedRemote({ reference, onCleanup: notify })(f.local, deadline));

          const first = yield* f
            .run(lease.release)
            .pipe(Effect.provideService(ErrorReporter.CurrentErrorReporters, new Set([reporter])));

          expect(diagnostics).toBe(1);
          expect(reports).toHaveLength(1);
          expect(reports[0]).toBe(first);
          expect(first).toMatchObject({
            local: "failed",
            issues: [{ step: "disconnect", reason: "failed" }],
          });
          expect(Option.getOrUndefined(yield* lease.cleanupResult)).toBe(first);
          expect(yield* f.run(lease.closeChecked).pipe(Effect.result)).toMatchObject({
            _tag: "Failure",
            failure: {
              _tag: "BrowserError",
              operation: "close",
              reason: { _tag: "Provider" },
              outcome: "unknown",
            },
          });
          expect(yield* f.run(lease.release)).toBe(first);
          expect(diagnostics).toBe(1);
          expect(reports).toHaveLength(1);
          expect(f.calls.filter((call) => call === "disconnect")).toHaveLength(1);
          expect(f.calls.filter((call) => call === "release")).toHaveLength(
            ownership === "owned" ? 1 : 0,
          );
        }),
      ),
  );
}

it.effect("canonical receipt settlement is not swallowed as an optional notification", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = fixture();
      const original = new Error("PRIVATE-CANONICAL-SETTLEMENT");
      let settlements = 0;

      const cleanup = yield* f.run(
        Effect.gen(function* () {
          const sessions = yield* BrowserbaseSessions;

          return yield* makeCleanup(reference, "owned", sessions, f.local, () => {
            settlements++;
            throw original;
          });
        }),
      );

      const exit = yield* Effect.exit(f.run(cleanup.close));

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit))
        expect(exit.cause.reasons).toContainEqual(
          expect.objectContaining({ _tag: "Die", defect: original }),
        );
      expect(Option.isSome(yield* cleanup.result)).toBe(true);
      expect(Exit.isFailure(yield* Effect.exit(f.run(cleanup.close)))).toBe(true);
      expect(settlements).toBe(1);
      expect(f.calls.filter((call) => call === "release")).toHaveLength(1);
      expect(f.calls.filter((call) => call === "disconnect")).toHaveLength(1);
    }),
  ),
);
