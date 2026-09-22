import { expect, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";
import { fromSession, interactiveLayer } from "effect-agent-browser/adapter";
import { InteractiveBrowser, InteractiveBrowserPolicy } from "effect-agent/interactive-browser";
import { BrowserError, Reasons } from "effect-browser/errors";

import { scriptedSession } from "./fixtures/ScriptedSession.ts";

const policy = InteractiveBrowserPolicy.make({
  network: { _tag: "Unrestricted" },
  maxActions: 10,
  maxElapsedMillis: 60000,
  maxReturnedBytes: 1024,
});

it.effect(
  "the common adapter refuses unsupported policy before calling either provider opener",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let opens = 0;

        const context = yield* Layer.build(
          interactiveLayer({
            implementation: "test-browser",
            open: () => {
              opens++;

              return Effect.die("The opener must not run");
            },
          }),
        );

        expect(opens).toBe(0);
        const browser = Context.get(context, InteractiveBrowser);

        for (const network of [
          { _tag: "PublicWeb" } as const,
          { _tag: "ExactHosts", allowedHosts: ["example.com"] } as const,
        ]) {
          const error = yield* browser
            .open(InteractiveBrowserPolicy.make({ ...policy, network }))
            .pipe(Effect.flip);

          expect(error._tag).toBe("InteractiveBrowserUnsupportedError");
        }
        expect(opens).toBe(0);
      }),
    ),
);

it.effect(
  "acquisition errors stay private and opener finalizers belong to the failed execution",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let closes = 0;

        const context = yield* Layer.build(
          interactiveLayer({
            implementation: "test-browser",
            open: () =>
              Effect.gen(function* () {
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => {
                    closes++;
                  }),
                );

                return yield* Effect.fail({ secret: "PRIVATE-ACQUISITION-CAUSE" });
              }),
          }),
        );

        const browser = Context.get(context, InteractiveBrowser);
        const error = yield* Effect.scoped(browser.open(policy)).pipe(Effect.flip);

        expect(error._tag).toBe("InteractiveBrowserActionError");
        expect(JSON.stringify(error)).not.toContain("PRIVATE-ACQUISITION-CAUSE");
        expect(closes).toBe(1);
      }),
    ),
);

it.effect("adaptation retains lazily and the framework layer translates failed retention", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let retained = 0;

      const expected = BrowserError.make({
        operation: "handle",
        reason: Reasons.Busy.make({}),
        outcome: "undispatched",
      });

      const browser = scriptedSession({
        retain: Effect.suspend(() => {
          retained++;

          return Effect.fail(expected);
        }),
      });

      const pending = fromSession(browser, { selection: "retained" });

      expect(retained).toBe(0);
      const invalid = { selection: "current" as const };

      Reflect.deleteProperty(invalid, "selection");
      const invalidSelection = yield* fromSession(browser, invalid).pipe(Effect.flip);

      expect(invalidSelection).toMatchObject({
        operation: "configure",
        reason: { _tag: "Configuration", path: "selection" },
        outcome: "undispatched",
      });
      expect(retained).toBe(0);
      const current = yield* fromSession(browser, { selection: "current" });

      expect(current.browser).toBe(browser);
      expect(retained).toBe(0);
      expect(yield* pending.pipe(Effect.flip)).toBe(expected);
      expect(retained).toBe(1);

      const context = yield* Layer.build(
        interactiveLayer({
          implementation: browser.implementation,
          open: () => Effect.succeed(browser),
        }),
      );

      const error = yield* Context.get(context, InteractiveBrowser).open(policy).pipe(Effect.flip);

      expect(error._tag).toBe("InteractiveBrowserBusyError");
      expect(retained).toBe(2);
    }),
  ),
);

it.effect("only factual supported limits map to the framework's stricter limit schema", () =>
  Effect.gen(function* () {
    for (const [dimension, maximum, limit] of [
      ["actions", 7, "actions"],
      ["elapsed", 20, "elapsed"],
      ["returned-bytes", 80, "returned-bytes"],
      ["pages", 2, undefined],
      ["buffered-bytes", 0, undefined],
      ["actions", 0, undefined],
    ] as const) {
      const source = BrowserError.make({
        operation: "read-text",
        reason: Reasons.Limit.make({ dimension, maximum, observed: maximum + 1 }),
        outcome: "undispatched",
      });

      const browser = scriptedSession({ readText: () => Effect.fail(source) });
      const adapted = yield* fromSession(browser, { selection: "current" });
      const error = yield* adapted.handle.readText({}).pipe(Effect.flip);

      if (limit === undefined) {
        expect(error._tag).toBe("InteractiveBrowserActionError");
        expect(error).not.toHaveProperty("maximum");
      } else {
        expect(error).toMatchObject({
          _tag: "InteractiveBrowserLimitError",
          limit,
          maximum,
          observed: maximum + 1,
        });
      }
      expect(error).not.toHaveProperty("outcome");
      expect(error).not.toHaveProperty("cause");
    }
  }),
);

it.effect(
  "a concrete checked receipt is retained on the browser while framework close returns void",
  () =>
    Effect.gen(function* () {
      const receipt = Object.freeze({ confirmed: true });
      let closes = 0;

      const browser = {
        ...scriptedSession(),
        closeChecked: Effect.sync(() => {
          closes++;

          return receipt;
        }),
      };

      const adapted = yield* fromSession(browser, { selection: "current" });

      expect(adapted.browser).toBe(browser);
      expect(yield* adapted.handle.close).toBeUndefined();
      expect(closes).toBe(1);
    }),
);
