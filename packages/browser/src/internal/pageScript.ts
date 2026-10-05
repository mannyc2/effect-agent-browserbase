/**
 * The script the library installs in an isolated world of each document. It reads the page into
 * a compact outline with refs, and resolves refs back to elements and viewport points.
 *
 * `install` is evaluated from its source text, so it must stay self-contained: everything it uses
 * is defined inside it. Its results come back as JSON and are decoded with the schemas below.
 */
import { Schema } from "effect";

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

export interface ResolvedPoint {
  readonly x: number;
  readonly y: number;
  readonly element: string;
  readonly role: string | null;
  readonly name: string;
  readonly cursor: string;
  readonly href?: string | undefined;
}

export type PointResult =
  | ResolvedPoint
  | {
      readonly error: "stale" | "hidden" | "offscreen" | "disabled" | "covered" | "outside";
      readonly detail: string;
    };

export type EditResult =
  | { readonly ok: true; readonly detail: string }
  | { readonly error: string };

export interface PageApi {
  readonly version: number;
  snapshot(request: SnapshotRequest): SnapshotResult;
  point(target: string | { readonly x: number; readonly y: number }): PointResult;
  viewport(): { readonly width: number; readonly height: number };
  focus(ref: string, replace: boolean): EditResult;
  select(ref: string, values: ReadonlyArray<string>): EditResult;
  hasText(text: string): boolean;
}

declare global {
  // The API this script installs, which exists only inside the library's isolated world.
  var __effectBrowser: PageApi | undefined;
}

export const install = (): PageApi => {
  const installed = globalThis.__effectBrowser;

  if (installed !== undefined && installed.version === 2) return installed;

  const byElement = new WeakMap<Element, string>();
  const byRef = new Map<string, WeakRef<Element>>();
  let next = 1;

  const interactiveRoles = new Set([
    "button",
    "link",
    "checkbox",
    "radio",
    "tab",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "option",
    "switch",
    "slider",
    "combobox",
    "listbox",
    "textbox",
    "searchbox",
    "spinbutton",
    "treeitem",
  ]);

  const containers: Record<string, string> = {
    HEADER: "banner",
    NAV: "navigation",
    MAIN: "main",
    ASIDE: "complementary",
    FOOTER: "contentinfo",
    FORM: "form",
    DIALOG: "dialog",
  };

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

  // Elements of a same-origin frame come from another realm, so tag names decide, not instanceof.
  const isInput = (element: Element): element is HTMLInputElement => element.tagName === "INPUT";

  const isTextArea = (element: Element): element is HTMLTextAreaElement =>
    element.tagName === "TEXTAREA";

  const isSelect = (element: Element): element is HTMLSelectElement => element.tagName === "SELECT";
  const isFrame = (element: Element): element is HTMLIFrameElement => element.tagName === "IFRAME";
  const isHtml = (element: Element): element is HTMLElement => "innerText" in element;

  const textOf = (element: Element): string =>
    isHtml(element) ? element.innerText : (element.textContent ?? "");

  const isElement = (node: Node): node is Element => node.nodeType === Node.ELEMENT_NODE;

  /** A label's own words, without the options or values of the controls inside it. */
  const labelText = (label: Element): string => {
    let text = "";

    const collect = (node: Node): void => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === Node.TEXT_NODE) text += child.textContent ?? "";
        else if (
          isElement(child) &&
          !["SELECT", "TEXTAREA", "INPUT", "SCRIPT", "STYLE"].includes(child.tagName)
        )
          collect(child);
      }
    };

    collect(label);

    return text;
  };

  /** Text inside a control's label is already that control's name. */
  const inControlLabel = (element: Element): boolean => {
    const label = element.closest("label");

    return label !== null && label.control !== null;
  };

  const clean = (value: string | null | undefined, max = 160): string => {
    const text = (value ?? "").replace(/\s+/g, " ").trim();

    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  };

  const roleOf = (element: Element): string | null => {
    const explicit = element.getAttribute("role");

    if (explicit !== null && explicit.trim() !== "") return explicit.trim().split(/\s+/)[0] ?? null;
    const tag = element.tagName;

    if (tag === "A") return element.hasAttribute("href") ? "link" : null;
    if (tag === "BUTTON" || tag === "SUMMARY") return "button";
    if (isSelect(element)) return element.multiple ? "listbox" : "combobox";
    if (tag === "TEXTAREA") return "textbox";
    if (isInput(element)) {
      const type = element.type;

      if (type === "hidden") return null;
      if (type === "checkbox" || type === "radio") return type;
      if (type === "range") return "slider";
      if (type === "number") return "spinbutton";
      if (type === "search") return "searchbox";
      if (type === "button" || type === "submit" || type === "reset" || type === "image")
        return "button";

      return "textbox";
    }
    if (/^H[1-6]$/.test(tag)) return "heading";
    if (tag === "IMG") return "img";
    if (tag === "CANVAS") return "canvas";
    if (tag === "IFRAME") return "iframe";
    if (element.getAttribute("contenteditable") === "true") return "textbox";

    return containers[tag] ?? null;
  };

  const nameOf = (element: Element, role: string | null): string => {
    const label = element.getAttribute("aria-label");

    if (label !== null && clean(label) !== "") return clean(label);
    const labelledBy = element.getAttribute("aria-labelledby");

    if (labelledBy !== null) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? "")
        .join(" ");

      if (clean(text) !== "") return clean(text);
    }
    if (isInput(element) || isTextArea(element) || isSelect(element)) {
      const labels = element.labels === null ? "" : Array.from(element.labels, labelText).join(" ");

      if (clean(labels) !== "") return clean(labels);
      if (
        isInput(element) &&
        (element.type === "button" || element.type === "submit" || element.type === "reset")
      )
        return clean(element.value);

      return clean(
        element.getAttribute("placeholder") ??
          element.getAttribute("title") ??
          element.getAttribute("name"),
      );
    }
    if (role === "img") return clean(element.getAttribute("alt") ?? element.getAttribute("title"));
    if (role === "iframe")
      return clean(element.getAttribute("title") ?? element.getAttribute("name"));
    if (role === null || interactiveRoles.has(role) || role === "heading") {
      const text = clean(textOf(element), 120);

      if (text !== "") return text;
      const titled = element.querySelector("[title],img[alt],svg title");

      const fallback =
        titled === null
          ? null
          : titled.tagName === "IMG"
            ? titled.getAttribute("alt")
            : titled.tagName.toLowerCase() === "title"
              ? titled.textContent
              : titled.getAttribute("title");

      return clean(element.getAttribute("title") ?? fallback);
    }

    return "";
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

  const isDisabled = (element: Element): boolean =>
    ("disabled" in element && element.disabled === true) ||
    element.getAttribute("aria-disabled") === "true";

  const refFor = (element: Element): string => {
    const known = byElement.get(element);

    if (known !== undefined && byRef.get(known)?.deref() === element) return known;
    const ref = `e${next++}`;

    byElement.set(element, ref);
    byRef.set(ref, new WeakRef(element));

    return ref;
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
    if (next < request.firstRef) next = request.firstRef;
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
      nextRef: next,
      truncated,
      above,
      below,
      width,
      height,
      scrollY: Math.round(window.scrollY),
      scrollHeight: Math.round(document.documentElement.scrollHeight),
    };
  };

  const lookup = (ref: string): Element | undefined => {
    const element = byRef.get(ref)?.deref();

    return element !== undefined && element.isConnected ? element : undefined;
  };

  const describe = (element: Element): string => {
    const id = element.id === "" ? "" : `#${element.id}`;
    const name = clean(nameOf(element, roleOf(element)), 40);

    return `<${element.tagName.toLowerCase()}${id}>${name === "" ? "" : ` "${name}"`}`;
  };

  const isRoot = (node: Node): node is Document | ShadowRoot =>
    node.nodeType === Node.DOCUMENT_NODE || node.nodeType === Node.DOCUMENT_FRAGMENT_NODE;

  const parentOf = (element: Element): Element | null => {
    const root = element.getRootNode();

    return element.parentElement ?? (isRoot(root) && "host" in root ? root.host : null);
  };

  // A painted child of a control still activates the control; keep its name without moving the point.
  const controlOf = (hit: Element): Element => {
    let element: Element | null = hit;

    while (element !== null) {
      const role = roleOf(element);

      if (
        (role !== null && (interactiveRoles.has(role) || role === "canvas" || role === "iframe")) ||
        element.hasAttribute("onclick")
      )
        return element;
      element = parentOf(element);
    }

    return hit;
  };

  // Coordinate subtraction is valid only for an untransformed frame. Report the frame itself
  // otherwise: the real pixel input still works, and its receipt must not name a guessed child.
  const untransformed = (frame: HTMLIFrameElement, rect: DOMRect): boolean => {
    if (rect.width !== frame.offsetWidth || rect.height !== frame.offsetHeight) return false;
    let ancestor: Element | null = frame;

    while (ancestor !== null) {
      const view = ancestor.ownerDocument.defaultView ?? window;
      const style = view.getComputedStyle(ancestor);

      if (
        style.transform !== "none" ||
        style.scale !== "none" ||
        style.rotate !== "none" ||
        style.perspective !== "none" ||
        style.zoom !== "1"
      )
        return false;
      ancestor = parentOf(ancestor);
    }

    return true;
  };

  const hitAt = (root: Document | ShadowRoot, x: number, y: number): Element | null => {
    let hit = root.elementFromPoint(x, y);

    while (hit?.shadowRoot !== null && hit?.shadowRoot !== undefined) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);

      if (inner === null || inner === hit) break;
      hit = inner;
    }
    if (hit !== null && isFrame(hit)) {
      const document = hit.contentDocument;

      if (document !== null) {
        const rect = hit.getBoundingClientRect();

        if (untransformed(hit, rect))
          return (
            hitAt(document, x - rect.left - hit.clientLeft, y - rect.top - hit.clientTop) ?? hit
          );
      }
    }

    return hit;
  };

  const details = (element: Element, hit: Element, x: number, y: number): ResolvedPoint => {
    let link: Element | null = element;

    while (link !== null && (link.tagName !== "A" || !link.hasAttribute("href")))
      link = parentOf(link);
    let href: string | undefined;

    if (link !== null) {
      try {
        href = new URL(link.getAttribute("href") ?? "", link.ownerDocument.baseURI).href;
      } catch {
        href = undefined;
      }
    }
    const role = roleOf(element);
    const view = hit.ownerDocument.defaultView ?? window;

    return {
      x,
      y,
      element: describe(element),
      role,
      name: nameOf(element, role),
      cursor: view.getComputedStyle(hit).cursor,
      ...(href === undefined ? {} : { href }),
    };
  };

  const point = (target: string | { readonly x: number; readonly y: number }): PointResult => {
    if (typeof target !== "string") {
      const { x, y } = target;

      if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        x < 0 ||
        y < 0 ||
        x >= window.innerWidth ||
        y >= window.innerHeight
      )
        return { error: "outside", detail: `(${x}, ${y}) is outside the viewport` };
      const hit = hitAt(document, x, y);

      return hit === null
        ? { error: "offscreen", detail: `nothing is painted at (${x}, ${y})` }
        : details(controlOf(hit), hit, x, y);
    }
    const ref = target;
    const element = lookup(ref);

    if (element === undefined)
      return { error: "stale", detail: `${ref} is not on the page any more` };
    if (isDisabled(element)) return { error: "disabled", detail: `${ref} is disabled` };
    const view = element.ownerDocument.defaultView ?? window;
    let rect = element.getBoundingClientRect();

    if (rect.width === 0 && rect.height === 0)
      return { error: "hidden", detail: `${ref} has no size on the page` };
    if (
      rect.top < 0 ||
      rect.left < 0 ||
      rect.bottom > view.innerHeight ||
      rect.right > view.innerWidth
    ) {
      element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      rect = element.getBoundingClientRect();
    }
    const left = Math.max(rect.left, 0);
    const top = Math.max(rect.top, 0);
    const right = Math.min(rect.right, view.innerWidth);
    const bottom = Math.min(rect.bottom, view.innerHeight);

    if (right <= left || bottom <= top)
      return { error: "offscreen", detail: `${ref} could not be scrolled into view` };
    const x = (left + right) / 2;
    const y = (top + bottom) / 2;
    const root = element.getRootNode();
    const hit = isRoot(root) ? root.elementFromPoint(x, y) : null;

    if (hit !== null && hit !== element && !element.contains(hit) && !hit.contains(element))
      return { error: "covered", detail: `${ref} is covered by ${describe(hit)}` };
    let offsetX = 0;
    let offsetY = 0;
    let frame = view.frameElement;

    while (frame !== null) {
      const box = frame.getBoundingClientRect();

      offsetX += box.left + frame.clientLeft;
      offsetY += box.top + frame.clientTop;
      frame = frame.ownerDocument.defaultView?.frameElement ?? null;
    }

    return details(
      element,
      isRoot(root) ? (hitAt(root, x, y) ?? element) : element,
      Math.round(x + offsetX),
      Math.round(y + offsetY),
    );
  };

  const focus = (ref: string, replace: boolean): EditResult => {
    const element = lookup(ref);

    if (element === undefined) return { error: `${ref} is not on the page any more` };
    if (isDisabled(element)) return { error: `${ref} is disabled` };
    if (
      !isInput(element) &&
      !isTextArea(element) &&
      !(isHtml(element) && element.isContentEditable)
    )
      return { error: `${ref} is ${describe(element)}, not a text field` };
    if (isHtml(element)) element.focus();
    if (replace) {
      if (isInput(element) || isTextArea(element)) element.select();
      else element.ownerDocument.getSelection()?.selectAllChildren(element);
    }

    return { ok: true, detail: describe(element) };
  };

  const select = (ref: string, values: ReadonlyArray<string>): EditResult => {
    const element = lookup(ref);

    if (element === undefined) return { error: `${ref} is not on the page any more` };
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

  const hasText = (text: string): boolean =>
    (document.body?.innerText ?? "").toLowerCase().includes(text.toLowerCase());

  const api: PageApi = {
    version: 2,
    snapshot,
    point,
    viewport: () => ({ width: window.innerWidth, height: window.innerHeight }),
    focus,
    select,
    hasText,
  };

  globalThis.__effectBrowser = api;

  return api;
};

/** The expression that installs the script and evaluates to its API. */
export const installSource = `(${install.toString()})()`;

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

export const PointResultSchema = Schema.Union([
  Schema.Struct({
    x: Schema.Finite,
    y: Schema.Finite,
    element: Schema.String,
    role: Schema.NullOr(Schema.String),
    name: Schema.String,
    cursor: Schema.String,
    href: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    error: Schema.Literals(["stale", "hidden", "offscreen", "disabled", "covered", "outside"]),
    detail: Schema.String,
  }),
]);

export const ViewportResultSchema = Schema.Struct({
  width: Schema.Finite,
  height: Schema.Finite,
});

export const EditResultSchema = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), detail: Schema.String }),
  Schema.Struct({ error: Schema.String }),
]);
