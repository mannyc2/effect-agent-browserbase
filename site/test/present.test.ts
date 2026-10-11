// What a visitor reads for a recorded call, answer and time: words, never refs, nulls or tags.
import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";

import { clock, describeCall, fields, items } from "../src/present.ts";

const malformed = {
  _tag: "AiError",
  reason: {
    _tag: "ToolParameterValidationError",
    description: 'Expected number | undefined\n  at ["x"]',
  },
};

describe("describeCall", () => {
  it("names what a click hit, from the subject its receipt records", () => {
    const params = { ref: "e4", x: 0, y: 0, double: false, button: "left" };

    const receipt = (name: string, tag: string) => ({
      did: "Clicked it.",
      action: { name: "click", subject: { role: null, name, tag, context: {} } },
    });

    assert.strictEqual(
      describeCall(
        { name: "browser_click", params },
        { result: receipt("Reject all", "button"), isFailure: false },
      ).text,
      "Clicked “Reject all”",
    );
    assert.strictEqual(
      describeCall(
        { name: "browser_click", params },
        { result: receipt("", "canvas"), isFailure: false },
      ).text,
      "Clicked the game canvas",
    );
  });

  it("says why a call was refused and keeps the tool's message out of the text", () => {
    const words = describeCall(
      { name: "browser_click", params: { ref: "e4", x: null, y: null } },
      { result: malformed, isFailure: true },
    );

    assert.deepInclude(words, {
      text: "Click",
      failed: true,
      why: "rejected: the request was malformed",
    });
    assert.notInclude(`${words.text} ${words.why}`, "e4");
    assert.include(words.technical, "ToolParameterValidationError");
  });

  it("tells an act call's actions in order, without their refs", () => {
    const words = describeCall(
      {
        name: "act",
        params: {
          actions: [
            { kind: "fill", ref: "e3", value: "Ada" },
            { kind: "select", ref: "e5", value: "Ethereum" },
            { kind: "click", ref: "e7" },
          ],
        },
      },
      { result: { completed: 3 }, isFailure: false },
    );

    assert.strictEqual(words.text, "Typed “Ada”, chose “Ethereum” and clicked");
    assert.strictEqual(
      describeCall(
        { name: "act", params: { action: { kind: "click", ref: "e7" } } },
        { result: "the ref was gone", isFailure: true },
      ).text,
      "Click",
    );
  });

  it("carries a finishing call's answer", () => {
    assert.deepStrictEqual(
      describeCall(
        { name: "done", params: { answer: { credits: 1230 } } },
        { result: "Done.", isFailure: false },
      ).answer,
      { credits: 1230 },
    );
  });
});

describe("fields", () => {
  it("labels and formats an answer the way its page shows it", () => {
    assert.deepStrictEqual(
      fields({ change1h: -3.33, multiplier: 5, movedSharply: true, someNewField: 1230 }).map(
        (field) => `${field.label}: ${field.value}`,
      ),
      [
        "1-hour change: −3.33%",
        "Final multiplier: ×5",
        "Moved sharply: Yes",
        "Some new field: 1,230",
      ],
    );
  });
});

describe("clock", () => {
  it("reads both ends of a recording alike", () => {
    assert.strictEqual(clock(4200, 8000), "0:04.2");
    assert.strictEqual(clock(4200, 203_000), "0:04");
    assert.strictEqual(clock(203_000, 203_000), "3:23");
  });
});

describe("describeCall with the page's names", () => {
  it("names what an action clicked and typed into, by the ref the agent used", () => {
    const subjectOf = (ref: string) => ({ e4: "Tech", e81: "Search" })[ref];

    assert.strictEqual(
      describeCall(
        {
          name: "act",
          params: {
            actions: [
              { kind: "fill", ref: "e81", value: "AI model end of October" },
              { kind: "click", ref: "e4" },
            ],
          },
        },
        undefined,
        subjectOf,
      ).text,
      "Typed “AI model end of October” into “Search” and clicked “Tech”",
    );
  });

  it("says where a navigation went and which way a scroll moved", () => {
    assert.strictEqual(
      describeCall({ name: "navigate", params: { url: "https://polymarket.com/tech" } }, undefined)
        .text,
      "Opened polymarket.com/tech",
    );
    assert.strictEqual(
      describeCall({ name: "scroll", params: { ref: null, deltaY: -600 } }, undefined).text,
      "Scrolled up",
    );
  });
});

describe("items", () => {
  it("reads an answer that is one list of records as items of fields", () => {
    const listed = items({ markets: [{ title: "Rain?", outcome: "Yes", chance: 69 }] });

    assert.isTrue(Option.isSome(listed));
    assert.deepStrictEqual(
      Option.getOrThrow(listed)[0]?.map((field) => [field.label, field.value]),
      [
        ["Market", "Rain?"],
        ["Outcome", "Yes"],
        ["Chance", "69%"],
      ],
    );
    assert.isTrue(Option.isNone(items({ ticker: "BTC", price: 1 })));
  });
});
