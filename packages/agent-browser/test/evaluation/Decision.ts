import { Option, Schema } from "effect";
import { Observation } from "effect-browser/browser-data";
import type { LanguageModel, Prompt } from "effect/unstable/ai";

import type { Output } from "./Cases.ts";

type Request = Pick<LanguageModel.ProviderOptions, "prompt" | "tools" | "toolChoice">;

/** The controller is versioned separately from the model and never reads fixture truth. */
export const policy = "observed-links-and-text-lines-v1" as const;

export type Action =
  | { readonly kind: "tool"; readonly name: string; readonly params: Schema.Json }
  | { readonly kind: "answer"; readonly output: Output };

export interface Candidate {
  readonly id: string;
  readonly description: string;
  readonly action: Action;
}

const Followed = Schema.Struct({
  observation: Schema.TaggedStruct("Available", { observation: Observation }),
});

const UnknownOutcome = Schema.Struct({ outcome: Schema.Literal("unknown") });

const Continued = Schema.Struct({
  observationId: Schema.String,
  text: Schema.String,
  remaining: Schema.Boolean,
});

const observed = (part: Prompt.ToolResultPart): Observation | undefined => {
  if (part.isFailure) return undefined;
  const direct = Schema.decodeUnknownOption(Observation)(part.result);

  if (Option.isSome(direct)) return direct.value;
  const followed = Schema.decodeUnknownOption(Followed)(part.result);

  return Option.isSome(followed) ? followed.value.observation.observation : undefined;
};

const results = (request: Request) =>
  request.prompt.content
    .flatMap((message) => (message.role === "tool" ? message.content : []))
    .filter((part) => part.type === "tool-result");

/** Only the supplied start address can be synthesized; subsequent destinations are observed links. */
const start = (request: Request) => {
  const input = request.prompt.content
    .filter((message) => message.role === "user")
    .flatMap((message) => message.content)
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");

  return /Start at (https?:\/\/[^\s"\\]+)/.exec(input)?.[1];
};

/**
 * Candidates use the exact projected Tool results in this request. A base action invalidates
 * earlier references; an observed action supplies new ones. No selector, route, answer or
 * desired operation comes from the fixture or from a task-specific policy.
 */
export const candidates = (request: Request) => {
  // This controller's contract is deliberately limited to the AgentRuntime's auto/final turns.
  if (request.toolChoice !== "auto" && request.toolChoice !== "none")
    return { choices: [], omittedTextLines: 0, omittedLinks: 0 };
  const parts = results(request);

  const terminal: Candidate[] = [
    {
      id: "unresolved",
      description: "Stop unresolved: no supplied option can safely complete the goal.",
      action: { kind: "answer", output: { status: "unresolved", answer: null } },
    },
    {
      id: "failed",
      description: "Stop failed: the goal cannot be completed with this action space.",
      action: { kind: "answer", output: { status: "failed", answer: null } },
    },
  ];

  // The original owner remains the authority. The bridge cannot replay an uncertain action.
  if (parts.some((part) => part.isFailure && Schema.is(UnknownOutcome)(part.result)))
    return { choices: terminal.slice(0, 1), omittedTextLines: 0, omittedLinks: 0 };
  const available = new Set(request.toolChoice === "none" ? [] : request.tools.map((t) => t.name));
  const choices: Candidate[] = [...terminal];

  const tool = (
    id: string,
    description: string,
    names: ReadonlyArray<string>,
    params: Schema.Json,
  ) => {
    const name = names.find((candidate) => available.has(candidate));

    if (name !== undefined)
      choices.push({ id, description, action: { kind: "tool", name, params } });
  };

  if (parts.length === 0) {
    const url = start(request);

    if (url !== undefined)
      tool(
        "start",
        "Open the supplied starting address to begin the goal.",
        ["browser_navigate_and_inspect", "browser_navigate"],
        { url },
      );
  }
  tool(
    "inspect",
    "Read fresh bounded text and controls from the current page.",
    ["browser_inspect"],
    {
      scope: "document",
    },
  );

  let readingIndex = parts.length - 1;

  while (parts[readingIndex]?.name === "browser_read_more" && !parts[readingIndex]?.isFailure)
    readingIndex--;
  const latest = parts[readingIndex];
  const view = latest === undefined ? undefined : observed(latest);

  if (view === undefined) return { choices, omittedTextLines: 0, omittedLinks: 0 };
  const links = view.controls.filter((control) => control.kind === "link" && !control.disabled);

  for (const [index, link] of links.slice(0, 64).entries())
    tool(
      `link-${index}`,
      `Follow observed link: ${link.label}`,
      ["browser_click_and_inspect", "browser_click"],
      { observationId: view.observationId, elementId: link.elementId },
    );
  for (const direction of [-1, 1])
    tool(
      direction === 1 ? "scroll-down" : "scroll-up",
      `Scroll ${direction === 1 ? "down" : "up"} and inspect before acting.`,
      ["browser_scroll_and_inspect", "browser_scroll"],
      { deltaY: direction * 600, deltaX: 0 },
    );

  const continuations = parts.slice(readingIndex + 1).flatMap((part) => {
    const decoded = Schema.decodeUnknownOption(Continued)(part.result);

    return Option.isSome(decoded) && decoded.value.observationId === view.observationId
      ? [decoded.value]
      : [];
  });

  const remaining = continuations.at(-1)?.remaining ?? view.textTruncated;

  if (remaining)
    tool("read-more", "Read the next text segment from this observation.", ["browser_read_more"], {
      observationId: view.observationId,
    });

  const text = view.text + continuations.map((segment) => segment.text).join("");
  const textLines = text.split(/\r?\n/);

  // A trailing partial line is not yet an option to return verbatim.
  if (remaining) textLines.pop();

  const lines = [
    ...new Set(textLines.map((line) => line.trim()).filter((line) => line.length > 0)),
  ];

  const bounded = lines.filter((line) => Buffer.byteLength(line) <= 512).slice(0, 128);

  for (const [index, line] of bounded.entries())
    choices.push({
      id: `answer-${index}`,
      description: `Finish by returning this observed text line verbatim: ${line}`,
      action: { kind: "answer", output: { status: "done", answer: line } },
    });

  return {
    choices,
    omittedTextLines: lines.length - bounded.length,
    omittedLinks: Math.max(0, links.length - 64),
  };
};
