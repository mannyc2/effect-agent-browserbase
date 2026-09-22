import { expect, it } from "@effect/vitest";
import { Effect, Layer, Redacted } from "effect";
import { BrowserError } from "effect-browser/errors";

import { BrowserPolicy } from "../src/BrowserData.ts";
import { Chromium, ChromiumReference, type ChromiumCleanupResult } from "../src/Chromium.ts";
import { makeChromiumCleanup } from "../src/internal/chromium/Session.ts";

const reference = ChromiumReference.make({ provider: "chromium", id: "one-local-lifetime" });
const failed = BrowserError.make({ operation: "close", reason: "failed", outcome: "unknown" });

it.effect(
  "local cleanup continues to process termination after capture and disconnect fail, once",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];

      const mark = (name: string) =>
        Effect.sync(() => {
          calls.push(name);
        });

      const cleanup = yield* makeChromiumCleanup(
        reference,
        {
          fence: mark("fence"),
          capture: mark("capture").pipe(Effect.andThen(Effect.fail(failed))),
          initialization: mark("initialization"),
          disconnect: mark("disconnect").pipe(Effect.andThen(Effect.fail(failed))),
        },
        {
          connection: () => Effect.succeed(Redacted.make("unused")),
          terminate: mark("terminate"),
          removeProfile: mark("profile"),
        },
      );

      const [first, second] = yield* Effect.all([cleanup.close, cleanup.close], { concurrency: 2 });

      expect(second).toBe(first);
      expect(calls).toEqual([
        "fence",
        "capture",
        "initialization",
        "disconnect",
        "terminate",
        "profile",
      ]);
      expect(first.connection).toBe("failed");
      expect(first.process).toBe("terminated");
      expect(first.issues.map((issue) => issue.step)).toEqual(["capture", "disconnect"]);
      expect("remote" in first).toBe(false);
      expect("sessionId" in first.reference).toBe(false);
    }),
);

it.effect(
  "uncertain local process termination retains its profile and never becomes confirmed cleanup",
  () =>
    Effect.gen(function* () {
      let removed = false;

      const cleanup = yield* makeChromiumCleanup(
        reference,
        {
          fence: Effect.void,
          capture: Effect.void,
          initialization: Effect.void,
          disconnect: Effect.succeed("closed"),
        },
        {
          connection: () => Effect.succeed(Redacted.make("unused")),
          terminate: Effect.fail(failed),
          removeProfile: Effect.sync(() => {
            removed = true;
          }),
        },
      );

      const result = yield* cleanup.close;

      expect(result.connection).toBe("closed");
      expect(result.process).toBe("unknown");
      expect(result.issues.map((issue) => issue.step)).toEqual(["terminate"]);
      expect(removed).toBe(false);
    }),
);

it.effect("a borrowed cleanup reports connection facts without any process release authority", () =>
  Effect.gen(function* () {
    const cleanup = yield* makeChromiumCleanup(
      reference,
      {
        fence: Effect.void,
        capture: Effect.void,
        initialization: Effect.void,
        disconnect: Effect.succeed("pending"),
      },
      undefined,
    );

    const result = yield* cleanup.close;

    expect(result.ownership).toBe("borrowed");
    expect(result.process).toBe("not-owned");
    expect(result.connection).toBe("pending");
    expect(result.issues).toEqual([]);
  }),
);

it.effect(
  "local layer construction is inert and unsafe endpoint or launch overrides are refused before acquisition",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const reports: ChromiumCleanupResult[] = [];

        const context = yield* Layer.build(
          Chromium.layer({
            launch: { executablePath: "/no-such-local-chromium" },
            onCleanup: (result) =>
              Effect.sync(() => {
                reports.push(result);
              }),
          }),
        );

        for (const endpoint of [
          "wss://connect.browserbase.com/",
          "ws://example.com/devtools/browser/one",
          "http://127.0.0.1:9222",
          "ws://user:secret@127.0.0.1:9222/devtools/browser/one",
        ]) {
          const error = yield* Effect.gen(function* () {
            return yield* (yield* Chromium).attach(Redacted.make(endpoint), {
              policy: BrowserPolicy.unrestricted(),
            });
          }).pipe(Effect.provide(context), Effect.flip);

          expect(error.reason).toBe("configuration");
          expect(error._tag).toBe("BrowserError");
          if (error._tag === "BrowserError") expect(error.outcome).toBe("undispatched");
        }
        expect(reports).toEqual([]);
        for (const arg of [
          "--no-sandbox",
          "--remote-debugging-port=9222",
          "--user-data-dir=/other",
          "--proxy-server=http://other:8080",
        ]) {
          const error = yield* Layer.build(Chromium.layer({ launch: { args: [arg] } })).pipe(
            Effect.flip,
          );

          expect(error.reason).toBe("configuration");
        }
      }),
    ),
);
