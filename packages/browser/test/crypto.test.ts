import { expect, it } from "@effect/vitest";
import { Crypto, Effect, Redacted } from "effect";

import { BrowserPolicy } from "../src/BrowserData.ts";
import * as BrowserRuntime from "../src/BrowserRuntime.ts";
import {
  bindingImplementation,
  type ConnectionIdentity,
  issueBinding,
} from "../src/internal/browser/Binding.ts";
import { borrowedChromium } from "../src/internal/chromium/Session.ts";
import * as Testing from "../src/Testing.ts";

const uuid = (draw: number) => `00000000-0000-4000-8000-${draw.toString(16).padStart(12, "0")}`;

const draw = Effect.flatMap(Crypto.Crypto, (crypto) => crypto.randomUUIDv4);

const shop: Testing.Script = {
  documents: [{ url: "https://shop.test/", title: "Shop", text: "Welcome." }],
};

it.effect("sequentialCrypto counts up from one on each build and computes no digest", () =>
  Effect.gen(function* () {
    const first = yield* Effect.all([draw, draw]).pipe(Effect.provide(Testing.sequentialCrypto));
    const rebuilt = yield* draw.pipe(Effect.provide(Testing.sequentialCrypto));

    const digest = yield* Effect.flatMap(Crypto.Crypto, (crypto) =>
      crypto.digest("SHA-256", new Uint8Array(1)),
    ).pipe(Effect.provide(Testing.sequentialCrypto), Effect.flip);

    expect(first).toEqual([uuid(1), uuid(2)]);
    expect(rebuilt).toBe(uuid(1));
    expect(digest).toMatchObject({ reason: { _tag: "BadArgument", method: "digest" } });
  }),
);

it.effect("the owner draws connection identity and handoff tokens from the runtime's Crypto", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const scripted = yield* Testing.binding(shop);
      const engine = bindingImplementation(scripted.binding);
      const identities: Array<ConnectionIdentity> = [];

      expect(engine).toBeDefined();

      const recording = issueBinding(
        { _tag: "BrowserBinding" as const },
        {
          connect: (request) => {
            identities.push(request.identity);

            return engine!.connect(request);
          },
        },
      );

      // The runtime captures this Crypto; acquiring and connecting below require none.
      const runtime = yield* BrowserRuntime.make({
        implementation: "crypto-under-test",
        binding: recording,
      }).pipe(Effect.provide(Testing.sequentialCrypto));

      const acquired = yield* runtime.acquire(BrowserPolicy.unrestricted(), (cleanup) =>
        Effect.gen(function* () {
          const release = yield* Effect.cached(
            cleanup.fence.pipe(Effect.andThen(cleanup.disconnect), Effect.orDie, Effect.asVoid),
          );

          yield* Effect.addFinalizer(() => release);

          return {
            reference: "crypto-under-test",
            connection: () => Effect.succeed(Redacted.make("wss://crypto.test/")),
            release,
            cleanupResult: Effect.succeedNone,
            closeChecked: release,
          };
        }),
      );

      const { operations } = yield* acquired.connect;

      expect(identities).toEqual([{ namespace: uuid(1), bindings: uuid(2) }]);

      const first = yield* operations.beginHandoff(Effect.succeed("view"));
      const repeated = yield* operations.beginHandoff(Effect.succeed("view"));

      // One pause has one token, however often it is asked for.
      expect(Redacted.value(first.token)).toBe(uuid(3));
      expect(Redacted.value(repeated.token)).toBe(uuid(3));
      yield* operations.resume(first.token, true);

      const next = yield* operations.beginHandoff(Effect.succeed("view"));

      expect(Redacted.value(next.token)).toBe(uuid(4));
    }),
  ),
);

it.effect("a Chromium reference id comes from the Crypto service", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const lease = yield* borrowedChromium(
        Redacted.make("ws://127.0.0.1:9222/devtools/browser/crypto-fixture"),
      )(
        {
          fence: Effect.void,
          capture: Effect.void,
          initialization: Effect.void,
          disconnect: Effect.succeed("closed" as const),
        },
        1000,
      ).pipe(Effect.provide(Testing.sequentialCrypto));

      expect(lease.reference).toMatchObject({ provider: "chromium", id: uuid(1) });
    }),
  ),
);
