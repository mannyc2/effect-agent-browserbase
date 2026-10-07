// Hosted trials against effect-browserbase's in-memory Browserbase; nothing reaches Browserbase.
import { assert, describe, it } from "@effect/vitest";
import { Cause, Context, Duration, Effect, Layer, Redacted } from "effect";
import { Browser } from "effect-browser/Browser";
import * as BrowserbaseClient from "effect-browserbase/BrowserbaseClient";
import {
  BrowserbaseError,
  Decode,
  RateLimited,
  Status,
  Transport,
} from "effect-browserbase/BrowserbaseError";
import { TestBrowserbase } from "effect-browserbase/testing";
import { HttpClient } from "effect/http";

import * as Latency from "../Latency.ts";
import * as Relay from "../Relay.ts";
import { hostedBrowser, hostedSessionSeconds, trialTimeout } from "../run.ts";
import { uncertainAllocation } from "../Trial.ts";

/**
 * The package's fake Browserbase as the client's `HttpClient`, keeping the body of every request
 * the client sends, beside the fake's handle.
 */
const recorded = (script: TestBrowserbase.Script = {}) =>
  Effect.gen(function* () {
    const { http, handle } = yield* TestBrowserbase.make(script);

    const sent: Array<{ readonly method: string; readonly url: string; readonly body: unknown }> =
      [];

    const client = BrowserbaseClient.layer({
      apiKey: Redacted.make(TestBrowserbase.apiKey),
      baseUrl: "https://api.browserbase.test",
    }).pipe(
      Layer.provide(
        Layer.succeed(
          HttpClient.HttpClient,
          http.pipe(
            HttpClient.tapRequest((request) =>
              Effect.sync(() =>
                sent.push({
                  method: request.method,
                  url: request.url,
                  body:
                    request.body._tag === "Uint8Array"
                      ? (JSON.parse(new TextDecoder().decode(request.body.body)) as unknown)
                      : undefined,
                }),
              ),
            ),
          ),
        ),
      ),
    );

    return { client, handle, sent };
  });

describe("hosted trials", () => {
  it.effect("create sessions whose own timeout outlasts the trial that owns them", () =>
    Effect.gen(function* () {
      // The fake's sessions hand out no DevTools address here, so the browser fails to open after
      // its session was made, and the session is released.
      const { client, handle, sent } = yield* recorded();

      const failure = yield* Layer.build(hostedBrowser(false)).pipe(
        Effect.scoped,
        Effect.provide(client),
        Effect.flip,
      );

      assert.strictEqual(failure._tag, "BrowserbaseError");
      assert.isAbove(hostedSessionSeconds, Duration.toSeconds(trialTimeout));
      const [create] = sent;

      assert.strictEqual(create?.method, "POST");
      assert.isTrue(create?.url.endsWith("/v1/sessions"), create?.url);
      assert.deepStrictEqual(create?.body, {
        timeout: hostedSessionSeconds,
        browserSettings: { viewport: { width: 1280, height: 720 } },
      });
      // Released once, and ended, as the release's own read confirmed.
      assert.deepStrictEqual(
        (yield* handle.sessions).map(({ status, releases }) => ({ status, releases })),
        [{ status: "COMPLETED", releases: 1 }],
      );
    }),
  );

  it.live(
    "relay a session's DevTools connection and record each command once answered",
    () =>
      Effect.gen(function* () {
        // The session's address is a local Chromium's, so the whole hosted path runs for free.
        const endpoint = yield* Latency.chromiumEndpoint;
        const { client, handle } = yield* recorded({ connectUrl: endpoint.href });
        const commands: Array<Latency.Command> = [];

        yield* Effect.gen(function* () {
          const context = yield* Layer.build(
            hostedBrowser(false).pipe(
              Layer.provide(
                Relay.client((command) => commands.push(command)).pipe(Layer.provide(client)),
              ),
            ),
          );

          const page = yield* Context.get(context, Browser).page;

          yield* page.goto("data:text/html,<button>Go</button>");
          assert.include((yield* page.snapshot()).text, 'button "Go"');
        }).pipe(Effect.scoped);

        const methods = new Set(commands.map((command) => command.method));

        assert.isTrue(methods.has("Runtime.evaluate"), [...methods].join(", "));
        assert.isTrue(methods.has("Page.navigate"), [...methods].join(", "));
        assert.isTrue(commands.every((command) => command.ended >= command.sent));
        assert.isAbove(commands.filter((command) => command.answer === "result").length, 10);

        const [session] = yield* handle.sessions;

        assert.deepInclude(session, { status: "COMPLETED", releases: 1 });
        // The release asked for the end, then read the session to confirm it.
        assert.deepStrictEqual(
          (yield* handle.requests).filter((request) => request.endsWith(`/${session?.id}`)),
          [`POST /v1/sessions/${session?.id}`, `GET /v1/sessions/${session?.id}`],
        );
      }).pipe(Effect.scoped),
    { timeout: 60_000 },
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
