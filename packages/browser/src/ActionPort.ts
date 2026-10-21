/** Assemble named Page methods and canonical action execution over one concrete input port. */
import { Effect, Schema } from "effect";

import { Action, Current } from "./Action.ts";
import { InvalidRequest, undispatched } from "./BrowserError.ts";
import { type Page, ResolvedTarget } from "./Page.ts";

type Port = Pick<
  Page,
  "click" | "hover" | "drag" | "type" | "press" | "scroll" | "select" | "goto" | "back" | "reload"
>;
const invalid = (detail: string) => undispatched("perform", new InvalidRequest({ detail }));

/** Dispatch a decoded request to a concrete input port. */
export const execute = (port: Port, action: Action): ReturnType<Page["perform"]> => {
  switch (action._tag) {
    case "Click":
      return port.click(action.target, action.options);
    case "Hover":
      return port.hover(action.target);
    case "Drag":
      return port.drag(action.from, action.to);
    case "Type":
      return port.type(action.text, action.options);
    case "Press":
      return port.press(action.keys, action.options);
    case "Scroll":
      return port.scroll(action.options);
    case "Select":
      return port.select(action.ref, action.values);
    case "Goto":
      return port.goto(action.url);
    case "Back":
      return port.back;
    case "Reload":
      return port.reload;
    case "Act":
      return Effect.fail(invalid("call page.act with a script"));
    default:
      return Effect.fail(invalid("invalid action tag"));
  }
};

/** Decode once and make the request available to dispatch phases. */
export const checked =
  (perform: Page["perform"]): Page["perform"] =>
  (asked) =>
    Schema.decodeEffect(Action)(asked).pipe(
      Effect.mapError(() => invalid("invalid action")),
      Effect.flatMap((action) => Effect.provideService(perform(action), Current, action)),
    );

/** Named entry points are the same typed action path used by replay and tools. */
export const methods = (perform: Page["perform"]): Port => ({
  goto: (url) => Effect.asVoid(perform({ _tag: "Goto", url })),
  back: Effect.asVoid(perform({ _tag: "Back" })),
  reload: Effect.asVoid(perform({ _tag: "Reload" })),
  click: (target, options) =>
    perform({ _tag: "Click", target, options }).pipe(
      Effect.filterOrFail(Schema.is(ResolvedTarget), () =>
        invalid("the action produced no target"),
      ),
    ),
  hover: (target) => Effect.asVoid(perform({ _tag: "Hover", target })),
  drag: (from, to) => Effect.asVoid(perform({ _tag: "Drag", from, to })),
  type: (text, options) => Effect.asVoid(perform({ _tag: "Type", text, options })),
  press: (keys, options) => Effect.asVoid(perform({ _tag: "Press", keys, options })),
  scroll: (options) => Effect.asVoid(perform({ _tag: "Scroll", options })),
  select: (ref, values) =>
    perform({ _tag: "Select", ref, values }).pipe(
      Effect.filterOrFail(
        (value) => typeof value === "string",
        () => invalid("the action produced no labels"),
      ),
    ),
});
