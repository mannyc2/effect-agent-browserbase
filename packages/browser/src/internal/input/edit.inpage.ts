/**
 * In the page: editing a field. It refuses text that a focused control could act on, focuses a
 * field, chooses a select's options and checks a corrected field's final text. See `reading/names.inpage.ts` for what a page-side part may use.
 */
import { Schema } from "effect";

import type { Names } from "../reading/names.inpage.ts";
import type { Guard } from "./guard.inpage.ts";

export type EditResult =
  | { readonly ok: true; readonly detail: string }
  | { readonly error: string; readonly stale?: boolean };

/**
 * A focused field, whether opted-in prose slips may apply to it as it is now, and whether it is
 * secret.
 */
export type FocusResult =
  | {
      readonly ok: true;
      readonly detail: string;
      readonly prose: boolean;
      readonly secret: boolean;
    }
  | { readonly error: string; readonly stale?: boolean };

export type TypeableResult =
  | { readonly ok: true; readonly secret: boolean }
  | { readonly error: "stale" | "untypeable"; readonly detail: string };

export const edit = (names: Names, guard: Guard) => {
  const {
    activeElement,
    clean,
    describe,
    inCurrentDocument,
    isDisabled,
    isHtml,
    isInput,
    isSecret,
    isSelect,
    isTextArea,
    lookup,
  } = names;

  const { proseEligible, textEntry, typingRefusal } = guard;

  // A corrected slip must not submit a different value when a widget swallowed the correction.
  // Report only equality, never the field's contents.
  const checkText = (ref: string, expected: string): EditResult => {
    const element = lookup(ref);

    if (element === undefined || !inCurrentDocument(element) || activeElement() !== element)
      return { error: "the prose field changed before its final value could be checked" };

    const value = isTextArea(element)
      ? element.value
      : isHtml(element) && element.isContentEditable
        ? element.innerText
        : undefined;

    return value === expected
      ? { ok: true, detail: "corrected prose matches the requested text" }
      : { error: "corrected prose did not match the requested text" };
  };

  const typeable = (ref: string | null): TypeableResult => {
    const element = ref === null ? activeElement() : lookup(ref);

    if (element === undefined)
      return {
        error: "stale",
        detail: `${ref ?? "the focused element"} is not on the page any more`,
      };
    const refusal = element === null ? undefined : typingRefusal(element, ref !== null);

    return refusal === undefined
      ? { ok: true, secret: element !== null && isSecret(element) }
      : { error: "untypeable", detail: refusal };
  };

  const focus = (ref: string, replace: boolean): FocusResult => {
    const element = lookup(ref);

    if (element === undefined) return { error: `${ref} is not on the page any more`, stale: true };
    if (isDisabled(element)) return { error: `${ref} is disabled` };
    if (!textEntry(element)) return { error: `${ref} is ${describe(element)}, not a text field` };
    if (isHtml(element)) element.focus();
    if (replace) {
      if (isInput(element) || isTextArea(element)) element.select();
      else element.ownerDocument.getSelection()?.selectAllChildren(element);
    }

    // Decided after focusing: a focus handler can mark the field sensitive or secret.
    return {
      ok: true,
      detail: describe(element),
      prose: proseEligible(element),
      secret: isSecret(element),
    };
  };

  const select = (ref: string, values: ReadonlyArray<string>): EditResult => {
    const element = lookup(ref);

    if (element === undefined) return { error: `${ref} is not on the page any more`, stale: true };
    if (!isSelect(element))
      return {
        error: `${ref} is ${describe(element)}, not a <select>; click it and pick an option`,
      };
    const wanted = values.map((value) => value.trim().toLowerCase());
    const options = Array.from(element.options);

    const chosen = options.filter(
      (option) =>
        wanted.includes(option.value.toLowerCase()) ||
        wanted.includes(clean(option.text).toLowerCase()),
    );

    if (chosen.length === 0)
      return {
        error: `no option matches; the options are ${options.map((option) => JSON.stringify(clean(option.text, 40))).join(", ")}`,
      };
    for (const option of options) option.selected = chosen.includes(option);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));

    return { ok: true, detail: chosen.map((option) => clean(option.text, 40)).join(", ") };
  };

  return { checkText, focus, select, typeable };
};

export type Edit = ReturnType<typeof edit>;

export const TypeableResultSchema = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), secret: Schema.Boolean }),
  Schema.Struct({ error: Schema.Literals(["stale", "untypeable"]), detail: Schema.String }),
]);

const EditFailure = Schema.Struct({ error: Schema.String, stale: Schema.optional(Schema.Boolean) });

export const FocusResultSchema = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    detail: Schema.String,
    prose: Schema.Boolean,
    secret: Schema.Boolean,
  }),
  EditFailure,
]);

export const EditResultSchema = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), detail: Schema.String }),
  EditFailure,
]);
