/**
 * In the page: a control's states and value as the outline shows them, and as a value; the elements a CSS selector scopes a
 * read to. See `names.inpage.ts` for what a page-side part
 * may use.
 */
import type { Control } from "../../Snapshot.ts";
import type { Names } from "./names.inpage.ts";
import type { Subjects } from "./subjects.inpage.ts";
import type { Texts } from "./text.inpage.ts";

export const controls = (names: Names, subjects: Subjects, texts: Texts) => {
  const { clean, isInput, isSelect, isTextArea, refFor, textEntry } = names;
  const { stateOf } = subjects;
  const { shown } = texts;

  // The states that hold, in the order `stateOf` gives them, after a heading's level.
  const states = (element: Element, role: string | null): string => {
    const { level, ...flags } = stateOf(element, role);
    const held = Object.entries(flags).flatMap(([name, value]) => (value === true ? [name] : []));

    return [...(level === undefined ? [] : [`level=${level}`]), ...held]
      .map((name) => ` [${name}]`)
      .join("");
  };

  const valueOf = (element: Element): string => {
    if (isSelect(element)) {
      const selected = Array.from(element.selectedOptions, (option) => clean(option.text, 40));

      const options = Array.from(element.options)
        .slice(0, 12)
        .map((option) => clean(option.text, 40));

      const more = element.options.length > 12 ? ` +${element.options.length - 12} more` : "";

      return ` value=${JSON.stringify(selected.join(", "))} options=${JSON.stringify(options.join(" | ") + more)}`;
    }
    // The model sees what it typed, but never what a secret field holds.
    const value = isInput(element) || isTextArea(element) ? shown(element, true) : undefined;

    return value === undefined || value === "" ? "" : ` value=${JSON.stringify(clean(value, 80))}`;
  };

  /** A control as a value, as its outline line shows it. */
  const controlOf = (element: Element, role: string | null, kind: string, name: string) => {
    const { disabled, checked } = stateOf(element, role);
    const select = isSelect(element) ? element : undefined;

    const value =
      select !== undefined
        ? Array.from(select.selectedOptions, (option) => clean(option.text, 80)).join(", ")
        : isInput(element) || isTextArea(element)
          ? clean(shown(element, true), 200)
          : "";

    const editable = textEntry(element);

    const control: typeof Control.Encoded = {
      ref: refFor(element),
      kind,
      name,
      value,
      ...(select === undefined
        ? {}
        : {
            options: Array.from(select.options)
              .slice(0, 64)
              .map((option) => clean(option.text, 80)),
            optionCount: select.options.length,
          }),
      ...(disabled ? { disabled } : {}),
      ...(checked === undefined ? {} : { checked }),
      ...(editable ? { editable } : {}),
    };

    return control;
  };

  /**
   * The elements a selector matches, each read whole, so one inside another that matched is left
   * to it; or why the selector is not CSS.
   */
  const rootsOf = (selector: string): ReadonlyArray<Element> | { readonly invalid: string } => {
    let matched: ReadonlyArray<Element>;

    try {
      matched = Array.from(document.querySelectorAll(selector));
    } catch {
      return { invalid: `${JSON.stringify(selector)} is not a CSS selector` };
    }

    return matched.filter(
      (root) => !matched.some((other) => other !== root && other.contains(root)),
    );
  };

  return { controlOf, rootsOf, states, valueOf };
};

export type Controls = ReturnType<typeof controls>;
