/**
 * In the page: what the page says about an input's first target, for a judge, and which fields a
 * form would send. It never reads what a field holds. See `reading/names.inpage.ts` for what a page-side part may use.
 */
import { Schema } from "effect";

import type { ContextReader } from "../reading/context.inpage.ts";
import type { Names } from "../reading/names.inpage.ts";

export interface FormField {
  readonly type: string;
  readonly name: string;
  readonly autocomplete?: string | undefined;
  readonly filled: boolean;
}

/** Page text about the first target. It never includes what a field holds. */
export interface Evidence {
  readonly title: string;
  readonly description?: string | undefined;
  readonly dialog?: string | undefined;
  readonly heading?: string | undefined;
  readonly nearby?: string | undefined;
  readonly form?:
    | {
        readonly method: string;
        readonly action: string;
        readonly fields: ReadonlyArray<FormField>;
      }
    | undefined;
}

type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

export const evidence = (names: Names, placing: ContextReader) => {
  const { clean, isDocument, isInput, isSelect, isTextArea, nameOf, parentOf, roleOf, textOf } =
    names;

  const { headingBefore, textBeside, treeOf } = placing;

  /** A field a submission would send. */
  const isField = (element: Element): element is Field =>
    ((isInput(element) && !["button", "submit", "reset", "image"].includes(element.type)) ||
      isSelect(element) ||
      isTextArea(element)) &&
    !element.matches(":disabled");

  const isFilled = (field: Field): boolean =>
    isInput(field) && (field.type === "checkbox" || field.type === "radio")
      ? field.checked
      : isInput(field) && field.type === "file"
        ? (field.files?.length ?? 0) > 0
        : field.value !== "";

  // Containers whose text usually describes the controls in them: a row, an item, a group or a form.
  const groups =
    "tr,li,article,fieldset,form,section,dialog,[role=row],[role=listitem],[role=group],[role=region],[role=dialog],[role=alertdialog]";

  const dialogOf = (element: Element): Element | undefined => {
    for (let node: Element | null = element; node !== null; node = parentOf(node))
      if (node.tagName === "DIALOG" || /^(?:alert)?dialog$/.test(node.getAttribute("role") ?? ""))
        return node;

    return undefined;
  };

  /** What the page says about an input's first target, for a judge. Never a field's value. */
  const evidenceOf = (
    element: Element,
    form: HTMLFormElement | null,
    method: string | undefined,
    action: string | undefined,
  ): Evidence => {
    const name = nameOf(element, roleOf(element));
    const ids = element.getAttribute("aria-describedby");

    const description = clean(
      ids === null
        ? (element.getAttribute("aria-description") ?? element.getAttribute("title"))
        : ids
            .split(/\s+/)
            .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? "")
            .join(" "),
      120,
    );

    const dialog = dialogOf(element);

    const title = dialog?.querySelector("h1,h2,h3,h4,h5,h6,[role=heading]");

    const dialogName =
      dialog === undefined
        ? ""
        : clean(nameOf(dialog, "dialog"), 120) ||
          (title === null || title === undefined ? "" : clean(textOf(title), 120));

    // Each scope stays in the target's own tree: a walker cannot leave a shadow root.
    const root = element.getRootNode();
    const top = isDocument(root) ? (root.body ?? root) : root;
    const inTree = element.closest("dialog,[role=dialog],[role=alertdialog]");
    let nearby = "";

    for (const scope of new Set([element.closest(groups), inTree, top]))
      if (scope !== null && nearby === "")
        nearby = textBeside(element, scope, true) || textBeside(element, scope, false);

    const heading = headingBefore(element, treeOf(element));

    const fields =
      form === null
        ? []
        : Array.from(form.elements)
            .filter(isField)
            .slice(0, 16)
            .map((field) => {
              const autocomplete = clean(field.getAttribute("autocomplete"), 40);

              return {
                type: isInput(field) ? field.type : field.tagName.toLowerCase(),
                name: clean(
                  isInput(field) && field.type === "hidden"
                    ? field.getAttribute("name")
                    : nameOf(field, roleOf(field)),
                  40,
                ),
                ...(autocomplete === "" ? {} : { autocomplete }),
                filled: isFilled(field),
              };
            });

    return {
      title: clean(document.title, 120),
      ...(description === "" || description === name ? {} : { description }),
      ...(dialogName === "" ? {} : { dialog: dialogName }),
      ...(heading === undefined ? {} : { heading }),
      ...(nearby === "" ? {} : { nearby }),
      ...(form === null
        ? {}
        : { form: { method: method ?? form.method, action: action ?? form.action, fields } }),
    };
  };

  return { evidenceOf, isField, isFilled };
};

export type EvidenceReader = ReturnType<typeof evidence>;

export const FormFieldSchema = Schema.Struct({
  type: Schema.String,
  name: Schema.String,
  autocomplete: Schema.optional(Schema.String),
  filled: Schema.Boolean,
});

export const EvidenceSchema = Schema.Struct({
  title: Schema.String,
  description: Schema.optional(Schema.String),
  dialog: Schema.optional(Schema.String),
  heading: Schema.optional(Schema.String),
  nearby: Schema.optional(Schema.String),
  form: Schema.optional(
    Schema.Struct({
      method: Schema.String,
      action: Schema.String,
      fields: Schema.Array(FormFieldSchema),
    }),
  ),
});
