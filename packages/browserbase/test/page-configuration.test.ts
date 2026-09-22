import { expect, it } from "@effect/vitest";
import { Effect, Layer, Redacted } from "effect";
import { BrowserPolicy } from "effect-browser/browser-data";
import { BrowserbaseBrowser, type BrowserOptions } from "effect-browserbase/browser";
import { BrowserbaseClient } from "effect-browserbase/client";
import type { LaunchRecipe } from "effect-browserbase/launch";
import { BrowserbaseSessions } from "effect-browserbase/sessions";
import { FetchHttpClient } from "effect/unstable/http";

const launch: LaunchRecipe = {
  remoteTimeoutSeconds: 60,
  viewport: { _tag: "Fixed", width: 1280, height: 720 },
  provider: {},
};

const account = BrowserbaseSessions.layer.pipe(
  Layer.provideMerge(
    BrowserbaseClient.layer({
      projectId: "test-project",
      apiKey: Redacted.make("test-key"),
    }),
  ),
);

const policy = BrowserPolicy.make({
  network: { _tag: "Unrestricted" },
  maxActions: 10,
  maxElapsedMillis: 10000,
  maxReturnedBytes: 4096,
});

const cases: ReadonlyArray<{
  readonly name: string;
  readonly options: Partial<BrowserOptions>;
}> = [
  { name: "keep-alive", options: { launch: { ...launch, keepAlive: true } } },
  { name: "popup pause", options: { popupPolicy: "pause" } },
  { name: "dialog pause", options: { dialogPolicy: "pause" } },
];

for (const { name, options } of cases) {
  it.effect(`page control rejects ${name} before provider allocation`, () =>
    Effect.gen(function* () {
      let requests = 0;

      const fetch: typeof globalThis.fetch = async () => {
        requests++;

        return new Response("unexpected provider request", { status: 500 });
      };

      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const host = yield* BrowserbaseBrowser;

          return yield* host.open(policy);
        }),
      ).pipe(
        Effect.provide(
          BrowserbaseBrowser.layer({ launch, pageControl: true, ...options }).pipe(
            Layer.provide(account),
          ),
        ),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
        Effect.result,
      );

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure).toMatchObject({
          operation: "configure",
          reason: "unsupported",
          outcome: "undispatched",
        });
      }
      expect(requests).toBe(0);
    }),
  );
}

it.effect("ordinary sessions retain pause and keep-alive configuration", () =>
  Effect.gen(function* () {
    let requests = 0;

    const fetch: typeof globalThis.fetch = async () => {
      requests++;

      return new Response("unexpected provider request", { status: 500 });
    };

    const result = yield* BrowserbaseBrowser.pipe(
      Effect.provide(
        BrowserbaseBrowser.layer({
          launch: { ...launch, keepAlive: true },
          pageControl: false,
          popupPolicy: "pause",
          dialogPolicy: "pause",
        }).pipe(Layer.provide(account)),
      ),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
      Effect.result,
    );

    expect(result._tag).toBe("Success");
    expect(requests).toBe(0);
  }),
);
