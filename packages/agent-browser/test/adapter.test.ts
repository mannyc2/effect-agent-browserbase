import { expect, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";
import { interactiveLayer } from "effect-agent-browser/adapter";
import { InteractiveBrowser, InteractiveBrowserPolicy } from "effect-agent/interactive-browser";

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
