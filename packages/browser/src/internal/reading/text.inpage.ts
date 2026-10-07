/**
 * In the page: the text a page shows, and the one rule for what a field shows. A field's value
 * reads `••••` unless a caller unmasks it, and a secret field's always does, including a field
 * that was secret when the library saw it, such as a password its page now reveals. See
 * `names.inpage.ts` for what a page-side part may use.
 */
import { Schema } from "effect";

import type { Names } from "./names.inpage.ts";
import type { Walk } from "./walk.inpage.ts";

export interface TextRequest {
  /** An element to read whole, or null for what the viewport shows. */
  readonly ref: string | null;
  readonly maxChars: number;
  readonly unmask: boolean;
}

/** What `read` sends back, or null when its ref no longer names an element. */
export const TextResultSchema = Schema.NullOr(
  Schema.Struct({
    text: Schema.String,
    truncated: Schema.Boolean,
    url: Schema.String,
    title: Schema.String,
  }),
);

export type TextResult = typeof TextResultSchema.Type;

export const text = (names: Names, walked: Walk) => {
  const { isHtml, isInput, isSecret, isSelect, isTextArea, lookup } = names;

  // Input types whose value is a label or a choice rather than something entered.
  const valueless = ["checkbox", "radio", "button", "submit", "reset", "image", "file"];

  /** What a field holds, or undefined for an element that holds nothing entered. */
  const valueOf = (element: Element): string | undefined => {
    if (isInput(element)) return valueless.includes(element.type) ? undefined : element.value;
    if (isTextArea(element)) return element.value;
    if (isSelect(element))
      return Array.from(element.selectedOptions, (option) => option.text).join(", ");
    const parent = element.parentElement;

    // An editable region's own root holds what was typed into it.
    return isHtml(element) &&
      element.isContentEditable &&
      !(parent !== null && isHtml(parent) && parent.isContentEditable)
      ? element.innerText
      : undefined;
  };

  /** What a field shows: `••••` unless `unmask`, and always for a secret field; "" when empty. */
  const shown = (element: Element, unmask: boolean): string | undefined => {
    const value = valueOf(element);

    if (value === undefined || value.trim() === "") return value === undefined ? undefined : "";

    return unmask && !isSecret(element) ? value : "••••";
  };

  /**
   * What the viewport, or one element, shows as text: a line per block, table cells apart by a
   * tab, and each field as `shown` gives it.
   */
  const read = (request: TextRequest): TextResult => {
    const root = request.ref === null ? null : lookup(request.ref);

    if (root === undefined) return null;
    const lines: Array<string> = [];
    let line = "";

    const end = () => {
      const words = line
        .replace(/[^\S\t]+/g, " ")
        .replace(/ ?\t ?/g, "\t")
        .trim();

      if (words !== "") lines.push(words);
      line = "";
    };

    walked.visit(root, request.ref === null, false, {
      enter: (element, style) => {
        const { display } = style;
        const value = shown(element, request.unmask);

        const block =
          !display.startsWith("inline") && display !== "contents" && display !== "table-cell";

        if (display === "table-cell") line += "\t";
        if (block || element.tagName === "BR") end();
        if (value === undefined && !(isInput(element) && valueless.includes(element.type)))
          return block;
        // A button's value is its label; a box or a choice shows no text of its own.
        const label = isInput(element) && /^(button|submit|reset)$/.test(element.type);

        line += ` ${value ?? (label ? element.value : "")} `;
        if (block) end();

        return undefined;
      },
      text: (node) => {
        line += node.textContent ?? "";
      },
      leave: (_, block) => {
        if (block) end();
      },
    });
    end();
    const all = lines.join("\n");
    const cut = all.length > request.maxChars ? all.lastIndexOf("\n", request.maxChars) : -1;

    return {
      text: all.length > request.maxChars ? all.slice(0, cut > 0 ? cut : request.maxChars) : all,
      truncated: all.length > request.maxChars,
      url: location.href,
      title: document.title,
    };
  };

  return { read, shown };
};

export type Texts = ReturnType<typeof text>;
