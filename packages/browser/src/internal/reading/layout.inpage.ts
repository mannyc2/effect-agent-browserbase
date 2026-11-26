/**
 * In the page: where chosen things are. Each pick is a `find` query; of the elements it finds, one
 * is chosen, and its box is read unrounded, with the boxes of words in it that the pick asks for,
 * each from a `Range` over its text. A pick with a selector takes what the selector selects, an
 * icon drawn in SVG among it, where `find`'s walk leaves drawings out. The viewport, the scroll and the scale are read in the same
 * call, so the boxes and the scroll describe one moment. See `names.inpage.ts` for what a
 * page-side part may use.
 */
import type { FindRequest, Match, Wanted } from "../matching.ts";
import type { ContextReader } from "./context.inpage.ts";
import type { Names } from "./names.inpage.ts";
import type { Subjects } from "./subjects.inpage.ts";
import type { Walked } from "./walk.inpage.ts";

export interface PickRequest extends FindRequest {
  readonly id: string;
  readonly choose: "first" | "last" | "smallest" | "largest";
  readonly words: Wanted | null;
}

export const layout = (
  names: Names,
  walked: Walked,
  subjected: Subjects,
  matching: Match,
  placing: ContextReader,
) => {
  const { isDisabled, isOwn, nameOf, refFor, roleOf, textOf } = names;
  const { boxOf, inView, visible } = walked;
  // A pick's words are bounded, as a page's text is not.
  const most = 200;

  const area = (element: Element) => {
    const { width, height } = element.getBoundingClientRect();

    return width * height;
  };

  const chosen = (elements: ReadonlyArray<Element>, choose: PickRequest["choose"]) =>
    choose === "first"
      ? elements[0]
      : choose === "last"
        ? elements.at(-1)
        : elements.reduce<Element | undefined>(
            (best, element) =>
              best === undefined ||
              (choose === "smallest" ? area(element) < area(best) : area(element) > area(best))
                ? element
                : best,
            undefined,
          );

  // Whether it keeps its place in the viewport as the page scrolls.
  const fixed = (element: Element) => {
    for (let at: Element | null = element; at !== null; at = at.parentElement)
      if (getComputedStyle(at).position === "fixed") return true;

    return false;
  };

  // Each match in the element's text, across the text nodes it is split into, with its box moved
  // by `dx` and `dy` into the top document's viewport. A match that shows nothing is left out.
  const words = (element: Element, wanted: Wanted, dx: number, dy: number) => {
    // Each text node with where its text starts in the element's.
    const parts: Array<{ readonly node: Node; readonly start: number }> = [];
    let text = "";
    const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);

    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      parts.push({ node, start: text.length });
      text += node.nodeValue ?? "";
    }

    const pattern =
      typeof wanted === "string"
        ? new RegExp(wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu")
        : new RegExp(wanted.source, wanted.flags.replace(/[gy]/g, "") + "g");

    // The text node holding the character at `index`, or, for an end, the one ending at it.
    const at = (index: number, end: boolean): [Node, number] => {
      const part =
        parts.findLast(({ start }) => (end ? start < index : start <= index)) ?? parts[0];

      return part === undefined ? [element, 0] : [part.node, index - part.start];
    };

    const found: Array<{
      text: string;
      box: { x: number; y: number; width: number; height: number };
    }> = [];

    for (const match of text.matchAll(pattern)) {
      if (found.length === most) break;
      if (match[0] === "") continue;
      const range = element.ownerDocument.createRange();

      range.setStart(...at(match.index, false));
      range.setEnd(...at(match.index + match[0].length, true));
      const { x, y, width, height } = range.getBoundingClientRect();

      if (width > 0 || height > 0)
        found.push({ text: match[0], box: { x: x + dx, y: y + dy, width, height } });
    }

    return found;
  };

  // What a selector selects that shows and meets the pick's other rules, in tree order.
  const selected = (pick: PickRequest & { readonly selector: string }) => {
    let elements: Array<Element>;

    try {
      elements = Array.from(document.querySelectorAll(pick.selector));
    } catch {
      return { invalid: `${JSON.stringify(pick.selector)} is not a CSS selector` };
    }
    const rules = matching.compile(pick);

    return elements.filter((element) => {
      const role = roleOf(element, pick.role !== null);
      const box = boxOf(element);

      return (
        !isOwn(element) &&
        box.width * box.height > 0 &&
        visible(element) &&
        (pick.scope === "document" || inView(new DOMRect(box.x, box.y, box.width, box.height))) &&
        (pick.state !== "enabled" || !isDisabled(element)) &&
        rules({
          role,
          name: () => nameOf(element, role),
          text: () => textOf(element),
          context: () => placing.contextOf(element),
        })
      );
    });
  };

  const read = (picks: ReadonlyArray<PickRequest>) => {
    const places = [];
    const missing: Array<string> = [];

    for (const pick of picks) {
      const elements =
        pick.selector === null
          ? subjected.elementsOf(pick)
          : selected({ ...pick, selector: pick.selector });

      if ("invalid" in elements) return { invalid: `${pick.id}: ${elements.invalid}` };
      const element = chosen(elements, pick.choose);

      if (element === undefined) {
        missing.push(pick.id);
        continue;
      }
      const role = roleOf(element, pick.role !== null);
      const box = boxOf(element);
      const own = element.getBoundingClientRect();

      places.push({
        id: pick.id,
        ref: refFor(element),
        subject: {
          role,
          name: nameOf(element, role),
          tag: element.tagName.toLowerCase(),
          context: placing.contextOf(element),
        },
        box,
        fixed: fixed(element),
        words:
          pick.words === null
            ? undefined
            : words(element, pick.words, box.x - own.x, box.y - own.y),
      });
    }

    return {
      layout: {
        url: location.href,
        viewport: { width: innerWidth, height: innerHeight },
        scroll: { x: scrollX, y: scrollY },
        scale: devicePixelRatio,
        places,
        missing,
      },
    };
  };

  return { read };
};

export type Layouts = ReturnType<typeof layout>;
