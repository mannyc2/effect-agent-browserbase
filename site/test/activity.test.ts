// What the agent was doing, as a replay keeps it and the player shows it: its trace reduced to
// thinking, looking, acting, waiting and reporting; a look shown before the thinking on it; what it
// decided, dimmed while it thinks about the next; and the narration in pieces read at a glance.
import { assert, describe, it } from "@effect/vitest";
import { RecordedSpan } from "bench/Recording.ts";

import { decisionAt, lookMillis, phaseAt } from "../src/player/derive.ts";
import { activityOf, captionChunks } from "../src/replay.ts";
import { replay } from "./fixture.ts";

const span = (id: string, parent: string | null, name: string, start: number, end: number) =>
  new RecordedSpan({
    id,
    parent,
    name,
    start,
    end,
    attributes: { session: "a hosted session's id" },
    failed: false,
  });

describe("activityOf", () => {
  it("keeps what the agent did and when, and none of the trace's attributes", () => {
    const activity = activityOf([
      span("run", null, "demo.take", 0, 100),
      span("agent", "run", "invoke_agent bench-arm-5", 1, 90),
      span("shot", "agent", "Page.screenshot", 2, 3),
      span("model", "agent", "AgentRuntime.model", 3, 10),
      span("click", "agent", "execute_tool click_at", 10, 12),
      span("still", "agent", "execute_tool wait_still", 12, 20),
      span("done", "agent", "execute_tool done", 20, 21),
      // The narrator's pictures are not the agent's looks.
      span("narrator", "run", "Page.screenshot", 5, 6),
    ]);

    assert.deepStrictEqual(
      activity.map(({ kind, tool, start }) => [kind, tool, start]),
      [
        ["look", undefined, 2],
        ["think", undefined, 3],
        ["act", "click_at", 10],
        ["wait", "wait_still", 12],
        ["report", "done", 20],
      ],
    );
    assert.ok(activity.every((each) => !JSON.stringify(each).includes("session")));
  });
});

describe("phaseAt", () => {
  const phase = (now: number) => phaseAt(replay, [], now);

  it("shows a screenshot as a look before the thinking on it, and a read of the page as one", () => {
    assert.deepStrictEqual(phase(9420), {
      kind: "look",
      label: "Looking at the screen",
      since: 9350,
      failed: false,
    });
    assert.strictEqual(phase(9350 + lookMillis)?.label, "Thinking");
    assert.strictEqual(phase(10_500)?.since, 9400);
    assert.strictEqual(phase(2000 + lookMillis - 1)?.label, "Reading the page");
    assert.strictEqual(phase(20_000), undefined);
  });

  it("names a browser action for what it acted on", () => {
    const spans = [{ start: 12_100, end: 12_900, label: "Clicking “Crypto”", ok: true }];

    assert.strictEqual(phaseAt(replay, spans, 12_500)?.label, "Clicking “Crypto”");
  });
});

describe("decisionAt", () => {
  it("shows what the agent last decided, dimmed while it thinks about the next", () => {
    assert.strictEqual(decisionAt(replay, 5000), undefined);
    assert.deepStrictEqual(decisionAt(replay, 12_500), {
      text: "Opening the ceasefire market.",
      at: 12_000,
      thinking: false,
    });
  });
});

describe("captionChunks", () => {
  const opening =
    "Welcome, everyone. The agent is going to play a slot machine drawn entirely on a canvas, with no text behind it, so it has to read the reels, balance, and every win from the picture. Let's watch.";

  it("breaks a long line after its sentences and clauses into pieces of two short lines", () => {
    const pieces = captionChunks(opening, 0, 20_000);

    assert.deepStrictEqual(
      pieces.map((piece) => piece.text),
      [
        "Welcome, everyone.",
        "The agent is going to play a slot machine drawn entirely on a canvas,",
        "with no text behind it, so it has to read the reels,",
        "balance, and every win from the picture.",
        "Let's watch.",
      ],
    );
    assert.strictEqual(pieces[0]?.at, 0);
    assert.strictEqual(pieces.at(-1)?.end, 20_000);
    assert.ok(pieces.every((piece, index) => index === 0 || piece.at === pieces[index - 1]?.end));
  });
});
