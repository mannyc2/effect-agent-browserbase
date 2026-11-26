// PLAN T5: tab history must keep refs stable and selection valid when seeded or resumed.
import { assert, it } from "@effect/vitest";
import { Arbitrary, Schema } from "effect";

import * as Tabs from "../../src/ai/Tabs.ts";

it.prop(
  "models tab opening, closing and resumed selection",
  [Arbitrary.schema(Schema.Array(Schema.Int))],
  ([commands]) => {
    let open: Array<string> = ["a"];
    let state = Tabs.make(open);
    const refs = new Map<string, string>();

    for (const command of commands) {
      const id = ["a", "b", "c"][Math.abs(command) % 3]!;

      if (command % 5 === 0) open = [...new Set([...open, "b", "c"])];
      else if (command % 3 === 0) open = [...new Set([...open, id])];
      else if (command % 3 === 1) open = open.filter((known) => known !== id);

      const expected =
        open.filter((page) => !state.seen.includes(page)).at(-1) ??
        open.find((page) => page === state.shown) ??
        open[0];

      const followed = Tabs.follow(state, open, "select");

      assert.strictEqual(followed.selected, expected);

      state = followed.state;
      assert.isTrue(followed.selected === undefined || open.includes(followed.selected));
      for (const [page, ref] of Object.entries(state.refs)) {
        assert.isTrue(refs.get(page) === undefined || refs.get(page) === ref);
        refs.set(page, ref);
      }
      assert.strictEqual(new Set(Object.values(state.refs)).size, Object.keys(state.refs).length);
      const resumed = Schema.decodeSync(Tabs.Tabs)(JSON.parse(JSON.stringify(state)));

      assert.deepStrictEqual(Tabs.follow(resumed, open, "never").selected, followed.selected);
    }
  },
);

it("keeps arbitrary seeded tab refs collision-free", () => {
  const seeded = Schema.decodeSync(Tabs.Tabs)({ shown: "a", seen: ["a"], refs: { a: "tab2" } });

  const followed = Tabs.follow(seeded, ["a", "b"], "select");

  assert.strictEqual(followed.selected, "b");
  assert.notStrictEqual(followed.state.refs.a, followed.state.refs.b);
});
