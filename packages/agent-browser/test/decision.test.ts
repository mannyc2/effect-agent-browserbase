import { expect, it } from "@effect/vitest";
import { Schema } from "effect";
import * as BrowserTools from "effect-agent-browser/tools";
import { Observation, Target } from "effect-browser/browser-data";
import { type LanguageModel, Prompt } from "effect/unstable/ai";

import { candidates } from "./evaluation/Decision.ts";

const view = (text = "Observatory\nLibrary") =>
  Observation.make({
    target: Target.make({ generation: 1, pageId: "page", frameId: "frame" }),
    observationId: "fresh-reading",
    revision: 1,
    scope: "document",
    url: "http://127.0.0.1:1000/navigation",
    text,
    controls: [
      { elementId: "link", kind: "link", label: "Library", disabled: false },
      { elementId: "button", kind: "button", label: "Submit", disabled: false },
      { elementId: "disabled", kind: "link", label: "Disabled", disabled: true },
    ],
    controlsTruncated: false,
    textTruncated: false,
    viewport: {
      width: 640,
      height: 480,
      clippedText: 0,
      coveredText: 0,
      uncertainText: 0,
      unreachableControls: 0,
      exhausted: false,
    },
  });

const result = (name: string, value: Schema.Json, isFailure = false) =>
  Prompt.toolResultPart({
    id: `result-${name}`,
    name,
    result: value,
    isFailure,
    providerExecuted: false,
  });

const request = (
  parts: ReadonlyArray<Prompt.ToolResultPart> = [],
  toolChoice: LanguageModel.ProviderOptions["toolChoice"] = "auto",
) => ({
  prompt: Prompt.fromMessages([
    Prompt.userMessage({
      content: [
        Prompt.textPart({ text: "Find the field note. Start at http://127.0.0.1:1000/navigation" }),
      ],
    }),
    ...(parts.length === 0 ? [] : [Prompt.toolMessage({ content: parts })]),
  ]),
  tools: Object.values(BrowserTools.toolkit.tools),
  toolChoice,
});

it("the decision policy supplies the start address without inventing routes or answers", () => {
  const offered = candidates(request()).choices;

  expect(offered.find((candidate) => candidate.id === "start")?.action).toEqual({
    kind: "tool",
    name: "browser_navigate",
    params: { url: "http://127.0.0.1:1000/navigation" },
  });
  expect(offered.map((candidate) => candidate.id)).toEqual([
    "unresolved",
    "failed",
    "start",
    "inspect",
  ]);
});

it("the decision policy selects only observed enabled links and visible answer lines", () => {
  const offered = candidates(
    request([result("browser_inspect", Schema.encodeSync(Observation)(view()))]),
  ).choices;

  expect(offered.find((candidate) => candidate.id === "link-0")?.action).toEqual({
    kind: "tool",
    name: "browser_click",
    params: { observationId: "fresh-reading", elementId: "link" },
  });
  expect(
    offered
      .filter((candidate) => candidate.action.kind === "answer")
      .map((candidate) => candidate.description),
  ).toEqual([
    "Stop unresolved: no supplied option can safely complete the goal.",
    "Stop failed: the goal cannot be completed with this action space.",
    "Finish by returning this observed text line verbatim: Observatory",
    "Finish by returning this observed text line verbatim: Library",
  ]);
  expect(JSON.stringify(offered)).not.toMatch(/Submit|Disabled|saffron/);
});

it("a base action invalidates earlier candidates and an observed action supplies fresh references", () => {
  const old = result("browser_inspect", Schema.encodeSync(Observation)(view()));
  const clicked = result("browser_click", { url: "http://127.0.0.1:1000/navigation/library" });
  const base = candidates(request([old, clicked])).choices;

  expect(base.map((candidate) => candidate.id)).toEqual(["unresolved", "failed", "inspect"]);
  const fresh = view("Marsh survey");

  const followed = result("browser_click_and_inspect", {
    action: { url: fresh.url },
    observation: { _tag: "Available", observation: Schema.encodeSync(Observation)(fresh) },
  });

  expect(
    candidates(request([old, followed])).choices.some((candidate) =>
      candidate.description.includes("Marsh survey"),
    ),
  ).toBe(true);
});

it("unknown outcomes allow only stopping unresolved, including when later results exist", () => {
  const unknown = result("browser_click", { outcome: "unknown", reason: "Timeout" }, true);
  const later = result("browser_inspect", Schema.encodeSync(Observation)(view()));

  expect(candidates(request([unknown, later])).choices).toEqual([
    {
      id: "unresolved",
      description: "Stop unresolved: no supplied option can safely complete the goal.",
      action: { kind: "answer", output: { status: "unresolved", answer: null } },
    },
  ]);
});

it("the final-turn constraint removes tools while retaining observed answers and abstention", () => {
  const offered = candidates(
    request([result("browser_inspect", Schema.encodeSync(Observation)(view()))], "none"),
  ).choices;

  expect(offered.every((candidate) => candidate.action.kind === "answer")).toBe(true);
  expect(offered.map((candidate) => candidate.id)).toEqual([
    "unresolved",
    "failed",
    "answer-0",
    "answer-1",
  ]);
});

it("unsupported required and restricted tool choices expose no decision options", () => {
  expect(candidates(request([], "required")).choices).toEqual([]);
  expect(candidates(request([], { tool: "browser_inspect" })).choices).toEqual([]);
  expect(candidates(request([], { oneOf: ["browser_inspect"] })).choices).toEqual([]);
});

it("continuations reassemble observed lines and stop when the reading is exhausted", () => {
  const reading = Observation.make({ ...view("Field no"), textTruncated: true });

  const tools = [
    ...Object.values(BrowserTools.toolkit.tools),
    ...Object.values(BrowserTools.readingToolkit.tools),
  ];

  const before = candidates({
    ...request([result("browser_inspect", Schema.encodeSync(Observation)(reading))]),
    tools,
  });

  const after = candidates({
    ...request([
      result("browser_inspect", Schema.encodeSync(Observation)(reading)),
      result("browser_read_more", {
        observationId: reading.observationId,
        text: "te: saffron ",
        remaining: true,
      }),
      result("browser_read_more", {
        observationId: reading.observationId,
        text: "kestrel 27",
        remaining: false,
      }),
    ]),
    tools,
  });

  expect(before.choices.some((candidate) => candidate.id === "read-more")).toBe(true);
  expect(before.choices.some((candidate) => candidate.id.startsWith("answer-"))).toBe(false);
  expect(after.choices.some((candidate) => candidate.id === "read-more")).toBe(false);
  expect(after.choices.find((candidate) => candidate.id === "answer-0")?.action).toEqual({
    kind: "answer",
    output: { status: "done", answer: "Field note: saffron kestrel 27" },
  });
});

it("candidate truncation is explicit and never synthesizes a missing correct answer", () => {
  const text = [...Array.from({ length: 140 }, (_, i) => `Line ${i}`), "x".repeat(513)].join("\n");

  const offered = candidates(
    request([result("browser_inspect", Schema.encodeSync(Observation)(view(text)))]),
  );

  expect(offered.choices.length).toBeLessThanOrEqual(255);
  expect(offered.omittedTextLines).toBe(13);
  expect(offered.choices.filter((candidate) => candidate.id.startsWith("answer-")).length).toBe(
    128,
  );
  expect(
    offered.choices.some((candidate) => candidate.description.includes("correct unseen answer")),
  ).toBe(false);
});
