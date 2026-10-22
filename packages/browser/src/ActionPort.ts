/** Assemble named Page methods and canonical action execution over one concrete input port. */
import { Effect, Schema, type SchemaIssue } from "effect";

import { Action, nameOf } from "./Action.ts";
import { InvalidRequest, undispatched } from "./BrowserError.ts";
import { type Page, ResolvedTarget } from "./Page.ts";

type Port = Pick<
  Page,
  "click" | "hover" | "drag" | "type" | "press" | "scroll" | "select" | "goto" | "back" | "reload"
>;

const invalid = (detail: string, operation = "perform") =>
  undispatched(operation, new InvalidRequest({ detail }));

const expectedTypes: Readonly<Record<string, string>> = {
  String: "a string",
  Number: "a finite number",
  Boolean: "a boolean",
  Objects: "an object",
  Arrays: "an array",
};

// Action has fixed fields and array indices. Paths come from that schema; rejected values,
// formatter messages and annotations are never rendered. Prefer the most specific union branch.
const diagnostic = (
  issue: SchemaIssue.Issue,
  path: ReadonlyArray<PropertyKey> = [],
): { readonly path: ReadonlyArray<PropertyKey>; readonly expected: string } => {
  if (issue._tag === "Pointer") return diagnostic(issue.issue, [...path, ...issue.path]);
  if (issue._tag === "Encoding") return diagnostic(issue.issue, path);
  if (issue._tag === "Composite" || issue._tag === "AnyOf")
    return (
      issue.issues
        .map((child) => diagnostic(child, path))
        .sort((a, b) => b.path.length - a.path.length)[0] ?? { path, expected: "a supported value" }
    );

  const expected =
    issue._tag === "Filter"
      ? issue.filter === Action.cases.Select.fields.ref.ast.checks?.[0]
        ? "an element ref such as e12"
        : issue.filter === Schema.Finite.ast.checks?.[0]
          ? "a finite number"
          : "a value satisfying the action's constraints"
      : issue._tag === "InvalidType"
        ? (expectedTypes[issue.ast._tag] ?? "a supported value")
        : issue._tag === "MissingKey"
          ? "a required value"
          : "a valid value";

  return { path, expected };
};

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

/** Decode once before dispatching the canonical request. */
export const checked =
  (perform: Page["perform"]): Page["perform"] =>
  (asked) =>
    Schema.decodeEffect(Action)(asked).pipe(
      Effect.mapError(({ issue }) => {
        if (
          typeof asked !== "object" ||
          asked === null ||
          typeof asked._tag !== "string" ||
          !Object.hasOwn(Action.cases, asked._tag)
        )
          return invalid("_tag: expected a supported action tag");
        const { path, expected } = diagnostic(issue);

        return invalid((path.join(".") || "action") + ": expected " + expected, nameOf(asked));
      }),
      Effect.flatMap(perform),
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
