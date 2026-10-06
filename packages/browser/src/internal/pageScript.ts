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
  readonly tag: string;
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

export const Fact = Schema.Literals([
  "form-submit",
  "cross-origin",
  "download",
  "upload",
  "secret",
  "scripted",
  "opaque",
]);

export type Fact = typeof Fact.Type;

export interface InputPlan {
  readonly action: string;
  readonly targets: ReadonlyArray<string | { readonly x: number; readonly y: number } | null>;
  readonly submit: boolean;
  readonly keys: string | null;
  readonly destination: string | null;
}

export interface InspectedTarget {
  readonly ref: string;
  readonly element: string;
  readonly role: string | null;
  readonly name: string;
  readonly cursor: string;
  readonly href?: string | undefined;
  /** A field the DOM marks as holding a password, a one-time code or a card's details. */
  readonly secret: boolean;
  readonly fingerprint: string;
}

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

export interface PreparedInput {
  readonly url: string;
  readonly targets: ReadonlyArray<InspectedTarget | null>;
  readonly facts: ReadonlyArray<Fact>;
  readonly destination?: string | undefined;
  readonly evidence: Evidence;
}

/** A refusal; a stale target is named by its index in the plan. */
export interface InputFailure {
  readonly error: string;
  readonly detail: string;
  readonly index?: number | undefined;
}

export type PreparedInputResult = PreparedInput | InputFailure;

export type ValidatedInputResult = { readonly ok: true } | InputFailure;

/** A point where a target, by its index in the plan, is about to receive a press. */
export interface Press {
  readonly index: number;
  readonly x: number;
  readonly y: number;
}

export interface ValidationOptions {
  /** Require focus on the first target. */
  readonly focused?: boolean;
  /** After the pointer's own events have run, each target must still receive its press. */
  readonly presses?: ReadonlyArray<Press>;
}

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

export interface PageApi {
  readonly version: number;
  snapshot(request: SnapshotRequest): SnapshotResult;
  point(target: string | { readonly x: number; readonly y: number }, scroll?: boolean): PointResult;
  scrollPlan(
    ref: string,
  ): { readonly x: number; readonly y: number; readonly dx: number; readonly dy: number } | null;
  viewport(): { readonly width: number; readonly height: number };
  prepareInput(plan: InputPlan): PreparedInputResult;
  validateInput(
    plan: InputPlan,
    prepared: PreparedInput,
    options?: ValidationOptions,
  ): ValidatedInputResult | Promise<ValidatedInputResult>;
  typeable(ref: string | null): TypeableResult;
  focus(ref: string, replace: boolean): FocusResult;
  checkText(ref: string, expected: string): EditResult;
  select(ref: string, values: ReadonlyArray<string>): EditResult;
  hasText(text: string): boolean;
}

declare global {
  // The API this script installs, which exists only inside the library's isolated world.
  var __effectBrowser: PageApi | undefined;
}

export const install = (): PageApi => {
  const installed = globalThis.__effectBrowser;

  if (installed !== undefined && installed.version === 5) return installed;

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
  const isDocument = (node: Node): node is Document => node.nodeType === Node.DOCUMENT_NODE;

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
      // An editable secret field's text is what was typed into it.
      const text = isSecret(element) ? "" : clean(textOf(element), 120);

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

  // A ref names an element of the current documents only: nodes of a navigated frame can stay
  // connected to their old document, and must not be measured or typed into.
  const lookup = (ref: string): Element | undefined => {
    const element = byRef.get(ref)?.deref();

    return element !== undefined && element.isConnected && inCurrentDocument(element)
      ? element
      : undefined;
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

  /** Whether `node` is `ancestor` or inside it, across shadow roots and same-origin frames. */
  const within = (ancestor: Element, node: Element): boolean => {
    for (let current: Element | null = node; current !== null;) {
      if (current === ancestor) return true;
      current = parentOf(current) ?? current.ownerDocument.defaultView?.frameElement ?? null;
    }

    return false;
  };

  // A press at a point reaches the element when the top-document hit is the element, inside it,
  // or one of its containers (whose activation the element's own facts already cover).
  const receives = (element: Element, hit: Element): boolean =>
    within(element, hit) || within(hit, element);

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

  const isLabel = (element: Element): element is HTMLLabelElement => element.tagName === "LABEL";

  // HTML links, SVG links and image-map areas all navigate; SVG keeps lowercase tag names.
  const hrefAttribute = (element: Element): string | null =>
    element.localName === "a" || element.localName === "area"
      ? (element.getAttribute("href") ??
        element.getAttributeNS("http://www.w3.org/1999/xlink", "href"))
      : null;

  const linkOf = (element: Element): Element | undefined => {
    for (let node: Element | null = element; node !== null; node = parentOf(node))
      if (hrefAttribute(node) !== null) return node;

    return undefined;
  };

  /**
   * The element whose activation behaviour a click or key on `element` runs, as the browser
   * resolves it along the composed path: a link, button, input, summary or a label's control.
   */
  const activationTarget = (element: Element): Element | undefined => {
    for (let node: Element | null = element; node !== null; node = parentOf(node)) {
      if (
        hrefAttribute(node) !== null ||
        node.tagName === "BUTTON" ||
        node.tagName === "SUMMARY" ||
        (isInput(node) && node.type !== "hidden")
      )
        return node;
      if (isLabel(node) && node.control !== null) return node.control;
    }

    return undefined;
  };

  /**
   * A control between a press's hit and the approved target that is not the target's own
   * activation, such as a link or button a hover handler nested into it. The approval inspected
   * the target, so that control would act unapproved.
   */
  const nestedControl = (element: Element, hit: Element): Element | undefined => {
    // A container of the target is covered by the target's own facts.
    if (!within(element, hit)) return undefined;
    const own = activationTarget(element);

    for (
      let node: Element | null = hit;
      node !== null && node !== element;
      node = parentOf(node) ?? node.ownerDocument.defaultView?.frameElement ?? null
    )
      if (
        node !== own &&
        (hrefAttribute(node) !== null ||
          node.tagName === "BUTTON" ||
          node.tagName === "SUMMARY" ||
          (isInput(node) && node.type !== "hidden") ||
          isSelect(node) ||
          isTextArea(node) ||
          (isLabel(node) && node.control !== null && node.control !== own) ||
          activatingRoles.has(roleOf(node) ?? ""))
      )
        return node;

    return undefined;
  };

  const textEntry = (element: Element): boolean =>
    (isInput(element) &&
      ![
        "button",
        "reset",
        "submit",
        "image",
        "checkbox",
        "radio",
        "file",
        "range",
        "color",
        "hidden",
      ].includes(element.type)) ||
    isTextArea(element) ||
    (isHtml(element) && element.isContentEditable);

  const activatingRoles = new Set([
    "button",
    "link",
    "checkbox",
    "radio",
    "switch",
    "tab",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "option",
    "treeitem",
  ]);

  // Typed text goes wherever focus is, and a typed space or letter can press a focused button,
  // toggle a box, follow a link or change a select. Only fields, or elements that are none of
  // these (a page or a canvas game), may receive text.
  const typingRefusal = (element: Element, explicit: boolean): string | undefined =>
    textEntry(element)
      ? undefined
      : explicit
        ? `${describe(element)} is not a text field`
        : activationTarget(element) !== undefined ||
            isSelect(element) ||
            activatingRoles.has(roleOf(element) ?? "")
          ? `focus is on ${describe(element)}, which typed text could activate or change; type into a text field by ref, or use press for keys`
          : undefined;

  const details = (element: Element, hit: Element, x: number, y: number): ResolvedPoint => {
    const link = linkOf(element);
    let href: string | undefined;

    if (link !== undefined) {
      try {
        href = new URL(hrefAttribute(link) ?? "", link.ownerDocument.baseURI).href;
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
      tag: element.tagName.toLowerCase(),
      role,
      name: nameOf(element, role),
      cursor: view.getComputedStyle(hit).cursor,
      ...(href === undefined ? {} : { href }),
    };
  };

  const point = (
    target: string | { readonly x: number; readonly y: number },
    scroll = true,
  ): PointResult => {
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
    const rect = element.getBoundingClientRect();

    if (rect.width === 0 && rect.height === 0)
      return { error: "hidden", detail: `${ref} has no size on the page` };

    // Input arrives in top-document viewport pixels, so geometry and occlusion are measured
    // there: a frame's own viewport cannot say whether the frame is scrolled away or covered.
    let box = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    let visible = { ...box };
    let outside = false;

    for (let inner: Element = element; ;) {
      const view = inner.ownerDocument.defaultView ?? window;

      outside ||=
        box.left < 0 || box.top < 0 || box.right > view.innerWidth || box.bottom > view.innerHeight;
      visible = {
        left: Math.max(visible.left, 0),
        top: Math.max(visible.top, 0),
        right: Math.min(visible.right, view.innerWidth),
        bottom: Math.min(visible.bottom, view.innerHeight),
      };

      // A field can be inside the viewport and still clipped by a nested scrolling panel.
      for (let ancestor = parentOf(inner); ancestor !== null; ancestor = parentOf(ancestor)) {
        const style = view.getComputedStyle(ancestor);
        const clip = ancestor.getBoundingClientRect();

        if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
          visible.left = Math.max(visible.left, clip.left + ancestor.clientLeft);
          visible.right = Math.min(
            visible.right,
            clip.left + ancestor.clientLeft + ancestor.clientWidth,
          );
        }
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
          visible.top = Math.max(visible.top, clip.top + ancestor.clientTop);
          visible.bottom = Math.min(
            visible.bottom,
            clip.top + ancestor.clientTop + ancestor.clientHeight,
          );
        }
      }

      const frame = view.frameElement;

      if (frame === null) break;
      const frameBox = frame.getBoundingClientRect();
      const dx = frameBox.left + frame.clientLeft;
      const dy = frameBox.top + frame.clientTop;

      box = {
        left: box.left + dx,
        top: box.top + dy,
        right: box.right + dx,
        bottom: box.bottom + dy,
      };
      visible = {
        left: Math.max(visible.left + dx, dx),
        top: Math.max(visible.top + dy, dy),
        right: Math.min(visible.right + dx, dx + frame.clientWidth),
        bottom: Math.min(visible.bottom + dy, dy + frame.clientHeight),
      };
      inner = frame;
    }

    if (outside || visible.right <= visible.left || visible.bottom <= visible.top) {
      if (scroll) {
        element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });

        return point(target, false);
      }

      return {
        error: "offscreen",
        detail: outside
          ? ref + " is outside the viewport"
          : `${ref} could not be scrolled into view`,
      };
    }
    const x = (visible.left + visible.right) / 2;
    const y = (visible.top + visible.bottom) / 2;
    const hit = hitAt(document, x, y);

    if (hit !== null && !receives(element, hit))
      return { error: "covered", detail: `${ref} is covered by ${describe(hit)}` };

    return details(element, hit ?? element, Math.round(x), Math.round(y));
  };

  // Suggest one visible wheel origin. Unsupported frame geometry and fully clipped panels use
  // the bounded instant fallback; guessing their coordinates could scroll an unrelated control.
  const scrollPlan = (ref: string) => {
    const element = lookup(ref);

    if (element === undefined || element.ownerDocument !== document) return null;
    const target = element.getBoundingClientRect();
    const centerX = (target.left + target.right) / 2;
    const centerY = (target.top + target.bottom) / 2;

    for (let ancestor = parentOf(element); ancestor !== null; ancestor = parentOf(ancestor)) {
      const style = window.getComputedStyle(ancestor);

      const horizontal =
        /^(auto|scroll)$/.test(style.overflowX) && ancestor.scrollWidth > ancestor.clientWidth;

      const vertical =
        /^(auto|scroll)$/.test(style.overflowY) && ancestor.scrollHeight > ancestor.clientHeight;

      if (!horizontal && !vertical) continue;
      const box = ancestor.getBoundingClientRect();
      const left = Math.max(0, box.left + ancestor.clientLeft);
      const top = Math.max(0, box.top + ancestor.clientTop);

      const right = Math.min(
        window.innerWidth,
        box.left + ancestor.clientLeft + ancestor.clientWidth,
      );

      const bottom = Math.min(
        window.innerHeight,
        box.top + ancestor.clientTop + ancestor.clientHeight,
      );

      if (right <= left || bottom <= top) continue;
      const x = (left + right) / 2;
      const y = (top + bottom) / 2;
      const dx = horizontal && (target.left < left || target.right > right) ? centerX - x : 0;
      const dy = vertical && (target.top < top || target.bottom > bottom) ? centerY - y : 0;

      if (dx === 0 && dy === 0) continue;
      const hit = hitAt(document, x, y);

      if (hit !== null && (hit === ancestor || ancestor.contains(hit))) return { x, y, dx, dy };
    }

    const dx =
      target.left < 0 || target.right > window.innerWidth ? centerX - window.innerWidth / 2 : 0;

    const dy =
      target.top < 0 || target.bottom > window.innerHeight ? centerY - window.innerHeight / 2 : 0;

    return dx === 0 && dy === 0
      ? null
      : { x: window.innerWidth / 2, y: window.innerHeight / 2, dx, dy };
  };

  const isButton = (element: Element): element is HTMLButtonElement => element.tagName === "BUTTON";

  const isSubmitter = (element: Element): element is HTMLButtonElement | HTMLInputElement =>
    (isButton(element) && element.type === "submit") ||
    (isInput(element) && (element.type === "submit" || element.type === "image"));

  const activeElement = (): Element | null => {
    let active = document.activeElement;

    while (active !== null) {
      const inner =
        active.shadowRoot?.activeElement ??
        (isFrame(active) ? active.contentDocument?.activeElement : null);

      if (inner === null || inner === undefined || inner === active) return active;
      active = inner;
    }

    return null;
  };

  const inCurrentDocument = (element: Element): boolean => {
    let owner = element.ownerDocument;

    // Nodes in a navigated iframe can remain connected to their old Document. Approval
    // requires the current frame chain as well as the ref's weakly held node identity.
    while (owner !== document) {
      const frame = owner.defaultView?.frameElement;

      if (
        frame === null ||
        frame === undefined ||
        !frame.isConnected ||
        (isFrame(frame) && frame.contentDocument !== owner)
      )
        return false;
      owner = frame.ownerDocument;
    }

    return true;
  };

  // form.elements omits image submitters. Walk the whole root in tree order so an Enter
  // submission uses the real default button, including controls associated from outside the form.
  const defaultSubmitter = (form: HTMLFormElement) => {
    const root = form.getRootNode();

    return isRoot(root)
      ? Array.from(root.querySelectorAll("button,input")).find(
          (candidate): candidate is HTMLButtonElement | HTMLInputElement =>
            isSubmitter(candidate) && candidate.form === form,
        )
      : undefined;
  };

  const sensitive =
    /password|passwd|secret|credential|token|username|user.?name|login|sign.?in|one.?time|otp|security|auth|email|e-mail|url|website|phone|tel(?:ephone)?|account|card|payment|billing|order|trade|quantity|amount|price|postal|zip|address|iban|routing|cc-/i;

  // Attributes that say what a field is for. They bind an approval and decide prose eligibility.
  const purpose = (control: Element, form: HTMLFormElement | null) => [
    control.getAttribute("id"),
    control.getAttribute("name"),
    control.getAttribute("inputmode"),
    control.getAttribute("autocomplete"),
    control.getAttribute("aria-label"),
    form?.getAttribute("id"),
    form?.getAttribute("name"),
    form?.getAttribute("aria-label"),
  ];

  /** Free prose only: never numbers, addresses, credentials, payment or order fields. */
  const proseEligible = (control: Element): boolean => {
    const form = isTextArea(control) ? control.form : null;
    const submitter = form === null ? undefined : defaultSubmitter(form);
    const inputMode = control.getAttribute("inputmode");

    return (
      (isTextArea(control) || (isHtml(control) && control.isContentEditable)) &&
      !isDisabled(control) &&
      !control.hasAttribute("readonly") &&
      control.getAttribute("aria-readonly") !== "true" &&
      (inputMode === null || inputMode === "" || inputMode === "text") &&
      ![
        ...purpose(control, form),
        nameOf(control, roleOf(control)),
        submitter === undefined ? null : nameOf(submitter, roleOf(submitter)),
      ].some((value) => value !== null && value !== undefined && sensitive.test(value))
    );
  };

  // What an approval binds of a URL. A fragment that names a place on the page, which scroll-spy
  // and feed pages rewrite as they scroll, is left out. A hash route (#/… or #!…) stays: it
  // selects what the page's controls act on.
  const boundUrl = (url: string): string => {
    const hash = url.indexOf("#");

    return hash === -1 || /^#[/!]/.test(url.slice(hash)) ? url : url.slice(0, hash);
  };

  // Autocomplete tokens for a password, a one-time code, or a payment card's number, code or expiry.
  const secretTokens = new Set([
    "current-password",
    "new-password",
    "one-time-code",
    "cc-number",
    "cc-csc",
    "cc-exp",
    "cc-exp-month",
    "cc-exp-year",
  ]);

  /** A field the DOM itself marks as secret, by its type or its autocomplete tokens. */
  const isSecret = (element: Element): boolean =>
    (isInput(element) && element.type === "password") ||
    (element.getAttribute("autocomplete") ?? "")
      .toLowerCase()
      .split(/\s+/)
      .some((token) => secretTokens.has(token));

  type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

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

  const shown = (element: Element): boolean =>
    element.checkVisibility({ opacityProperty: true, visibilityProperty: true });

  // Text in these says what a control is called, not what the page says around it.
  const unspoken =
    "button,select,textarea,option,script,style,noscript,template,[role=button],[role=menuitem],[role=option],[role=tab],[role=switch],[role=checkbox],[role=radio],[aria-hidden=true]";

  // Containers whose text usually describes the controls in them: a row, an item, a group or a form.
  const groups =
    "tr,li,article,fieldset,form,section,dialog,[role=row],[role=listitem],[role=group],[role=region],[role=dialog],[role=alertdialog]";

  /** The visible text just before (or after) a target within `scope`, nearest kept, ≤120 characters. */
  const textBeside = (target: Element, scope: Node, backwards: boolean): string => {
    const walker = target.ownerDocument.createTreeWalker(scope, NodeFilter.SHOW_TEXT);

    const labels =
      isInput(target) || isTextArea(target) || isSelect(target) || isButton(target)
        ? Array.from(target.labels ?? [])
        : [];

    let text = "";

    walker.currentNode = target;
    for (let steps = 0; steps < 400 && text.replace(/\s+/g, "").length < 120; steps++) {
      const node = backwards ? walker.previousNode() : walker.nextNode();

      if (node === null) break;
      const parent = node.parentElement;

      if (
        parent === null ||
        target.contains(parent) ||
        parent.closest(unspoken) !== null ||
        (isHtml(parent) && parent.isContentEditable) ||
        labels.some((label) => label.contains(parent)) ||
        !shown(parent)
      )
        continue;
      text = backwards ? `${node.textContent ?? ""} ${text}` : `${text} ${node.textContent ?? ""}`;
    }
    const words = text.replace(/\s+/g, " ").trim();

    return words.length <= 120
      ? words
      : backwards
        ? `…${words.slice(-119).trimStart()}`
        : `${words.slice(0, 119).trimEnd()}…`;
  };

  const dialogOf = (element: Element): Element | undefined => {
    for (let node: Element | null = element; node !== null; node = parentOf(node))
      if (node.tagName === "DIALOG" || /^(?:alert)?dialog$/.test(node.getAttribute("role") ?? ""))
        return node;

    return undefined;
  };

  /** The nearest visible heading before `target` in tree order, within `scope`. */
  const headingBefore = (target: Element, scope: Node): string | undefined => {
    const walker = target.ownerDocument.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT);

    walker.currentNode = target;
    for (let steps = 0; steps < 2000; steps++) {
      const node = walker.previousNode();

      if (node === null) break;
      if (isElement(node) && roleOf(node) === "heading" && shown(node)) {
        const text = clean(textOf(node), 120);

        if (text !== "") return text;
      }
    }

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

    const heading = headingBefore(element, inTree ?? top);

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

  const inspectInput = (element: Element, plan: InputPlan) => {
    const metadata = details(element, element, 0, 0);
    // Facts are about what the input activates, such as the submit button around a painted label.
    const control = activationTarget(element) ?? element;

    const form =
      isInput(control) || isButton(control) || isTextArea(control) || isSelect(control)
        ? control.form
        : null;

    // The chord's last key, which may be the plus key itself: Control++.
    const key = plan.keys === null ? undefined : /(?:^|\+)(\+|[^+]+)$/.exec(plan.keys)?.[1];
    const enter = key === "Enter";

    const activation =
      plan.action === "click" || (plan.action === "press" && (enter || key === "Space"));

    // Enter submits a form from any input but buttons, file and color pickers, including
    // checkboxes, radios and ranges.
    const fieldEnter =
      isInput(control) &&
      !["button", "reset", "submit", "image", "file", "color", "hidden"].includes(control.type) &&
      ((plan.action === "press" && enter) || (plan.action === "type" && plan.submit));

    const submits = form !== null && ((activation && isSubmitter(control)) || fieldEnter);

    const submitter = isSubmitter(control)
      ? control
      : form === null
        ? undefined
        : defaultSubmitter(form);

    const formDestination =
      form === null
        ? undefined
        : submitter?.hasAttribute("formaction") === true
          ? submitter.formAction
          : form.action;

    const formMethod =
      form === null
        ? undefined
        : submitter?.hasAttribute("formmethod") === true
          ? submitter.formMethod
          : form.method;

    const formTarget =
      form === null
        ? undefined
        : submitter?.hasAttribute("formtarget") === true
          ? submitter.formTarget
          : form.target;

    const link = linkOf(element);
    const href = link === undefined ? null : hrefAttribute(link);
    // A dialog form only closes its dialog; the page's script decides what that means.
    const sends = submits && formMethod !== "dialog";
    // Only activation follows a link or opens a file chooser; hovering or scrolling over a
    // control does neither.
    const destination = sends ? formDestination : activation ? metadata.href : undefined;
    const acts = plan.action !== "hover" && plan.action !== "scroll";

    // What the browser itself does on activation: follow a link, submit or reset a form, choose
    // a file or a value, toggle a box or a disclosure, or focus a field. Anything else is the
    // page's script.
    const builtIn =
      sends ||
      (href !== null && !/^\s*(?:#\s*|javascript:[^]*)$/i.test(href)) ||
      (isInput(control) && !["button", "submit", "image", "reset"].includes(control.type)) ||
      ((isInput(control) || isButton(control)) && control.type === "reset" && form !== null) ||
      control.tagName === "SUMMARY" ||
      control.closest("select") !== null ||
      textEntry(control);

    const facts: Array<Fact> = [];

    // Facts come from structure only. What a name or the text around it says is evidence for a
    // judge, never a fact: words change meaning with context and language.
    if (sends) facts.push("form-submit");
    if (activation && link?.hasAttribute("download") === true) facts.push("download");
    if (activation && isInput(control) && control.type === "file") facts.push("upload");
    if (
      (plan.action === "type" && isSecret(control)) ||
      (sends &&
        form !== null &&
        Array.from(form.elements).some(
          (field) => isField(field) && isSecret(field) && isFilled(field),
        ))
    )
      facts.push("secret");
    if (activation && !builtIn) facts.push("scripted");
    if (acts && (metadata.role === "canvas" || metadata.role === "iframe" || metadata.name === ""))
      facts.push("opaque");

    // Bind what decides the consequence and the control's identity. Names bind interactive
    // controls only: other text, such as a live price or a page's own text, may change freely.
    const role = metadata.role;

    const boundName =
      role !== null &&
      (interactiveRoles.has(role) || role === "canvas" || role === "iframe") &&
      !(isHtml(element) && element.isContentEditable)
        ? metadata.name
        : null;

    // Approval and prose eligibility share the same immutable inspection. A focus or scroll
    // handler changing these attributes must not leave an old permission behind.
    const fingerprint = JSON.stringify([
      purpose(control, form),
      proseEligible(control),
      element.tagName,
      element.id,
      role,
      boundName,
      metadata.href,
      control === element ? null : refFor(control),
      isInput(control) || isButton(control) ? control.type : control.tagName,
      control.matches(":disabled") || isDisabled(control),
      control.getAttribute("readonly"),
      control.getAttribute("aria-readonly"),
      isHtml(control) && control.isContentEditable,
      control.getAttribute("name"),
      control.getAttribute("accept"),
      control.hasAttribute("multiple"),
      link?.getAttribute("download"),
      form === null ? null : refFor(form),
      form === null ? null : boundUrl(form.action),
      form?.method,
      form?.target,
      submitter === undefined ? null : refFor(submitter),
      formDestination === undefined ? undefined : boundUrl(formDestination),
      formMethod,
      formTarget,
      submitter?.formNoValidate,
      form?.noValidate,
    ]);

    const inspected: InspectedTarget = {
      ref: refFor(element),
      element: metadata.element,
      role: metadata.role,
      name: metadata.name,
      cursor: metadata.cursor,
      ...(metadata.href === undefined ? {} : { href: metadata.href }),
      secret: isSecret(control),
      fingerprint,
    };

    return {
      inspected,
      facts,
      destination,
      explain: () => evidenceOf(element, form, formMethod, formDestination),
    };
  };

  // Approval preparation only reads the DOM. In particular, an offscreen ref must not scroll
  // before the policy has had a chance to deny it.
  const inspect = (
    plan: InputPlan,
  ): (Omit<PreparedInput, "evidence"> & { readonly explain: () => Evidence }) | InputFailure => {
    const targets: Array<InspectedTarget | null> = [];
    const facts = new Set<Fact>();
    let destination = plan.destination ?? undefined;
    let explain = (): Evidence => ({ title: clean(document.title, 120) });

    for (const [index, target] of plan.targets.entries()) {
      let element: Element | null | undefined;

      if (target === null) {
        element = activeElement();
      } else if (typeof target === "string") {
        element = lookup(target);
        if (element === undefined)
          return { error: "stale", detail: target + " is not on the page any more", index };
      } else {
        if (
          !Number.isFinite(target.x) ||
          !Number.isFinite(target.y) ||
          target.x < 0 ||
          target.y < 0 ||
          target.x >= window.innerWidth ||
          target.y >= window.innerHeight
        )
          return { error: "outside", detail: "the point is outside the viewport" };
        const hit = hitAt(document, target.x, target.y);

        element = hit === null ? null : controlOf(hit);
        if (element === null)
          return { error: "offscreen", detail: "nothing is painted at the point" };
      }

      if (element === null) {
        targets.push(null);
        continue;
      }
      if (!inCurrentDocument(element))
        return { error: "stale", detail: "the input target belongs to a replaced document", index };
      const refusal = plan.action === "type" ? typingRefusal(element, target !== null) : undefined;

      if (refusal !== undefined) return { error: "untypeable", detail: refusal };
      const inspected = inspectInput(element, plan);

      if (index === 0) explain = inspected.explain;
      targets.push(inspected.inspected);
      for (const fact of inspected.facts) facts.add(fact);
      destination ??= inspected.destination;
      if (inspected.destination !== undefined) {
        try {
          if (new URL(inspected.destination, location.href).origin !== location.origin)
            facts.add("cross-origin");
        } catch {
          return { error: "outside", detail: "the input destination is not a valid URL" };
        }
      }
    }

    if (destination !== undefined) {
      try {
        destination = new URL(destination, location.href).href;
        if (new URL(destination).origin !== location.origin) facts.add("cross-origin");
      } catch {
        return { error: "outside", detail: "the input destination is not a valid URL" };
      }
    }

    return {
      url: boundUrl(location.href),
      targets,
      facts: [...facts],
      ...(destination === undefined ? {} : { destination }),
      explain,
    };
  };

  // Evidence is read once, for the policy. Validation binds the facts and the targets, not the
  // text around them, which live pages change freely.
  const prepareInput = (plan: InputPlan): PreparedInputResult => {
    const inspected = inspect(plan);

    if ("error" in inspected) return inspected;
    const { explain, ...prepared } = inspected;

    return { ...prepared, evidence: explain() };
  };

  const validate = (
    plan: InputPlan,
    prepared: PreparedInput,
    options: ValidationOptions,
  ): ValidatedInputResult => {
    const current = inspect(plan);

    if ("error" in current)
      return current.error === "stale" ? current : { error: "changed", detail: current.detail };
    if (
      current.url !== prepared.url ||
      (current.destination === undefined || prepared.destination === undefined
        ? current.destination !== prepared.destination
        : boundUrl(current.destination) !== boundUrl(prepared.destination)) ||
      JSON.stringify(current.facts) !== JSON.stringify(prepared.facts) ||
      current.targets.length !== prepared.targets.length ||
      current.targets.some((target, index) => {
        const previous = prepared.targets[index];

        return target === null
          ? previous !== null
          : previous === null ||
              previous === undefined ||
              target.ref !== previous.ref ||
              target.fingerprint !== previous.fingerprint;
      })
    )
      return {
        error: "changed",
        detail: "the page or input target changed while the policy was deciding",
      };

    if (options.focused === true) {
      const active = activeElement();
      const expected = prepared.targets[0];

      if (
        active === null ||
        expected === null ||
        expected === undefined ||
        refFor(active) !== expected.ref
      )
        return { error: "changed", detail: "focus moved away from the approved element" };
    }

    for (const press of options.presses ?? []) {
      const expected = prepared.targets[press.index];

      const element =
        expected === null || expected === undefined ? undefined : lookup(expected.ref);

      const hit = hitAt(document, press.x, press.y);

      if (element === undefined || hit === null || !receives(element, hit))
        return {
          error: "changed",
          detail: `the approved target is no longer under the pointer at (${press.x}, ${press.y})`,
        };

      const nested = nestedControl(element, hit);

      if (nested !== undefined)
        return {
          error: "changed",
          detail: `${describe(nested)} inside the approved target would receive the press at (${press.x}, ${press.y})`,
        };
    }

    return { ok: true };
  };

  // Chromium delivers pointer moves with the next frame. A press check waits until the frame
  // after it, so it sees what the page did when the pointer arrived, such as a menu opened over
  // the target. A hidden document draws no frames, and its moves wait for the press instead.
  const validateInput = (
    plan: InputPlan,
    prepared: PreparedInput,
    options: ValidationOptions = {},
  ): ValidatedInputResult | Promise<ValidatedInputResult> => {
    if ((options.presses ?? []).length === 0) return validate(plan, prepared, options);
    const { promise, resolve } = Promise.withResolvers<void>();

    if (document.visibilityState === "hidden") resolve();
    else requestAnimationFrame(() => requestAnimationFrame(() => resolve()));

    return promise.then(() => validate(plan, prepared, options));
  };

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

  const hasText = (text: string): boolean =>
    (document.body?.innerText ?? "").toLowerCase().includes(text.toLowerCase());

  const api: PageApi = {
    version: 5,
    snapshot,
    point,
    scrollPlan,
    viewport: () => ({ width: window.innerWidth, height: window.innerHeight }),
    prepareInput,
    validateInput,
    typeable,
    focus,
    checkText,
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

const ResolvedPointSchema = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
  element: Schema.String,
  tag: Schema.String,
  role: Schema.NullOr(Schema.String),
  name: Schema.String,
  cursor: Schema.String,
  href: Schema.optional(Schema.String),
});

export const PointResultSchema = Schema.Union([
  ResolvedPointSchema,
  Schema.Struct({
    error: Schema.Literals(["stale", "hidden", "offscreen", "disabled", "covered", "outside"]),
    detail: Schema.String,
  }),
]);

const InputPreparationError = Schema.Struct({
  error: Schema.String,
  detail: Schema.String,
  index: Schema.optional(Schema.Finite),
});

export const FormFieldSchema = Schema.Struct({
  type: Schema.String,
  name: Schema.String,
  autocomplete: Schema.optional(Schema.String),
  filled: Schema.Boolean,
});

const EvidenceSchema = Schema.Struct({
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

export const PreparedInputResultSchema = Schema.Union([
  Schema.Struct({
    url: Schema.String,
    targets: Schema.Array(
      Schema.NullOr(
        Schema.Struct({
          ref: Schema.String,
          element: Schema.String,
          role: Schema.NullOr(Schema.String),
          name: Schema.String,
          cursor: Schema.String,
          href: Schema.optional(Schema.String),
          secret: Schema.Boolean,
          fingerprint: Schema.String,
        }),
      ),
    ),
    facts: Schema.Array(Fact),
    destination: Schema.optional(Schema.String),
    evidence: EvidenceSchema,
  }),
  InputPreparationError,
]);

export const ValidatedInputResultSchema = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true) }),
  InputPreparationError,
]);

export const ScrollPlanSchema = Schema.NullOr(
  Schema.Struct({
    x: Schema.Finite,
    y: Schema.Finite,
    dx: Schema.Finite,
    dy: Schema.Finite,
  }),
);

export const ViewportResultSchema = Schema.Struct({
  width: Schema.Finite,
  height: Schema.Finite,
});

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
