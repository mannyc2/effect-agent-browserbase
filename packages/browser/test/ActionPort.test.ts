/** Invalid public actions retain repair guidance without retaining rejected input values. */
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import type { Action } from "../src/Action.ts";
import * as ActionPort from "../src/ActionPort.ts";
import { Failed, undispatched } from "../src/BrowserError.ts";

const bad = (action: unknown) => action as Action;

for (const [label, action, operation, path, expected] of [
  ["ref", { _tag: "Click", target: "12" }, "click", "target", "ref"],
  [
    "nested ref",
    { _tag: "Type", text: "private", options: { into: "12" } },
    "type",
    "options.into",
    "ref",
  ],
  [
    "nonfinite option",
    { _tag: "Scroll", options: { dy: Infinity } },
    "scroll",
    "options.dy",
    "finite",
  ],
  [
    "nonfinite point",
    { _tag: "Hover", target: { x: Number.NaN, y: 2 } },
    "hover",
    "target.x",
    "finite",
  ],
  ["navigation URL", { _tag: "Goto", url: 42 }, "navigate", "url", "string"],
] as const) {
  it.effect("action decoding explains an invalid " + label + " before dispatch", () =>
    Effect.gen(function* () {
      let performed = false;

      const perform = ActionPort.checked(() =>
        Effect.sync(() => {
          performed = true;
        }),
      );

      const error = yield* Effect.flip(perform(bad(action)));

      assert.strictEqual(error.operation, operation);
      assert.strictEqual(error.reason._tag, "InvalidRequest");
      assert.include(error.message, path);
      assert.include(error.message, expected);
      assert.isFalse(error.dispatched);
      assert.isFalse(performed);
    }),
  );
}

it.effect(
  "action diagnostics never echo rejected values, secret text, or arbitrary object keys",
  () =>
    Effect.gen(function* () {
      const secret = "SENTINEL-private-token-do-not-echo";

      const perform = ActionPort.checked(() => Effect.die("invalid action reached dispatch"));

      for (const action of [
        { _tag: "Type", text: secret, options: { into: secret, secret: true } },
        { _tag: "Type", text: { [secret]: secret, toString: () => secret } },
        { _tag: "Click", target: { [secret]: secret, x: secret, y: 1 } },
        { _tag: "Select", ref: "e1", values: [{ [secret]: secret }] },
        { _tag: secret, text: secret },
      ]) {
        const error = yield* Effect.flip(perform(bad(action)));

        assert.strictEqual(error.reason._tag, "InvalidRequest");
        assert.notInclude(error.message, secret);
        assert.notInclude(JSON.stringify(error), secret);
        assert.isFalse(error.dispatched);
      }
    }),
);

it.effect("checked actions preserve valid payloads and execution failures", () =>
  Effect.gen(function* () {
    const action: Action = { _tag: "Type", text: "private", options: { secret: true, into: "e1" } };
    const failure = undispatched("type", new Failed({ detail: "provider failure" }));

    const perform = ActionPort.checked((decoded) =>
      Effect.sync(() => assert.deepStrictEqual(decoded, action)).pipe(
        Effect.andThen(Effect.fail(failure)),
      ),
    );

    assert.strictEqual(yield* Effect.flip(perform(action)), failure);
  }),
);
