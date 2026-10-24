// PLAN T2 and #239: PENDING must remain a live writer; prior fake states could not plant this bug.
import { assert, it } from "@effect/vitest";
import { Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";

import * as Browserbase from "../src/Browserbase.ts";
import { BrowserbaseClient } from "../src/BrowserbaseClient.ts";
import * as ContextLease from "../src/ContextLease.ts";
import * as TestBrowserbase from "../src/testing/TestBrowserbase.ts";

const context = "00000000-0000-4000-8000-000000000020";
const session = "00000000-0000-4000-8000-000000000021";

it.effect("keeps a seeded PENDING context writer unconfirmed until it actually ends", () =>
  Effect.gen(function* () {
    const fake = yield* TestBrowserbase.TestBrowserbase;

    const reconciliation = yield* Browserbase.reconcile(context, { contextSettle: 0 }).pipe(
      Effect.forkChild,
    );

    yield* fake.waitUntil((rows) => rows[0]?.releases === 1);
    yield* TestClock.adjust("59 seconds");
    assert.isUndefined(reconciliation.pollUnsafe(), "PENDING is still a live writer");
    yield* TestClock.adjust("1 second");
    assert.strictEqual((yield* Fiber.join(reconciliation))._tag, "Unconfirmed");
    assert.strictEqual((yield* fake.sessions)[0]?.status, "PENDING");
  }).pipe(
    Effect.provide(
      Layer.merge(
        ContextLease.layer,
        TestBrowserbase.layer({
          contexts: [{ id: context }],
          sessions: [
            {
              id: session,
              status: "PENDING",
              options: {
                timeout: 300,
                browserSettings: { context: { id: context, persist: true } },
                userMetadata: { persistsContext: context },
              },
            },
          ],
          releases: [{ _tag: "Pending" }],
        }),
      ),
    ),
  ),
);

it.effect("waits for seeded clock transitions and request changes without polling", () =>
  Effect.gen(function* () {
    const fake = yield* TestBrowserbase.TestBrowserbase;
    const client = yield* BrowserbaseClient;

    const running = yield* fake
      .waitUntil((rows) => rows[0]?.status === "RUNNING")
      .pipe(Effect.forkChild);

    yield* TestClock.adjust("1 second");
    assert.isUndefined(running.pollUnsafe());
    yield* TestClock.adjust("1 second");
    assert.strictEqual((yield* Fiber.join(running))[0]?.status, "RUNNING");
    assert.deepStrictEqual(yield* fake.requests, [], "waiting sends no API requests");

    const completed = yield* fake
      .waitUntil((rows) => rows[0]?.status === "COMPLETED")
      .pipe(Effect.forkChild);

    yield* client.releaseSession(session);
    assert.strictEqual((yield* Fiber.join(completed))[0]?.status, "COMPLETED");
    const made = yield* client.createSession({ timeout: 60 });

    assert.notStrictEqual(made.id, session, "creation cannot overwrite a seeded session");
    assert.lengthOf(yield* fake.sessions, 2);
  }).pipe(
    Effect.provide(
      TestBrowserbase.layer({
        sessions: [{ id: session, status: "PENDING", pendingMillis: 2000 }],
      }),
    ),
  ),
);
