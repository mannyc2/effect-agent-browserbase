// PLAN T5: tab history must keep refs stable and selection valid when seeded or resumed.
import { assert, it } from "@effect/vitest";
import { Arbitrary, Effect, Schema } from "effect";
import { Frame, Screenshot } from "effect-browser/Frame";
import { Window } from "effect-browser/Window";
import { Prompt } from "effect/ai";

import * as AdapterState from "../src/AdapterState.ts";

it.prop(
  "models tab opening, closing and resumed selection",
  [Arbitrary.schema(Schema.Array(Schema.Int))],
  ([commands]) => {
    let open: Array<string> = ["a"];
    let state = AdapterState.tabs(open);
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

      const followed = AdapterState.follow(state, open, "select");

      assert.strictEqual(followed.selected, expected);

      state = followed.state;
      assert.isTrue(followed.selected === undefined || open.includes(followed.selected));
      for (const [page, ref] of Object.entries(state.refs)) {
        assert.isTrue(refs.get(page) === undefined || refs.get(page) === ref);
        refs.set(page, ref);
      }
      assert.strictEqual(new Set(Object.values(state.refs)).size, Object.keys(state.refs).length);
      const resumed = Schema.decodeSync(AdapterState.Tabs)(JSON.parse(JSON.stringify(state)));

      assert.deepStrictEqual(
        AdapterState.follow(resumed, open, "never").selected,
        followed.selected,
      );
    }
  },
);

it.effect("loads a finished seed and keeps arbitrary seeded tab refs collision-free", () =>
  Effect.gen(function* () {
    const seed = yield* AdapterState.load({
      history: { content: [{ role: "user", content: [{ type: "text", text: "Continue" }] }] },
      tabs: { shown: "a", seen: ["a"], refs: { a: "tab2" } },
      zooms: [],
      observations: [],
    });

    const followed = AdapterState.follow(seed.tabs!, ["a", "b"], "select");

    assert.strictEqual(followed.selected, "b");
    assert.notStrictEqual(followed.state.refs.a, followed.state.refs.b);
  }),
);

it("keeps seeded context placement idempotent and the latest three pictures bounded", () => {
  const source = Prompt.make("task");
  const picture = Prompt.userMessage({ content: [Prompt.textPart({ text: "picture" })] });

  const previous = new Window({
    page: "a",
    since: 0,
    until: 1,
    events: [],
    frames: [],
    missing: [],
  });

  let state = AdapterState.moments();

  for (let turn = 0; turn < 5; turn++) {
    const account = {
      turn: `turn${turn}`,
      after: 1,
      message: Prompt.userMessage({ content: [Prompt.textPart({ text: `account${turn}` })] }),
    };

    state = AdapterState.place(state, account, picture, previous);
    assert.strictEqual(AdapterState.place(state, account, picture, previous), state);
  }
  assert.lengthOf(state.placed, 5);
  assert.lengthOf(state.recent, 3);
  const loaded = Schema.decodeSync(AdapterState.Moments)(JSON.parse(JSON.stringify(state)));

  assert.strictEqual(AdapterState.weave(source, loaded.placed).content.length, 6);
});

it.effect("restores a serialized continuation with picture bytes and its finished history", () =>
  Effect.gen(function* () {
    const frame = new Frame({
      page: "a",
      session: "local",
      connection: "local",
      data: new Uint8Array([1, 2, 3]),
      timing: new Screenshot({ hostTime: 1, uncertaintyMillis: 0 }),
      receivedAt: 1,
      width: 1,
      height: 1,
      document: 0,
      url: "about:blank",
    });

    const previous = new Window({
      page: "a",
      since: 0,
      until: 1,
      events: [],
      frames: [frame],
      missing: [],
    });

    const seed = new AdapterState.Seed({
      history: Prompt.make("Continue from the saved turn"),
      moments: new AdapterState.Moments({ placed: [], recent: [], previous }),
      zooms: [],
      observations: [],
    });

    const json = yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.toCodecJson(AdapterState.Seed)),
    )(seed);

    const loaded = yield* AdapterState.load(JSON.parse(json));

    assert.deepStrictEqual(loaded.moments?.previous?.frames[0]?.data, frame.data);
    assert.deepStrictEqual(loaded.history, seed.history);
  }),
);
