// 1d6d7c7: repeated press validated each gap after sending input and never bounded the total.
import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import * as Chromium from "../src/providers/Chromium.ts";
import * as Style from "../src/Style.ts";

for (const [gap, times] of [
  [20_000, 2],
  [5_100, 3],
] as const)
  it.live(`refuses repeated press gap ${gap} x ${times} before any keydown`, () =>
    Effect.gen(function* () {
      const browser = yield* Chromium.open();

      const page = yield* browser.newPage(
        "data:text/html,<script>window.presses=0;onkeydown=()=>window.presses++</script>",
      );

      const result = yield* page
        .press("A", { times })
        .pipe(Style.provide({ ...Style.plain, keyGap: Effect.succeed(gap) }), Effect.result);

      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.strictEqual(result.failure.reason._tag, "InvalidRequest");
        assert.isFalse(result.failure.dispatched);
      }
      assert.strictEqual(
        (yield* page.read(() => Reflect.get(window, "presses"), {
          arg: undefined,
          result: Schema.Finite,
        })).value,
        0,
      );
    }).pipe(Effect.scoped),
  );
