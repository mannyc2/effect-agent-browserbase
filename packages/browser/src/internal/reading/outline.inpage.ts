/**
 * In the page: the outline a model reads, with a ref for each control. See `names.inpage.ts` for
 * what a page-side part may use.
 */
import { Schema } from "effect";

import type { Snapshot } from "../../Snapshot.ts";
import type { addresses } from "../page/url.ts";
import type { Names } from "./names.inpage.ts";
import type { Subjects } from "./subjects.inpage.ts";
import type { Texts } from "./text.inpage.ts";
import type { Walk } from "./walk.inpage.ts";

export interface SnapshotRequest {
  readonly full: boolean;
  readonly query: string | null;
  readonly maxChars: number;
  readonly firstRef: number;
}

/** The outline as a `Snapshot` reads it, and the next ref the page may give. */
export interface SnapshotResult {
  readonly snapshot: typeof Snapshot.Encoded;
  readonly nextRef: number;
}

/** The rule every address the library reports goes by, which a link's address goes by too. */
type Url = ReturnType<typeof addresses>;

export const outline = (names: Names, walked: Walk, subjects: Subjects, texts: Texts, url: Url) => {
  const { clean, containers, isFrame, isInput, isSelect, isTextArea, nameOf, refFor, refs } = names;
  const { roleOf, textOf } = names;
  const { visit } = walked;
  const { isControl, stateOf } = subjects;
  const { cut, shown } = texts;

  const textBlocks =
    /^(?:P|LI|TD|TH|DT|DD|LABEL|SPAN|BLOCKQUOTE|FIGCAPTION|CAPTION|PRE|STRONG|EM|B|I|SMALL|TIME|CODE|LEGEND)$/;

  const nested =
    "a[href],button,input,select,textarea,summary,[role],[onclick],[tabindex],[contenteditable],canvas,iframe";

  const noise = /^[\s|•·\-–—,.:;()[\]{}"'/\\]*$/;

  /** Text inside a control's label is already that control's name. */
  const inControlLabel = (element: Element): boolean => {
    const label = element.closest("label");

    return label !== null && label.control !== null;
  };

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

  const hrefOf = (element: Element): string => {
    if (element.tagName !== "A") return "";
    const raw = element.getAttribute("href") ?? "";

    if (raw === "" || raw.startsWith("javascript:")) return "";
    try {
      const { origin, href } = new URL(raw, element.ownerDocument.baseURI);
      // Reported as every address is, before it is shortened, so no part of a credential shows.
      const reported = url.redact(href);
      const own = origin === location.origin && reported.startsWith(origin);

      return ` -> ${clean(own ? reported.slice(origin.length) : reported, 80)}`;
    } catch {
      return "";
    }
  };

  interface Place {
    readonly depth: number;
    readonly insidePointer: boolean;
    /** Inside a control, only the controls in it are read. */
    readonly controls: boolean;
  }

  const snapshot = (request: SnapshotRequest): SnapshotResult => {
    if (refs.next < request.firstRef) refs.next = request.firstRef;
    const width = window.innerWidth;
    const height = window.innerHeight;
    const query = request.query === null ? null : request.query.toLowerCase();
    const lines: Array<string> = [];
    let above = 0;
    let below = 0;

    const placement = (rect: DOMRect): "in" | "above" | "below" | "aside" => {
      if (request.full) return "in";
      if (rect.bottom <= 0) return "above";
      if (rect.top >= height) return "below";
      if (rect.right <= 0 || rect.left >= width) return "aside";

      return "in";
    };

    const count = (rect: DOMRect) => {
      const where = placement(rect);

      if (where === "above") above++;
      if (where === "below") below++;

      return where;
    };

    const emit = (depth: number, line: string, rect: DOMRect): boolean => {
      if (count(rect) !== "in") return false;
      if (query !== null && !line.toLowerCase().includes(query)) return false;
      lines.push(`${"  ".repeat(Math.min(depth, 8))}- ${line}`);

      return true;
    };

    const control = (element: Element, rect: DOMRect, role: string | null, depth: number) => {
      const name = nameOf(element, role);
      const kind = role ?? "clickable";

      const box =
        role === "canvas" || role === "iframe"
          ? ` ${Math.round(rect.width)}x${Math.round(rect.height)} at (${Math.round(rect.x)},${Math.round(rect.y)})`
          : "";

      const line =
        placement(rect) === "in"
          ? `${kind}${name === "" ? "" : ` ${JSON.stringify(name)}`} [ref=${refFor(element)}]${states(element, role)}${valueOf(element)}${hrefOf(element)}${box}`
          : kind;

      emit(depth, line, rect);
      if (isFrame(element)) {
        const body = element.contentDocument?.body;

        if ((body === null || body === undefined) && placement(rect) === "in")
          lines.push(
            `${"  ".repeat(Math.min(depth + 1, 8))}- (another site's frame: use a screenshot and coordinates)`,
          );

        return { depth: depth + 1, insidePointer: false, controls: false };
      }
      if (["INPUT", "SELECT", "TEXTAREA", "CANVAS", "IMG"].includes(element.tagName))
        return undefined;

      return { depth: depth + 1, insidePointer: true, controls: true };
    };

    const enter = (
      element: Element,
      style: CSSStyleDeclaration,
      rect: DOMRect,
      { depth, insidePointer }: Place,
    ): Place | undefined => {
      const role = roleOf(element);

      if (isControl(element, role, style, rect, insidePointer))
        return control(element, rect, role, depth);
      if (role === "heading") {
        emit(
          depth,
          `heading ${JSON.stringify(nameOf(element, role))}${states(element, role)}`,
          rect,
        );

        return undefined;
      }
      if (role === "img") {
        const alt = nameOf(element, role);

        if (alt !== "") emit(depth, `img ${JSON.stringify(alt)}`, rect);

        return undefined;
      }
      let inner = depth;

      if (role !== null && (containers[element.tagName] !== undefined || role === "dialog")) {
        const label = element.getAttribute("aria-label");

        if (
          emit(depth, `${role}${label === null ? "" : ` ${JSON.stringify(clean(label))}`}:`, rect)
        )
          inner = depth + 1;
      }

      if (textBlocks.test(element.tagName) && element.querySelector(nested) === null) {
        if (inControlLabel(element)) return undefined;
        const text = clean(textOf(element), 300);

        if (text !== "" && !noise.test(text)) emit(inner, `text: ${text}`, rect);

        return undefined;
      }

      let own = "";

      for (const node of Array.from(element.childNodes))
        if (node.nodeType === Node.TEXT_NODE) own += node.textContent ?? "";
      own = clean(own, 300);
      if (own !== "" && !noise.test(own) && !inControlLabel(element))
        emit(inner, `text: ${own}`, rect);

      return {
        depth: inner,
        insidePointer: insidePointer || style.cursor === "pointer",
        controls: false,
      };
    };

    // Inside the viewport, a subtree out of view is skipped whole and counted as one part.
    visit(
      null,
      !request.full,
      { depth: 0, insidePointer: false, controls: false },
      {
        enter,
        admit: (child, place) =>
          !place.controls || child.matches(nested) || child.querySelector(nested) !== null,
        outside: count,
      },
    );

    return {
      snapshot: {
        ...cut(lines.join("\n"), request.maxChars),
        url: location.href,
        title: document.title,
        above,
        below,
        viewport: { width, height },
        scroll: {
          y: Math.round(window.scrollY),
          height: Math.round(document.documentElement.scrollHeight),
        },
      },
      nextRef: refs.next,
    };
  };

  const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });

  return { snapshot, viewport };
};

export type Outline = ReturnType<typeof outline>;

export const ViewportResultSchema = Schema.Struct({
  width: Schema.Finite,
  height: Schema.Finite,
});
