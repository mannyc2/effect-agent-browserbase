// A failed local finalizer must not skip the paid provider's remote retirement.
import { assert, it } from "@effect/vitest";
import { Effect, Exit, Scope } from "effect";
import * as Released from "effect-browser/Released";

import { releasing } from "../src/internal/releasing.ts";

it.effect("attempts remote release after a local cleanup defect and reports Unconfirmed", () =>
  Effect.gen(function* () {
    const browser = yield* Scope.make();

    yield* Scope.addFinalizer(browser, Effect.die("local cleanup defect"));
    let ended = 0;

    const outcome = yield* releasing(
      browser,
      Effect.sync(() => {
        ended++;

        return new Released.Settled();
      }),
    ).pipe(Effect.exit);

    assert.strictEqual(ended, 1);
    assert.isTrue(Exit.isSuccess(outcome));
    if (Exit.isSuccess(outcome)) {
      assert.strictEqual(outcome.value._tag, "Unconfirmed");
      if (outcome.value._tag === "Unconfirmed")
        assert.include(outcome.value.detail, "cleanup failed");
    }
  }),
);
