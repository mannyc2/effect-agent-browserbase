// Hosted trials against an in-memory Browserbase API; nothing reaches Browserbase.
import { assert, describe, it } from "@effect/vitest";
import { Cause, Duration, Effect, Layer, Redacted } from "effect";
import * as BrowserbaseClient from "effect-browserbase/BrowserbaseClient";
import {
  BrowserbaseError,
  Decode,
  RateLimited,
  Status,
  Transport,
} from "effect-browserbase/BrowserbaseError";
import { HttpClient, HttpClientResponse } from "effect/http";

import { hostedBrowser, hostedSessionSeconds, trialTimeout } from "../run.ts";
import { uncertainAllocation } from "../Trial.ts";

describe("hosted trials", () => {
  it.effect("create sessions whose own timeout outlasts the trial that owns them", () =>
    Effect.gen(function* () {
      const sent: Array<{ readonly method: string; readonly url: string; readonly body: unknown }> =
        [];

      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          const body =
            request.body._tag === "Uint8Array"
              ? (JSON.parse(new TextDecoder().decode(request.body.body)) as unknown)
              : undefined;

          sent.push({ method: request.method, url: request.url, body });

          // A session without a CDP address fails to open after it was created, so it is released.
          return HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify({
                id: "s1",
                status: "RUNNING",
                region: "us-west-2",
                keepAlive: false,
                createdAt: "2026-10-04T12:00:00.000Z",
                expiresAt: "2026-10-04T12:15:00.000Z",
              }),
              {
                status:
                  request.method === "POST" && request.url.endsWith("/v1/sessions") ? 201 : 200,
              },
            ),
          );
        }),
      );

      const client = BrowserbaseClient.layer({
        apiKey: Redacted.make("test-key"),
        baseUrl: "https://browserbase.test",
      }).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, http)));

      const failure = yield* Layer.build(hostedBrowser(false)).pipe(
        Effect.scoped,
        Effect.provide(client),
        Effect.flip,
      );

      assert.strictEqual(failure._tag, "BrowserbaseError");
      assert.isAbove(hostedSessionSeconds, Duration.toSeconds(trialTimeout));
      assert.deepInclude(sent[0], {
        method: "POST",
        url: "https://browserbase.test/v1/sessions",
        body: {
          timeout: hostedSessionSeconds,
          browserSettings: { viewport: { width: 1280, height: 720 } },
        },
      });
      assert.deepInclude(sent[1], {
        method: "POST",
        url: "https://browserbase.test/v1/sessions/s1",
        body: { status: "REQUEST_RELEASE" },
      });
    }),
  );

  it("stop hosted admission only after a create with an unknown outcome", () => {
    const failed = (operation: string, reason: BrowserbaseError["reason"]) =>
      Cause.fail(new BrowserbaseError({ operation, reason }));

    for (const reason of [
      new Transport({ detail: "reset" }),
      new Status({ status: 502, detail: "bad gateway" }),
      new Status({ status: 408, detail: "request timeout" }),
      new Decode({ detail: "missing region" }),
      new Decode({
        detail: "missing region; session s9 could not be released and ends at its timeout",
      }),
    ])
      assert.isTrue(uncertainAllocation(failed("createSession", reason)), reason.message);

    for (const reason of [
      new RateLimited({ detail: "busy" }),
      new Status({ status: 400, detail: "bad request" }),
      new Decode({ detail: "missing region; session s9 was released" }),
    ])
      assert.isFalse(uncertainAllocation(failed("createSession", reason)), reason.message);
    assert.isFalse(
      uncertainAllocation(failed("releaseSession", new Transport({ detail: "reset" }))),
    );
    assert.isFalse(uncertainAllocation(Cause.fail(new Error("trial failed"))));
  });
});
