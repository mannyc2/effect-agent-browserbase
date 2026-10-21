// Requested capture-state model seam: lifecycle histories cannot resurrect retired transport.
import { assert, it } from "@effect/vitest";
import { Arbitrary, Schema } from "effect";

import { BrowserError, Failed } from "../src/BrowserError.ts";
import { initial, step, type State } from "../src/internal/pictures/state.ts";

const history = Arbitrary.schema(
  Schema.Array(Schema.Literals(["Pause", "Resume", "Stop", "Fail"])).check(Schema.isMaxLength(100)),
);

it.prop(
  "retirement is absorbing and failure stays attached through every later input",
  { history },
  ({ history }) => {
    let state: State = initial;
    let stopped = false;
    let firstFailure: BrowserError | undefined;

    for (const [index, input] of history.entries()) {
      stopped ||= input === "Stop" || input === "Fail";

      const failure =
        input === "Fail"
          ? new BrowserError({
              operation: "screencast",
              dispatched: false,
              reason: new Failed({ detail: `transport lost at history step ${index}` }),
            })
          : undefined;

      firstFailure ??= failure;
      state = step(state, input === "Fail" ? { _tag: "Stop", failure } : { _tag: input });
      assert.strictEqual(state._tag === "Stopped", stopped);
      if (state._tag === "Stopped") assert.strictEqual(state.failure, firstFailure);
    }
  },
  { arbitrary: { runs: 5000 } },
);
