import * as Agent from "@yielded/agent/agent";
import * as AgentRuntime from "@yielded/agent/agent-runtime";
import type { ThreadId } from "@yielded/agent/identifiers";
import { Schema } from "effect";
import * as BrowserTools from "effect-agent-browser/tools";
import type { BrowserSession, Page } from "effect-browser/browser";
import { Toolkit } from "effect/ai";

/**
 * Each action returns the page it leaves behind, a form is one call, and text a reading left out
 * can be read on. `BrowserTools.run` provides the handlers for all of them.
 */
const toolkit = Toolkit.merge(
  BrowserTools.observedToolkit,
  BrowserTools.observedFormToolkit,
  BrowserTools.readingToolkit,
);

export const browserAgent = Agent.make("browser-example", {
  input: Schema.String,
  output: Schema.Struct({ summary: Schema.String, needsOperator: Schema.Boolean }),
  instructions: [
    BrowserTools.instructions(toolkit),
    "If the page needs a login or a decision only a person can make, stop and say so.",
  ].join("\n"),
  toolkit,
  policy: BrowserTools.policy({ maxTurns: 8, maxToolCalls: 12, maxDuration: "2 minutes" }),
});

/**
 * Every turn borrows the session acquired by the host. Pass an earlier result's `threadId` to
 * continue that conversation. The caller provides the thread store and its LanguageModel.
 */
export const turns = <E>(
  browser: BrowserSession<E>,
  page: Page,
  request: string,
  threadId?: ThreadId,
) =>
  BrowserTools.run(
    browser,
    page,
    AgentRuntime.run(browserAgent, request, threadId === undefined ? {} : { threadId }),
  );
