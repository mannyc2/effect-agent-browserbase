/**
 * In the page: subjects, and `find`. A subject is what an action acts on and what `find` finds:
 * an element's role, name and tag, plus its context (see `context.inpage.ts`). Its state is read
 * beside it. See `names.inpage.ts` for what a page-side part may use.
 */
import type { Context, ContextReader } from "./context.inpage.ts";
import type { FindRequest, Match } from "./match.inpage.ts";
import type { Names } from "./names.inpage.ts";
import type { Walk } from "./walk.inpage.ts";

export const subjects = (names: Names, walked: Walk, matching: Match, placing: ContextReader) => {
  const { interactiveRoles, isDisabled, isInput, nameOf, refFor, refs, roleOf, textOf } = names;
  const { boxOf, controlOf, hitAt } = walked;
  const { contextOf, known } = placing;

  /** What the outline lists as a control, with a ref: something a person would act on. */
  const isControl = (
    element: Element,
    role: string | null,
    style: CSSStyleDeclaration,
    rect: DOMRect,
    insidePointer: boolean,
  ): boolean =>
    (role !== null && (interactiveRoles.has(role) || role === "canvas" || role === "iframe")) ||
    element.hasAttribute("onclick") ||
    (style.cursor === "pointer" && !insidePointer && rect.width > 0 && rect.height > 0);

  const stateOf = (element: Element, role: string | null) => {
    // A state the page gives either way, or none.
    const given = (attribute: string) => {
      const value = element.getAttribute(attribute);

      return value === "true" || (value === "false" ? false : undefined);
    };

    const checkable =
      element.hasAttribute("aria-checked") ||
      ["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"].includes(role ?? "");

    // In the order the outline shows them.
    return {
      disabled: isDisabled(element),
      checked: checkable
        ? (isInput(element) && element.checked) || element.getAttribute("aria-checked") === "true"
        : undefined,
      expanded: given("aria-expanded"),
      selected: given("aria-selected"),
      pressed: given("aria-pressed"),
      focused: element.ownerDocument.activeElement === element,
      level:
        role === "heading"
          ? Number(element.getAttribute("aria-level")) ||
            Number(/^H([1-6])$/.exec(element.tagName)?.[1]) ||
            2
          : undefined,
    };
  };

  /**
   * The elements in scope that match a query, in tree order. Without text, an element matches
   * when it has a role or is a control. With text, any element can, but text inside a control or
   * heading is that control's or heading's, and an element is left out when one inside it
   * matches too: the smallest element showing the text is found, not each one around it.
   */
  const find = (request: FindRequest) => {
    if (refs.next < request.firstRef) refs.next = request.firstRef;
    const { at } = request;
    const matches = matching.compile(request);
    const byText = request.text !== null;
    const viewport = request.scope === "viewport";
    const width = window.innerWidth;
    const height = window.innerHeight;
    const read = known();

    interface Entry {
      readonly element: Element;
      readonly rect: DOMRect;
      readonly role: string | null;
      name?: string;
      context?: Context;
      matched: boolean;
    }

    // An element the walk is inside: its entry if it may match, whether text flows into it
    // without a break, the text read in it so far, and whether something in it matched.
    interface Open {
      readonly entry: Entry | undefined;
      readonly inline: boolean;
      readonly parts: Array<string>;
      inside: boolean;
    }

    const entries: Array<Entry> = [];
    const open: Array<Open> = [];

    const inView = (rect: DOMRect) =>
      rect.right > 0 && rect.bottom > 0 && rect.left < width && rect.top < height;

    const named = (entry: Entry) => (entry.name ??= nameOf(entry.element, entry.role));
    const placed = (entry: Entry) => (entry.context ??= contextOf(entry.element, read));

    const judge = (entry: Entry, text: () => string) =>
      matches({ role: entry.role, name: () => named(entry), text, context: () => placed(entry) });

    // At a point, the one element a point action there would reach, if it meets the other rules.
    const hit = at === null ? null : hitAt(document, at.x, at.y);

    if (hit !== null) {
      const element = controlOf(hit);
      const { x, y, width, height } = boxOf(element);
      const rect = new DOMRect(x, y, width, height);
      const entry: Entry = { element, rect, role: roleOf(element), matched: false };

      entry.matched = judge(entry, () => textOf(element));
      entries.push(entry);
    }
    if (at === null)
      walked.visit(
        null,
        viewport,
        { pointer: false, owned: false },
        {
          enter: (element, style, rect, state) => {
            const role = roleOf(element);
            const control = isControl(element, role, style, rect, state.pointer);
            const unit = control || role === "heading";
            const candidate = byText ? unit || !state.owned : role !== null || control;

            const entry =
              candidate && (!viewport || inView(rect))
                ? { element, rect, role, matched: false }
                : undefined;

            if (entry !== undefined) entries.push(entry);
            open.push({ entry, inline: style.display === "inline", parts: [], inside: false });

            return {
              pointer: state.pointer || style.cursor === "pointer",
              owned: state.owned || unit,
            };
          },
          text: byText ? (node) => open.at(-1)?.parts.push(node.textContent ?? "") : undefined,
          leave: () => {
            const closed = open.pop();
            const parent = open.at(-1);

            if (closed === undefined) return;
            const { entry } = closed;
            const text = closed.parts.join("");

            if (parent !== undefined) parent.parts.push(closed.inline ? text : ` ${text} `);
            if (entry !== undefined && !(byText && closed.inside))
              entry.matched = judge(entry, () => text);
            if (parent !== undefined) parent.inside ||= closed.inside || entry?.matched === true;
          },
        },
      );

    const found = entries
      .filter((entry) => entry.matched)
      .map((entry) => ({
        ref: refFor(entry.element),
        subject: {
          role: entry.role,
          name: named(entry),
          tag: entry.element.tagName.toLowerCase(),
          context: placed(entry),
        },
        box: {
          x: Math.round(entry.rect.x),
          y: Math.round(entry.rect.y),
          width: Math.round(entry.rect.width),
          height: Math.round(entry.rect.height),
        },
        inViewport: inView(entry.rect),
        state: stateOf(entry.element, entry.role),
      }));

    return { found, nextRef: refs.next };
  };

  return { find, isControl, stateOf };
};

export type Subjects = ReturnType<typeof subjects>;
