/**
 * In the page: the outline a model reads, with a ref for each control, and whether the page shows
 * some text. See `names.inpage.ts` for what a page-side part may use.
 */
import { Schema } from "effect";

import type { Names } from "./names.inpage.ts";

export interface SnapshotRequest {
  readonly full: boolean;
  readonly query: string | null;
  readonly maxChars: number;
  readonly firstRef: number;
}

export interface SnapshotResult {
  readonly text: string;
  readonly url: string;
  readonly title: string;
  readonly nextRef: number;
  readonly truncated: boolean;
  readonly above: number;
  readonly below: number;
  readonly width: number;
  readonly height: number;
  readonly scrollY: number;
  readonly scrollHeight: number;
}

export const outline = (names: Names) => {
  const {
    clean,
    containers,
    interactiveRoles,
    isDisabled,
    isFrame,
    isInput,
    isSelect,
    isTextArea,
    nameOf,
    refFor,
    refs,
    roleOf,
    textOf,
  } = names;

  const textBlocks = new Set([
    "P",
    "LI",
    "TD",
    "TH",
    "DT",
    "DD",
    "LABEL",
    "SPAN",
    "BLOCKQUOTE",
    "FIGCAPTION",
    "CAPTION",
    "PRE",
    "STRONG",
    "EM",
    "B",
    "I",
    "SMALL",
    "TIME",
    "CODE",
    "LEGEND",
  ]);

  const skipped = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "TEMPLATE",
    "HEAD",
    "META",
    "LINK",
    "SVG",
  ]);

  const nested =
    "a[href],button,input,select,textarea,summary,[role],[onclick],[tabindex],[contenteditable],canvas,iframe";

  const noise = /^[\s|•·\-–—,.:;()[\]{}"'/\\]*$/;

  /** Text inside a control's label is already that control's name. */
  const inControlLabel = (element: Element): boolean => {
    const label = element.closest("label");

    return label !== null && label.control !== null;
  };

  const isVisible = (element: Element, style: CSSStyleDeclaration, rect: DOMRect): boolean => {
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse"
    )
      return false;
    if (style.opacity === "0") return false;
    if (element.getAttribute("aria-hidden") === "true") return false;

    return rect.width > 0 || rect.height > 0 || style.display === "contents";
  };

  const states = (element: Element, role: string | null): string => {
    const out: Array<string> = [];

    if (role === "heading") out.push(`level=${element.tagName.slice(1)}`);
    if (isDisabled(element)) out.push("disabled");
    if (
      (role === "checkbox" || role === "radio" || role === "switch") &&
      ((isInput(element) && element.checked) || element.getAttribute("aria-checked") === "true")
    )
      out.push("checked");
    if (element.getAttribute("aria-expanded") === "true") out.push("expanded");
    if (element.getAttribute("aria-selected") === "true") out.push("selected");
    if (element.getAttribute("aria-pressed") === "true") out.push("pressed");
    if (element.ownerDocument.activeElement === element) out.push("focused");

    return out.map((state) => ` [${state}]`).join("");
  };

  const valueOf = (element: Element): string => {
    if (isInput(element)) {
      if (element.type === "password") return element.value === "" ? "" : ` value="••••"`;
      if (
        ["checkbox", "radio", "button", "submit", "reset", "image", "file"].includes(element.type)
      )
        return "";

      return element.value === "" ? "" : ` value=${JSON.stringify(clean(element.value, 80))}`;
    }
    if (isTextArea(element))
      return element.value === "" ? "" : ` value=${JSON.stringify(clean(element.value, 80))}`;
    if (isSelect(element)) {
      const selected = Array.from(element.selectedOptions, (option) => clean(option.text, 40));

      const options = Array.from(element.options)
        .slice(0, 12)
        .map((option) => clean(option.text, 40));

      const more = element.options.length > 12 ? ` +${element.options.length - 12} more` : "";

      return ` value=${JSON.stringify(selected.join(", "))} options=${JSON.stringify(options.join(" | ") + more)}`;
    }

    return "";
  };

  const hrefOf = (element: Element): string => {
    if (element.tagName !== "A") return "";
    const raw = element.getAttribute("href") ?? "";

    if (raw === "" || raw.startsWith("javascript:")) return "";
    try {
      const url = new URL(raw, element.ownerDocument.baseURI);

      const short =
        url.origin === location.origin ? url.pathname + url.search + url.hash : url.href;

      return ` -> ${clean(short, 80)}`;
    } catch {
      return "";
    }
  };

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

    const emit = (depth: number, line: string, rect: DOMRect): boolean => {
      const where = placement(rect);

      if (where === "above") above++;
      if (where === "below") below++;
      if (where !== "in") return false;
      if (query !== null && !line.toLowerCase().includes(query)) return false;
      lines.push(`${"  ".repeat(Math.min(depth, 8))}- ${line}`);

      return true;
    };

    const walk = (
      root: ParentNode,
      depth: number,
      insidePointer: boolean,
      dx: number,
      dy: number,
    ) => {
      for (const child of Array.from(root.children)) visit(child, depth, insidePointer, dx, dy);
    };

    const visit = (
      element: Element,
      depth: number,
      insidePointer: boolean,
      dx: number,
      dy: number,
    ): void => {
      if (skipped.has(element.tagName.toUpperCase())) return;
      const style = getComputedStyle(element);
      const local = element.getBoundingClientRect();

      if (!isVisible(element, style, local)) return;
      const rect = new DOMRect(local.x + dx, local.y + dy, local.width, local.height);
      const role = roleOf(element);
      const pointer = style.cursor === "pointer";

      const interactive =
        (role !== null && interactiveRoles.has(role)) ||
        role === "canvas" ||
        role === "iframe" ||
        element.hasAttribute("onclick") ||
        (pointer && !insidePointer && local.width > 0 && local.height > 0);

      if (interactive) {
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
          let inner: Document | null = null;

          try {
            inner = element.contentDocument;
          } catch {
            inner = null;
          }
          if (inner?.body !== null && inner?.body !== undefined)
            walk(inner.body, depth + 1, false, rect.x, rect.y);
          else if (placement(rect) === "in")
            lines.push(
              `${"  ".repeat(Math.min(depth + 1, 8))}- (another site's frame: use a screenshot and coordinates)`,
            );

          return;
        }
        if (["INPUT", "SELECT", "TEXTAREA", "CANVAS", "IMG"].includes(element.tagName)) return;
        for (const child of Array.from(element.children))
          if (child.matches(nested) || child.querySelector(nested) !== null)
            visit(child, depth + 1, true, dx, dy);

        return;
      }

      if (role === "heading") {
        emit(
          depth,
          `heading ${JSON.stringify(nameOf(element, role))}${states(element, role)}`,
          rect,
        );

        return;
      }
      if (role === "img") {
        const alt = nameOf(element, role);

        if (alt !== "") emit(depth, `img ${JSON.stringify(alt)}`, rect);

        return;
      }

      let inner = depth;

      if (role !== null && (containers[element.tagName] !== undefined || role === "dialog")) {
        const label = element.getAttribute("aria-label");

        if (
          emit(depth, `${role}${label === null ? "" : ` ${JSON.stringify(clean(label))}`}:`, rect)
        )
          inner = depth + 1;
      }

      if (textBlocks.has(element.tagName) && element.querySelector(nested) === null) {
        if (inControlLabel(element)) return;
        const text = clean(textOf(element), 300);

        if (text !== "" && !noise.test(text)) emit(inner, `text: ${text}`, rect);

        return;
      }

      let own = "";

      for (const node of Array.from(element.childNodes))
        if (node.nodeType === Node.TEXT_NODE) own += node.textContent ?? "";
      own = clean(own, 300);
      if (own !== "" && !noise.test(own) && !inControlLabel(element))
        emit(inner, `text: ${own}`, rect);
      if (element.shadowRoot !== null)
        walk(element.shadowRoot, inner, insidePointer || pointer, dx, dy);
      walk(element, inner, insidePointer || pointer, dx, dy);
    };

    walk(document, 0, false, 0, 0);

    let text = lines.join("\n");
    let truncated = false;

    if (text.length > request.maxChars) {
      const cut = text.lastIndexOf("\n", request.maxChars);

      text = text.slice(0, cut > 0 ? cut : request.maxChars);
      truncated = true;
    }

    return {
      text,
      url: location.href,
      title: document.title,
      nextRef: refs.next,
      truncated,
      above,
      below,
      width,
      height,
      scrollY: Math.round(window.scrollY),
      scrollHeight: Math.round(document.documentElement.scrollHeight),
    };
  };

  const hasText = (text: string): boolean =>
    (document.body?.innerText ?? "").toLowerCase().includes(text.toLowerCase());

  const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });

  return { hasText, snapshot, viewport };
};

export type Outline = ReturnType<typeof outline>;

export const SnapshotResultSchema = Schema.Struct({
  text: Schema.String,
  url: Schema.String,
  title: Schema.String,
  nextRef: Schema.Finite,
  truncated: Schema.Boolean,
  above: Schema.Finite,
  below: Schema.Finite,
  width: Schema.Finite,
  height: Schema.Finite,
  scrollY: Schema.Finite,
  scrollHeight: Schema.Finite,
});

export const ViewportResultSchema = Schema.Struct({
  width: Schema.Finite,
  height: Schema.Finite,
});
