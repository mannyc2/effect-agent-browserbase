// Moments must stay where they were placed, and a finished run must resume with its tabs, moments
// and pictures.
import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Frame, Screenshot } from "effect-browser/Frame";
import { Window } from "effect-browser/Window";
import { Prompt } from "effect/ai";

import * as Moments from "../src/Moments.ts";
import * as YieldedTools from "../src/YieldedTools.ts";

it.effect("loads a finished seed with its tabs", () =>
  Effect.gen(function* () {
    const seed = yield* YieldedTools.load({
      history: { content: [{ role: "user", content: [{ type: "text", text: "Continue" }] }] },
      tabs: { shown: "a", seen: ["a"], refs: { a: "tab2" } },
      zooms: [],
      observations: [],
    });

    assert.deepStrictEqual(seed.tabs?.refs, { a: "tab2" });
    assert.deepStrictEqual(seed.history, Prompt.make("Continue"));
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

  let state = Moments.make();

  for (let turn = 0; turn < 5; turn++) {
    const account = {
      turn: `turn${turn}`,
      after: 1,
      message: Prompt.userMessage({ content: [Prompt.textPart({ text: `account${turn}` })] }),
    };

    state = Moments.place(state, account, picture, previous);
    assert.strictEqual(Moments.place(state, account, picture, previous), state);
  }
  assert.lengthOf(state.placed, 5);
  assert.lengthOf(state.recent, 3);
  const loaded = Schema.decodeSync(Moments.Moments)(JSON.parse(JSON.stringify(state)));

  assert.strictEqual(Moments.weave(source, loaded.placed).content.length, 6);
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

    const seed = new YieldedTools.Seed({
      history: Prompt.make("Continue from the saved turn"),
      moments: new Moments.Moments({ placed: [], recent: [], previous }),
      zooms: [],
      observations: [],
    });

    const json = yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.toCodecJson(YieldedTools.Seed)),
    )(seed);

    const loaded = yield* YieldedTools.load(JSON.parse(json));

    assert.deepStrictEqual(loaded.moments?.previous?.frames[0]?.data, frame.data);
    assert.deepStrictEqual(loaded.history, seed.history);
  }),
);
