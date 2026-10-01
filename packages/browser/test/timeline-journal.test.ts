import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Redacted } from "effect";
import { TestClock } from "effect/testing";

import { BrowserPolicy } from "../src/BrowserData.ts";
import * as BrowserRuntime from "../src/BrowserRuntime.ts";
import * as Testing from "../src/Testing.ts";

const origin = "https://journal.test";
// A host address long enough that its Navigated event exceeds the smallest per-event budget.
const long = `${origin}/${"a".repeat(3000)}`;

const script: Testing.Script = {
  documents: [
    { url: `${origin}/`, title: "Journal", text: "Evidence." },
    { url: long, title: "Long", text: "A long address." },
  ],
};

it.effect("a refused event leaves an attributed omission in its Page's view", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* Testing.open(script, {
        automation: {
          timelineLimits: {
            maxDurationMillis: 60_000,
            maxEvents: 4096,
            maxBytes: 4 * 1024 * 1024,
            maxSubscribers: 32,
            maxEventBytes: 2048,
          },
        },
      });

      const page = browser.initialPage;

      yield* page.navigate({ url: long });

      const omitted = (yield* page.timeline.snapshot()).events.filter(
        (event) => event.event._tag === "MetadataOmitted",
      );

      expect(omitted).toMatchObject([
        {
          target: { pageId: page.identity.pageId, generation: page.identity.generation },
          event: { _tag: "MetadataOmitted", reason: "Oversized", originalTag: "Navigated" },
        },
      ]);
    }),
  ),
);

/** An integration's lifetime with one fixed address, so every connection reaches one browser. */
const fixedAddress =
  (address: string): BrowserRuntime.Source<BrowserRuntime.Lifetime, never> =>
  (cleanup) =>
    Effect.gen(function* () {
      const release = yield* Effect.cached(
        cleanup.fence.pipe(
          Effect.andThen(cleanup.capture),
          Effect.andThen(cleanup.initialization),
          Effect.andThen(cleanup.disconnect),
          Effect.orDie,
          Effect.asVoid,
        ),
      );

      yield* Effect.addFinalizer(() => release);

      return {
        reference: "journal-under-test",
        connection: () => Effect.succeed(Redacted.make(address)),
        release,
        cleanupResult: Effect.succeedNone,
        closeChecked: release,
        verifyReconnect: Effect.void,
      };
    });

it.effect("a time before a reconnected journal began is a gap, not a silent restart", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const scripted = yield* Testing.binding(script);

      const runtime = yield* BrowserRuntime.make({
        implementation: "journal-under-test",
        binding: scripted.binding,
        keepAlive: true,
      }).pipe(Effect.provide(NodeCrypto.layer));

      const acquired = yield* runtime.acquire(
        BrowserPolicy.unrestricted(),
        fixedAddress("wss://journal.test/"),
      );

      const { session, operations } = yield* acquired.connect;

      yield* session.initialPage.navigate({ url: `${origin}/` });
      const before = yield* session.timeline.now;

      yield* TestClock.adjust("1 second");
      yield* operations.detach;
      yield* operations.reconnect(true);

      // The new journal holds nothing from before it began; that history is not silently empty.
      expect(
        yield* session.timeline.snapshot({ from: { at: before } }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "TimelineGap" });

      const current = yield* session.timeline.now;
      const served = yield* session.timeline.snapshot({ from: { at: current } });

      expect(served.terminal).toBeNull();
    }),
  ),
);
