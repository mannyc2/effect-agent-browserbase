import {
  BrowserbaseInteractiveHost,
  type InteractiveOptions,
} from "@effect-agent/platform-browserbase/interactive-browser";
import { expect, it } from "@effect/vitest";
import { Effect, Redacted } from "effect";
import { InteractiveBrowserPolicy } from "effect-agent/interactive-browser";
import { FetchHttpClient } from "effect/unstable/http";

const policy = InteractiveBrowserPolicy.make({
  network: { _tag: "Unrestricted" },
  maxActions: 10,
  maxElapsedMillis: 10000,
  maxReturnedBytes: 4096,
});

const cases: ReadonlyArray<{
  readonly name: string;
  readonly options: Partial<InteractiveOptions>;
}> = [
  { name: "keep-alive", options: { keepAlive: true } },
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
          const host = yield* BrowserbaseInteractiveHost;

          return yield* host.open(policy);
        }),
      ).pipe(
        Effect.provide(
          BrowserbaseInteractiveHost.layer({
            projectId: "test-project",
            apiKey: Redacted.make("test-key"),
            pageControl: true,
            ...options,
          }),
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

    const result = yield* BrowserbaseInteractiveHost.pipe(
      Effect.provide(
        BrowserbaseInteractiveHost.layer({
          projectId: "test-project",
          apiKey: Redacted.make("test-key"),
          pageControl: false,
          keepAlive: true,
          popupPolicy: "pause",
          dialogPolicy: "pause",
        }),
      ),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
      Effect.result,
    );

    expect(result._tag).toBe("Success");
    expect(requests).toBe(0);
  }),
);
