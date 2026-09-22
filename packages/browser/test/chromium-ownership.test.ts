import { expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Redacted } from "effect";
import * as Bootstrap from "effect-browser/bootstrap";
import { BrowserError, Reasons } from "effect-browser/errors";

import { BrowserPolicy } from "../src/BrowserData.ts";
import { Chromium, ChromiumReference, type ChromiumCleanupResult } from "../src/Chromium.ts";
import { borrowedChromium, makeChromiumCleanup } from "../src/internal/chromium/Session.ts";

const reference = ChromiumReference.make({ provider: "chromium", id: "one-local-lifetime" });

const failed = BrowserError.make({
  operation: "close",
  reason: Reasons.Failed.make({}),
  outcome: "unknown",
});

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

it.effect(
  "checked borrowed cleanup returns the canonical receipt once, including scope finalization",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const reports: ChromiumCleanupResult[] = [];

      const mark = (step: string) =>
        Effect.sync(() => {
          calls.push(step);
        });

      const receipt = yield* Effect.scoped(
        Effect.gen(function* () {
          const lease = yield* borrowedChromium(
            Redacted.make("ws://127.0.0.1:9222/devtools/browser/borrowed-fixture"),
            (result) =>
              Effect.sync(() => {
                reports.push(result);
              }),
          )(
            {
              fence: mark("fence"),
              capture: mark("capture"),
              initialization: mark("initialization"),
              disconnect: mark("disconnect").pipe(Effect.as("closed" as const)),
            },
            1000,
          );

          expect(Option.isNone(yield* lease.cleanupResult)).toBe(true);

          const [first, repeated, released] = yield* Effect.all(
            [lease.closeChecked, lease.closeChecked, lease.release],
            { concurrency: 3 },
          );

          expect(repeated).toBe(first);
          expect(released).toBe(first);
          expect(Option.getOrUndefined(yield* lease.cleanupResult)).toBe(first);
          expect(first).toMatchObject({
            reference: lease.reference,
            ownership: "borrowed",
            connection: "closed",
            process: "not-owned",
            issues: [],
          });
          expect(Object.isFrozen(first)).toBe(true);
          expect(Object.isFrozen(first.issues)).toBe(true);
          expect("remote" in first).toBe(false);

          return first;
        }),
      );

      expect(calls).toEqual(["fence", "capture", "initialization", "disconnect"]);
      expect(reports).toHaveLength(1);
      expect(reports[0]).toBe(receipt);
    }),
);

it.effect(
  "a borrowed cleanup reports pending connection facts without claiming checked success",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cleanup = yield* borrowedChromium(
          Redacted.make("ws://127.0.0.1:9222/devtools/browser/borrowed-fixture"),
        )(
          {
            fence: Effect.void,
            capture: Effect.void,
            initialization: Effect.void,
            disconnect: Effect.succeed("pending"),
          },
          1000,
        );

        const result = yield* cleanup.release;

        expect(result.ownership).toBe("borrowed");
        expect(result.process).toBe("not-owned");
        expect(result.connection).toBe("pending");
        expect(result.issues).toEqual([]);
        expect(yield* Effect.result(cleanup.closeChecked)).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "BrowserError",
            operation: "close",
            reason: { _tag: "Failed" },
            outcome: "unknown",
          },
        });
        expect(yield* cleanup.release).toBe(result);
        expect(Option.getOrUndefined(yield* cleanup.cleanupResult)).toBe(result);
      }),
    ),
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

          expect(error).toMatchObject({
            _tag: "BrowserError",
            reason: { _tag: "Configuration" },
            outcome: "undispatched",
          });
        }
        expect(reports).toEqual([]);
        for (const bootstrap of [Bootstrap.empty, undefined]) {
          const misplaced = { launch: {}, bootstrap };
          const error = yield* Layer.build(Chromium.layer(misplaced)).pipe(Effect.flip);

          expect(error).toMatchObject({
            operation: "configure",
            reason: { _tag: "Configuration" },
            outcome: "undispatched",
          });
        }
        for (const arg of [
          "--no-sandbox",
          "--remote-debugging-port=9222",
          "--user-data-dir=/other",
          "--proxy-server=http://other:8080",
        ]) {
          const error = yield* Layer.build(Chromium.layer({ launch: { args: [arg] } })).pipe(
            Effect.flip,
          );

          expect(error.reason._tag).toBe("Configuration");
        }
      }),
    ),
);
