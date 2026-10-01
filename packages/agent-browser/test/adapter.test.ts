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

it.effect("adaptation authenticates the exact Session and Page when acquired", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* scriptedSession();
      const foreign = yield* scriptedSession();
      const pending = fromSession(browser, browser.initialPage);
      const current = yield* pending;

      expect(current.browser).toBe(browser);
      for (const page of [foreign.initialPage, { ...browser.initialPage }]) {
        expect(yield* fromSession(browser, page).pipe(Effect.flip)).toMatchObject({
          operation: "target",
          reason: { _tag: "UnregisteredSession" },
          outcome: "undispatched",
        });
      }
      yield* browser.initialPage.close();
      expect(yield* pending.pipe(Effect.flip)).toMatchObject({ reason: { _tag: "Stale" } });

      const context = yield* Layer.build(
        interactiveLayer({
          implementation: browser.implementation,
          open: () => Effect.succeed(browser),
        }),
      );

      expect(
        yield* Context.get(context, InteractiveBrowser).open(policy).pipe(Effect.flip),
      ).toMatchObject({ _tag: "InteractiveBrowserExpiredError" });
    }),
  ),
);

it.effect("a drifted target is an undispatched action failure, not an expired handle", () =>
  Effect.gen(function* () {
    const source = BrowserError.make({
      operation: "read-text",
      reason: Reasons.Drifted.make({}),
      outcome: "undispatched",
    });

    const browser = yield* scriptedSession({ readText: () => Effect.fail(source) });
    const adapted = yield* fromSession(browser, browser.initialPage);

    expect(yield* adapted.handle.readText({}).pipe(Effect.flip)).toMatchObject({
      _tag: "InteractiveBrowserActionError",
      operation: "read-text",
      message: "The browser action was not dispatched",
    });
  }),
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

      const browser = yield* scriptedSession({ readText: () => Effect.fail(source) });
      const adapted = yield* fromSession(browser, browser.initialPage);
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
      let closes = 0;
      const browser = yield* scriptedSession();
      const original = browser.closeChecked;

      Object.assign(browser, {
        closeChecked: original.pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              closes++;
            }),
          ),
        ),
      });

      const adapted = yield* fromSession(browser, browser.initialPage);

      expect(adapted.browser).toBe(browser);
      expect(yield* adapted.handle.close).toBeUndefined();
      expect(closes).toBe(1);
      expect(yield* adapted.browser.closeChecked).toMatchObject({
        reference: browser.reference,
        connection: "closed",
      });
    }),
);
