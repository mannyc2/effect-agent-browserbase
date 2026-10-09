/**
 * In the page: a control's states and value as the outline shows them, and as a value; the elements a CSS selector scopes a
 * read to; and a condition `Page.waitFor` waits for. See `names.inpage.ts` for what a page-side part
 * may use.
 */
import type { Control } from "../../Snapshot.ts";
import type { Names } from "./names.inpage.ts";
import type { Subjects } from "./subjects.inpage.ts";
import type { Texts } from "./text.inpage.ts";
import type { Walk } from "./walk.inpage.ts";

/** What `waitUntil` waits for, as `Page.waitFor` asks it. */
export interface ConditionRequest {
  readonly selector: string | null;
  readonly text: string | null;
  readonly state: "visible" | "hidden" | "enabled";
}

/** Whether the condition held by the deadline, or why the selector is not CSS. */
export type ConditionResult = { readonly met: boolean } | { readonly invalid: string };

export const controls = (names: Names, walked: Walk, subjects: Subjects, texts: Texts) => {
  const { clean, isDisabled, isHtml, isInput, isSelect, isTextArea, refFor, textOf } = names;
  const { visible } = walked;
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

  // Inputs that take no typed text.
  const untyped = ["button", "reset", "submit", "image", "checkbox", "radio", "file", "range"];

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

    const editable =
      isTextArea(element) ||
      (isInput(element) && !untyped.includes(element.type)) ||
      (isHtml(element) && element.isContentEditable);

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

  // Whether the condition holds now: what the selector matches, or the body, and shows, with the
  // text when one is asked, case and all.
  const holds = (request: ConditionRequest): ConditionResult => {
    const roots = request.selector === null ? [document.body] : rootsOf(request.selector);

    if ("invalid" in roots) return roots;
    const text = request.text === null ? null : clean(request.text, Infinity);

    const showing = roots.filter(
      (element) =>
        visible(element) && (text === null || clean(textOf(element), Infinity).includes(text)),
    );

    return {
      met:
        request.state === "hidden"
          ? showing.length === 0
          : request.state === "enabled"
            ? showing.some((element) => !isDisabled(element))
            : showing.length > 0,
    };
  };

  // Looks every 100 ms until the condition holds or the deadline passes.
  const waitUntil = async (request: ConditionRequest, millis: number) => {
    const until = performance.now() + millis;

    for (;;) {
      const result = holds(request);
      const left = until - performance.now();

      if ("invalid" in result || result.met || left <= 0) return result;
      const { promise, resolve } = Promise.withResolvers<void>();

      setTimeout(resolve, Math.min(100, left));
      await promise;
    }
  };

  return { controlOf, rootsOf, states, valueOf, waitUntil };
};

export type Controls = ReturnType<typeof controls>;
