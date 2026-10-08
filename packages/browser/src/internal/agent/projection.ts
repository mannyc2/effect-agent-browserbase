/**
 * The page operations' projections, and the only place tools are made: the browser tools a model
 * calls, `done` and `give_up` for an agent, and the RPC group that serves the operations from
 * another process. A tool tells a model its receipt and its failure as text, made from the values
 * that a caller and the RPC group read.
 */
import { Schema, SchemaGetter } from "effect";
import { Tool, Toolkit } from "effect/ai";
import { Rpc, RpcGroup } from "effect/rpc";

import { BrowserError, consequence } from "../../BrowserError.ts";
import { describe } from "../timeline/words.ts";
import { type Name, type Operation, operations, Receipt, TabsInput } from "./operations.ts";

/** A value a model is told as text, which is never read back into the value. */
const toldAs = <S extends Schema.Top>(schema: S, text: (value: S["Type"]) => string) =>
  Schema.String.pipe(
    Schema.decodeTo(Schema.toType(schema), {
      decode: SchemaGetter.forbidden(() => "what a model is told is not read back"),
      encode: SchemaGetter.transform(text),
    }),
  );

/** At most this many of the changes an action caused are told. */
const maxChanges = 3;

/** A receipt as a model is told it: what the call did, then what followed it. */
export const told = ({ did, dialogs, navigated, opened, changes, missing }: Receipt): string => {
  const caused = (changes?.changes ?? []).filter((change) => change.cause !== undefined);
  const more = caused.length - maxChanges;

  return [
    did,
    ...dialogs.map(
      ({ kind, message, answer }) =>
        `A ${kind} dialog said ${JSON.stringify(message)}, and it was ${answer}.`,
    ),
    ...(navigated === undefined || did.includes(navigated.url)
      ? []
      : [`The page went to ${navigated.url}.`]),
    ...opened.map(({ url }) => `A tab opened at ${url}.`),
    ...(caused.length === 0
      ? []
      : [
          `It changed: ${caused
            .slice(0, maxChanges)
            .map((change) => describe(change))
            .join("; ")}${more > 0 ? `; and ${more} more` : ""}.`,
        ]),
    ...missing.map((error) => `What changed could not be read: ${error.reason.message}.`),
  ].join("\n");
};

/** A failure as a model is told it: what happened, then what to do about it. */
export const toldFailure = (error: BrowserError): string => {
  const { lost, repeat } = consequence(error);

  return [
    `${error.message}.`,
    lost === "session" ? "The browser is gone." : lost === "page" ? "The tab is gone." : "",
    error.reason._tag === "StaleRef" ? "Take a new snapshot." : "",
    error.reason._tag === "Busy" && repeat === "safe"
      ? "Nothing was done while other work held the page: try it again."
      : "",
    repeat === "check" ? "It may have taken effect: look at the page before you repeat it." : "",
  ]
    .filter((sentence) => sentence !== "")
    .join(" ");
};

const success = toldAs(Receipt, told);
const failure = toldAs(BrowserError, toldFailure);

const tool = <N extends Name, I extends Schema.Top>({
  name,
  description,
  input,
}: Operation<N, I>) =>
  Tool.make(name, { description, parameters: input, success, failure, failureMode: "return" });

/** The tools of one page: every page operation. */
export const PageToolkit = Toolkit.make(
  tool(operations.browser_navigate),
  tool(operations.browser_back),
  tool(operations.browser_snapshot),
  tool(operations.browser_zoom),
  tool(operations.browser_click),
  tool(operations.browser_hover),
  tool(operations.browser_type),
  tool(operations.browser_press),
  tool(operations.browser_scroll),
  tool(operations.browser_drag),
  tool(operations.browser_select),
  tool(operations.browser_wait),
);

/** The tools of a browser's tabs: a page's, and `browser_tabs` to list, switch, open and close. */
export const BrowserToolkit = Toolkit.merge(
  PageToolkit,
  Toolkit.make(
    Tool.make("browser_tabs", {
      description: "List the tabs, switch to one, open a new one or close one.",
      parameters: TabsInput,
      success,
      failure,
      failureMode: "return",
    }),
  ),
);

/** The tools that end an agent's run: `done` with an answer of the given shape, or `give_up`. */
export const completion = (answer: Schema.Codec<unknown, unknown>) =>
  Toolkit.make(
    Tool.make("done", {
      description: "Finish the task and report the answer.",
      parameters: Schema.Struct({ answer }),
      success: Schema.String,
      failureMode: "return",
    }),
    Tool.make("give_up", {
      description: "Stop because the task cannot be done, and say why.",
      parameters: Schema.Struct({ reason: Schema.String }),
      success: Schema.String,
      failureMode: "return",
    }),
  );

const rpc = <N extends Name, I extends Schema.Top>({ name, input }: Operation<N, I>) =>
  Rpc.make(name, { payload: input, success: Receipt, error: BrowserError });

/** The page operations as an RPC group, which `on(page)` serves. */
export const PageRpcs = RpcGroup.make(
  rpc(operations.browser_navigate),
  rpc(operations.browser_back),
  rpc(operations.browser_snapshot),
  rpc(operations.browser_zoom),
  rpc(operations.browser_click),
  rpc(operations.browser_hover),
  rpc(operations.browser_type),
  rpc(operations.browser_press),
  rpc(operations.browser_scroll),
  rpc(operations.browser_drag),
  rpc(operations.browser_select),
  rpc(operations.browser_wait),
);
