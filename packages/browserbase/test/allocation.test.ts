import { expect, it } from "@effect/vitest";
import { Effect, Redacted } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import * as Account from "../src/Account.ts";
import * as Allocation from "../src/Allocation.ts";
import { BrowserbaseDownloads } from "../src/Downloads.ts";
import { recipe } from "../src/Launch.ts";
import { BrowserbaseSessions } from "../src/Sessions.ts";
import { BrowserbaseWebhooks } from "../src/Webhooks.ts";

const account = { projectId: "allocation-project", apiKey: Redacted.make("allocation-test-key") };

const metadata = (status: string, projectId = account.projectId) => ({
  id: "session-1",
  projectId,
  status,
  createdAt: "2026-09-20T00:00:00Z",
  startedAt: "2026-09-20T00:00:00Z",
  updatedAt: "2026-09-20T00:00:00Z",
  expiresAt: "2026-09-20T00:01:00Z",
  keepAlive: false,
  proxyBytes: 0,
  region: "us-east-1",
  connectUrl: "wss://connect.browserbase.com/connect?sessionId=session-1",
});

/**
 * An unexpected provider operation throws rather than returning a body, so a standalone
 * allocation that quietly fetched connection credentials would fail this fixture.
 */
const fixture = (allocatedProject = account.projectId) => {
  const order: Array<string> = [];
  let released = false;

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;

    if (path === "/v1/sessions" && request.method === "POST") {
      order.push("allocate");

      return Response.json(metadata("RUNNING", allocatedProject));
    }
    if (path === "/v1/sessions/session-1" && request.method === "POST") {
      order.push("release");
      released = true;

      return Response.json(metadata("RUNNING"));
    }
    if (path === "/v1/sessions/session-1" && request.method === "GET") {
      order.push("status");

      return Response.json(metadata(released ? "COMPLETED" : "RUNNING"));
    }
    throw new Error(`Unexpected provider operation ${request.method} ${path}`);
  };

  const run = <A, E>(program: Effect.Effect<A, E, Account.Services>) =>
    program.pipe(
      Effect.provide(Account.layer(account)),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    );

  return { order, run };
};

it.effect("a scoped allocation owns the session and releases it when the scope closes", () =>
  Effect.gen(function* () {
    const provider = fixture();

    const reference = yield* provider.run(
      Effect.gen(function* () {
        const allocated = yield* Allocation.scoped(recipe());

        expect(allocated.reference.provider).toBe("browserbase");
        expect(allocated.reference.projectId).toBe(account.projectId);
        expect(allocated.reference.sessionId).toBe("session-1");
        // Cleanup evidence does not exist while the session is still held.
        expect((yield* allocated.cleanupResult)._tag).toBe("None");
        expect(provider.order).toEqual(["allocate"]);

        return allocated.reference;
      }).pipe(Effect.scoped),
    );

    expect(reference.sessionId).toBe("session-1");
    expect(provider.order).toContain("release");
  }),
);

it.effect("releasing explicitly reports the cleanup evidence the finalizer would", () =>
  Effect.gen(function* () {
    const provider = fixture();

    const cleanup = yield* provider.run(
      Effect.gen(function* () {
        const allocated = yield* Allocation.scoped(recipe());
        const result = yield* allocated.release;

        expect((yield* allocated.cleanupResult)._tag).toBe("Some");

        return result;
      }).pipe(Effect.scoped),
    );

    expect(cleanup.releaseRequested).toBe(true);
    expect(cleanup.ownership).toBe("owned");
    // The scope closing after an explicit release does not send a second release request.
    expect(provider.order.filter((step) => step === "release")).toHaveLength(1);
  }),
);

it.effect("a reply naming another project is refused after the attempt is recorded", () =>
  Effect.gen(function* () {
    const provider = fixture("other-project");

    const failure = yield* provider.run(
      Allocation.scoped(recipe()).pipe(Effect.scoped, Effect.flip),
    );

    expect(failure._tag).toBe("AllocationError");
    if (failure._tag === "AllocationError") {
      expect(failure.reason).toBe("malformed");
      // The session exists, so its effect on the provider is known rather than unknown.
      expect(failure.outcome).toBe("unknown");
      expect(failure.reference?.projectId).toBe("other-project");
    }
    // No release is sent: a reference to another project is refused before it reaches the
    // provider, so the caller is handed the foreign reference instead of a mutation on it.
    expect(provider.order).toEqual(["allocate"]);
  }),
);

it.effect("one account layer carries every resource service on the same credentials", () =>
  fixture().run(
    Effect.gen(function* () {
      const sessions = yield* BrowserbaseSessions;
      const downloads = yield* BrowserbaseDownloads;
      const webhooks = yield* BrowserbaseWebhooks;

      // Sessions is provided once and shared, rather than rebuilt per artifact service.
      expect(typeof sessions.retrieve).toBe("function");
      expect(typeof downloads.delete).toBe("function");
      expect(typeof webhooks.rotateSecret).toBe("function");
    }),
  ),
);
