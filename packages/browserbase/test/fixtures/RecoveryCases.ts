import assert from "node:assert/strict";

import { Effect, Redacted } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import { BrowserbaseClient } from "../../src/Client.ts";
import type { ClientError } from "../../src/Errors.ts";

interface Case {
  readonly name: string;
  readonly run: Effect.Effect<void, ClientError>;
}

/** Regressions found by inspecting the preserved checkpoint, not inherited historical results. */
export const recoveryCases: ReadonlyArray<Case> = [
  {
    // The old private seam let one options object reach both an account layer and a
    // browser layer, where excess keys were rejected only by the former. Account
    // authority and browser configuration are now separate types with no shared keys.
    name: "account options reject browser configuration instead of silently accepting it",
    run: Effect.gen(function* () {
      let requests = 0;

      const fetch: typeof globalThis.fetch = async () => {
        requests++;

        return Response.json({ ok: true });
      };

      const rejected = yield* Effect.gen(function* () {
        const client = yield* BrowserbaseClient;

        yield* client.json("GET", "/v1/sessions/session-1");
      }).pipe(
        Effect.provide(
          BrowserbaseClient.layer({
            projectId: "project-1",
            apiKey: Redacted.make("private-test-key"),
            // @ts-expect-error browser configuration is not account authority
            viewport: { width: 640, height: 480 },
          }),
        ),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
        Effect.result,
      );

      assert.equal(rejected._tag, "Failure");
      if (rejected._tag === "Failure") assert.equal(rejected.failure.reason, "configuration");
      assert.equal(requests, 0);

      yield* Effect.gen(function* () {
        const client = yield* BrowserbaseClient;

        yield* client.json("GET", "/v1/sessions/session-1");
      }).pipe(
        Effect.provide(
          BrowserbaseClient.layer({
            projectId: "project-1",
            apiKey: Redacted.make("private-test-key"),
          }),
        ),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      );
      assert.equal(requests, 1);
    }),
  },
];
