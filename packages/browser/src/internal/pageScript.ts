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

export type ChangeKind = "text" | "appeared" | "disappeared" | "brief" | "value" | "title";

export interface ChangeContext {
  readonly row: string | null;
  readonly column: string | null;
  readonly beside: string | null;
  readonly heading: string | null;
}

/** One element's changes over a read's window, timed on the page's epoch clock. */
export interface ChangeRecord {
  readonly at: number;
  readonly startedAt: number;
  readonly kind: ChangeKind;
  readonly role: string | null;
  readonly name: string;
  readonly tag: string;
  readonly context: ChangeContext;
  readonly before: string | null;
  readonly after: string | null;
  readonly count: number;
  readonly earlier: number | null;
}

export interface ChangesResult {
  readonly now: number;
  /** Where the window ended: its `until`, or now if that is later. */
  readonly until: number;
  /** Where the record is whole: when it started, or a minute ago. */
  readonly from: number;
  /** Changes in the window the record did not keep. */
  readonly truncated: number;
  readonly records: ReadonlyArray<ChangeRecord>;
}

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
  changes(since: number | null, until: number | null): ChangesResult;
}

declare global {
  // The API this script installs, which exists only inside the library's isolated world.
  var __effectBrowser: PageApi | undefined;
}

export const install = (): PageApi => {
  const installed = globalThis.__effectBrowser;

  if (installed !== undefined && installed.version === 7) return installed;

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

  // What visibly changed, kept per element, so a read can say what each one said at any time in the
  // last minute. The record starts with a document's first read, so a page that is never asked pays
  // nothing, and stops once nobody has read it for two minutes. While it runs, the observer notes
  // only the words of what changed, which a text change hands over almost free. Whether a change
  // was in view comes from an IntersectionObserver as the page renders, so it is judged when the
  // change happened and forces no layout. Context, which takes a walk of the page, is read only for
  // what a read returns. Changes inside frames, shadow roots and SVG, a reveal by CSS alone, and
  // anything drawn rather than written, such as a canvas, are not seen.
  const epoch = () => performance.timeOrigin + performance.now();

  /** An element's words, or `null` while it is not on the page; a field's `null` is unknown. */
  type State = string | null;

  interface Sample {
    readonly track: Track;
    readonly at: number;
    readonly state: State;
    /** Whether it was in view when it changed; unknown until the page next renders. */
    seen: boolean | undefined;
  }

  interface Track {
    node: Node;
    readonly kind: "content" | "value" | "title";
    /** Where a removed element was, which gives its context. */
    place: Element | null;
    /** What it said before its oldest kept sample, known since `known`. */
    initial: State;
    known: number;
    readonly samples: Array<Sample>;
  }

  // A busy page is kept to these bounds. An element that changed often gives way first to one the
  // record has not seen change, then one never in view, then one that has gone, so news is kept on
  // a page that never rests. Whatever gives way or is never kept is counted, never silently lost.
  const maxTracks = 256;
  const maxSamples = 32;
  const retention = 60_000;
  const tracks = new Map<Node, Track>();
  const busy = new Set<Track>();
  const blind = new Set<Track>();
  const gone = new Set<Track>();
  let refused = new WeakSet<Node>();
  let leaves = new WeakSet<Element>();
  const lost: Array<number> = [];
  let losses = 0;
  let started: number | undefined;
  let lastRead = 0;
  let title = "";

  const forget = (at: number, count = 1) => {
    for (let index = 0; index < Math.min(count, 1024); index++) lost[losses++ % 1024] = at;
  };

  // Whether each observed element is in view, as the page last rendered it.
  let visible = new WeakMap<Element, boolean>();
  const waiting = new Map<Element, Array<Sample>>();

  const unobserve = (element: Element) => {
    sight.unobserve(element);
    visible.delete(element);
  };

  const settle = (sample: Sample, seen: boolean) => {
    if (sample.seen !== undefined) return;
    sample.seen = seen;
    if (seen) blind.delete(sample.track);
    else if (sample.track.samples.every((each) => each.seen === false)) blind.add(sample.track);
  };

  const sight = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      visible.set(entry.target, entry.isIntersecting);
      const seen = entry.isIntersecting && shown(entry.target);

      for (const sample of waiting.get(entry.target) ?? []) settle(sample, seen);
      waiting.delete(entry.target);
      if (!tracks.has(entry.target)) unobserve(entry.target);
    }
  });

  /** Note whether `element` is in view for `sample`: now if it is watched, else when it renders. */
  const look = (element: Element, sample: Sample) => {
    const known = visible.get(element);

    // In view means in the viewport, and neither transparent nor hidden by `visibility`.
    if (known !== undefined && tracks.has(element)) {
      settle(sample, known && shown(element));

      return;
    }
    sight.observe(element);
    const list = waiting.get(element);

    if (list === undefined) waiting.set(element, [sample]);
    else list.push(sample);
  };

  const drop = (track: Track) => {
    tracks.delete(track.node);
    busy.delete(track);
    blind.delete(track);
    gone.delete(track);
    if (isElement(track.node)) unobserve(track.node);
  };

  /** A new state for a track. A removed element's place is in view if what took it is. */
  const sample = (track: Track, at: number, state: State, near: Element | null = null) => {
    // One batch of mutations counts once, as it left the element: a move is no change.
    if (track.samples.at(-1)?.at === at) track.samples.pop();
    const last = track.samples.at(-1);
    const previous = last === undefined ? track.initial : last.state;

    if (track.kind === "content" && state === null) gone.add(track);
    else gone.delete(track);
    if (previous === state) {
      if (track.samples.length === 0) drop(track);

      return;
    }
    if (track.samples.length >= maxSamples) {
      const oldest = track.samples.shift();

      if (oldest !== undefined) {
        track.initial = oldest.state;
        track.known = oldest.at;
        forget(oldest.at);
      }
    }
    const next: Sample = { track, at, state, seen: track.kind === "title" ? true : undefined };

    track.samples.push(next);
    if (track.samples.length >= 4) busy.add(track);
    if (track.kind === "title" || !isElement(track.node)) return;
    const node = track.node;
    // Only an element the record watched before it went has a known place on the page.
    const before = track.samples.length > 1 ? visible.get(node) : undefined;

    if (state !== null) look(node, next);
    else if (before !== undefined) settle(next, before);
    else if (near !== null) look(near, next);
    else if (node.isConnected && track.place !== null) look(track.place, next);
    else settle(next, false);
  };

  /**
   * Note what `node` says now. On its first change, `before` says what it said before, or
   * `undefined` when it is not worth keeping; a full record keeps it only in place of one that
   * changed often or has gone.
   */
  const record = (
    node: Node,
    kind: Track["kind"],
    at: number,
    state: State,
    before: () => State | undefined,
    place: Element | null = null,
    near: Element | null = null,
  ) => {
    let track = tracks.get(node);

    if (track === undefined) {
      // A title or a field the user changed is always kept.
      const victim =
        tracks.size < maxTracks || kind !== "content"
          ? undefined
          : refused.has(node)
            ? null
            : (busy.values().next().value ??
              blind.values().next().value ??
              gone.values().next().value ??
              null);

      if (victim === null) {
        refused.add(node);
        forget(at);

        return;
      }
      const initial = before();

      if (initial === undefined || initial === state) return;
      if (victim !== undefined) {
        drop(victim);
        refused.add(victim.node);
        for (const old of victim.samples) forget(old.at);
      }
      track = {
        node,
        kind,
        place,
        initial,
        known: refused.has(node) ? at : Number.NEGATIVE_INFINITY,
        samples: [],
      };
      tracks.set(node, track);
    }
    if (place !== null) track.place = place;
    sample(track, at, state, near);
  };

  const inlineTags = new Set([
    "A",
    "ABBR",
    "B",
    "CODE",
    "EM",
    "I",
    "LABEL",
    "MARK",
    "S",
    "SMALL",
    "SPAN",
    "STRONG",
    "SUB",
    "SUP",
    "TIME",
    "U",
  ]);

  const unwritten = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "svg"]);

  /** How a batch of mutations can be undone in reading, to recover what the page said before it. */
  interface Undo {
    readonly data: Map<Node, string>;
    readonly added: Set<Node>;
    readonly removed: Map<Node, Array<{ readonly next: Node | null; readonly nodes: Array<Node> }>>;
  }

  const undoOf = (mutations: ReadonlyArray<MutationRecord>): Undo => {
    const undo: Undo = { data: new Map(), added: new Set(), removed: new Map() };

    for (const mutation of mutations) {
      if (mutation.type === "attributes") continue;
      if (mutation.type === "characterData") {
        if (!undo.data.has(mutation.target))
          undo.data.set(mutation.target, mutation.oldValue ?? "");
        continue;
      }

      const removed = Array.from(mutation.removedNodes).filter((node) => {
        if (!undo.added.has(node)) return true;
        undo.added.delete(node);

        return false;
      });

      if (removed.length > 0) {
        const earlier = undo.removed.get(mutation.target) ?? [];

        earlier.push({ next: mutation.nextSibling, nodes: removed });
        undo.removed.set(mutation.target, earlier);
      }
      for (const node of Array.from(mutation.addedNodes)) undo.added.add(node);
    }

    return undo;
  };

  /** A node's words, or with an undo, its words before that batch of mutations. */
  const wordsOf = (node: Node, undo?: Undo): string => {
    if (node.nodeType === Node.TEXT_NODE) return undo?.data.get(node) ?? node.nodeValue ?? "";
    if (!isElement(node)) return "";
    const tag = node.tagName;

    if (unwritten.has(tag)) return "";
    const gap = inlineTags.has(tag) ? "" : " ";
    const removed = undo?.removed.get(node);
    let text = gap;

    for (let child = node.firstChild; ; child = child.nextSibling) {
      if (removed !== undefined)
        for (const group of removed)
          if (group.next === child) for (const gone of group.nodes) text += wordsOf(gone, undo);
      if (child === null) break;
      if (undo?.added.has(child) !== true) text += wordsOf(child, undo);
    }

    return text + gap;
  };

  /** An element's words now; most changed elements hold only text, which is read whole. */
  const wordsNow = (element: Element): string =>
    clean(
      unwritten.has(element.tagName)
        ? ""
        : element.childElementCount === 0
          ? element.textContent
          : wordsOf(element),
      600,
    );

  /** A change shorter than 160 characters as it is, else the part that differs, with some context. */
  const excerpt = (before: string, after: string): [string, string] => {
    if (before.length <= 160 && after.length <= 160) return [before, after];
    let start = 0;

    while (start < before.length && before[start] === after[start]) start++;
    let end = 0;

    while (
      end < before.length - start &&
      end < after.length - start &&
      before[before.length - 1 - end] === after[after.length - 1 - end]
    )
      end++;

    const cut = (text: string) => {
      const from = Math.max(0, start - 40);
      const to = Math.min(text.length, text.length - end + 40);
      const middle = text.slice(from, to);

      return clean(`${from > 0 ? "…" : ""}${middle}${to < text.length ? "…" : ""}`);
    };

    return [cut(before), cut(after)];
  };

  const inView = (element: Element): boolean => {
    if (!element.isConnected || !shown(element)) return false;
    const rect = element.getBoundingClientRect();

    return (
      (rect.width > 0 || rect.height > 0) &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth
    );
  };

  const unseen = new WeakMap<Element, boolean>();

  /** Whether the page shows what is in an element, as far as words go; asked once per element. */
  const watched = (element: Element): boolean => {
    let hidden = unseen.get(element);

    if (hidden === undefined) {
      hidden = element.closest("head,svg,script,style,noscript,template") !== null;
      unseen.set(element, hidden);
    }

    return !hidden;
  };

  const noContext: ChangeContext = { row: null, column: null, beside: null, heading: null };

  /**
   * Words beside an element that say what it is: its table row and column, or the words before it
   * and the heading above it. `headers` keeps each table's header row for one read.
   */
  const contextOf = (element: Element, headers: Map<Element, Element | null>): ChangeContext => {
    const cell = element.closest("td,th,[role=cell],[role=gridcell]");
    const row = cell?.closest("tr,[role=row]") ?? null;

    if (cell !== null && cell !== undefined && row !== null) {
      const cells = Array.from(row.children);
      const index = cells.indexOf(cell);
      const first = cells[0];
      const table = row.closest("table,[role=table],[role=grid]");
      let header = table === null ? null : headers.get(table);

      if (header === undefined && table !== null) {
        header = table.querySelector(
          "thead tr, tr:has(> th), [role=row]:has(> [role=columnheader])",
        );
        headers.set(table, header);
      }

      const column =
        header === null || header === undefined || header === row
          ? undefined
          : header.children[index];

      const rowName = first === undefined || first === cell ? "" : clean(textOf(first), 60);
      const columnName = column === undefined ? "" : clean(textOf(column), 60);

      if (rowName !== "" || columnName !== "")
        return {
          ...noContext,
          row: rowName === "" ? null : rowName,
          column: columnName === "" ? null : columnName,
        };
    }

    // Words just before it in its own row, item or block, such as a label; never the whole page.
    const parent = element.parentElement;

    const scope =
      element.closest(groups) ??
      (parent === null || parent === element.ownerDocument.body || parent.tagName === "HTML"
        ? undefined
        : parent);

    const beside = scope === undefined ? "" : textBeside(element, scope, true);
    const near = beside.length > 40 ? `…${beside.slice(-39).trimStart()}` : beside;

    return {
      ...noContext,
      beside: near === "" ? null : near,
      heading:
        roleOf(element) === "heading"
          ? null
          : (headingBefore(element, element.ownerDocument) ?? null),
    };
  };

  const secrets = new WeakSet<Element>();

  const valueText = (element: Element): string | null => {
    if (isInput(element)) {
      if (element.type === "checkbox" || element.type === "radio")
        return element.checked ? "checked" : "not checked";
      if (["button", "submit", "reset", "image", "hidden"].includes(element.type)) return null;
      if (element.type === "file") return `${element.files?.length ?? 0} file(s) chosen`;
    }
    if (!isInput(element) && !isTextArea(element) && !isSelect(element)) return null;
    // A field once secret stays masked, such as a password its page lets the user reveal.
    if (isSecret(element)) secrets.add(element);
    if (secrets.has(element)) return element.value === "" ? "" : "••••";
    if (isSelect(element))
      return clean(Array.from(element.selectedOptions, (option) => option.text).join(", "));

    return clean(element.value);
  };

  /** Whether an element takes up room in the flow, judged by its inline style once removed. */
  const inFlow = (element: Element): boolean => {
    const position = element.isConnected
      ? getComputedStyle(element).position
      : isHtml(element)
        ? element.style.position
        : "";

    return position !== "absolute" && position !== "fixed";
  };

  /** The first element from `node` on, the sibling that follows a removed node. */
  const neighbour = (node: Node | null): Element | null =>
    node === null || isElement(node)
      ? node
      : node instanceof CharacterData
        ? node.nextElementSibling
        : null;

  const noElements: ReadonlyArray<Element> = [];

  // One mutation that adds or removes more elements than this, such as a list rebuilt wholesale,
  // is followed for its first ones and the rest are counted.
  const maxNodes = 64;

  /** The elements among added or removed nodes; text among them makes `target` an owner. */
  const elementsOf = (
    nodes: NodeList,
    target: Element,
    owners: Set<Element>,
  ): ReadonlyArray<Element> => {
    let elements: Array<Element> | undefined;

    for (let index = 0; index < Math.min(nodes.length, maxNodes); index++) {
      const node = nodes.item(index);

      if (node === null) continue;
      if (isElement(node)) (elements ??= []).push(node);
      else if (
        node.nodeType === Node.TEXT_NODE &&
        !owners.has(target) &&
        (tracks.has(target) || refused.has(target) || /\S/.test(node.nodeValue ?? ""))
      )
        owners.add(target);
    }

    return elements ?? noElements;
  };

  const observer = new MutationObserver((mutations) => {
    const at = epoch();

    if (at - lastRead > 120_000) {
      stop();

      return;
    }
    const owners = new Set<Element>();
    const parents = new Set<Element>();
    const arrivals = new Set<Node>();
    let byTarget: Map<Node | null, Array<MutationRecord>> | undefined;
    let undo: Undo | undefined;

    // What an element said before this batch, unless it arrived in it, so its arrival tells it.
    // An element of text alone, such as a cell, is undone from its own mutations, else from all.
    const earlier = (element: Element) => () => {
      for (let up: Element | null = element; up !== null; up = up.parentElement)
        if (arrivals.has(up)) return undefined;
      if (element.childElementCount > 0) undo ??= undoOf(mutations);
      byTarget ??= Map.groupBy(mutations, (mutation) =>
        mutation.type === "characterData" ? mutation.target.parentNode : mutation.target,
      );

      return clean(wordsOf(element, undo ?? undoOf(byTarget.get(element) ?? [])), 600);
    };

    for (const mutation of mutations) {
      const target = mutation.target;

      if (mutation.type === "characterData") {
        if (target.parentElement !== null) owners.add(target.parentElement);
        continue;
      }
      if (!isElement(target)) continue;
      if (mutation.type === "attributes") {
        const attribute = mutation.attributeName;

        if (attribute === null || (mutation.oldValue !== null) === target.hasAttribute(attribute))
          continue;

        // A dialog or details element opens; anything else shows when it loses `hidden`.
        const showing =
          attribute === "open" ? target.hasAttribute("open") : !target.hasAttribute("hidden");

        const words = wordsNow(target);

        if (words !== "" && watched(target))
          record(
            target,
            "content",
            at,
            showing ? words : null,
            () => (showing ? null : words),
            target.parentElement,
          );
        continue;
      }

      // An element that held only text before this batch and after it, such as a ticking cell, had
      // only its text changed, which needs none of its nodes read: each costs this world a wrapper.
      if (leaves.has(target) && target.childElementCount === 0) {
        owners.add(target);
        continue;
      }
      parents.add(target);
      const arrived = elementsOf(mutation.addedNodes, target, owners);
      const left = elementsOf(mutation.removedNodes, target, owners);

      for (const node of arrived) arrivals.add(node);
      forget(at, Math.max(mutation.addedNodes.length, mutation.removedNodes.length) - maxNodes);
      if (arrived.length + left.length === 0 || !watched(target)) continue;

      // What took another's place in one step, such as a re-rendered price, changed its words.
      const replaced = Math.min(arrived.length, left.length);

      for (let index = 0; index < arrived.length; index++) {
        const node = arrived[index];
        const old = index < replaced ? left[index] : undefined;

        if (node === undefined) continue;
        const track = old === undefined ? undefined : tracks.get(old);

        if (track !== undefined && old !== undefined) {
          tracks.delete(old);
          unobserve(old);
          track.node = node;
          tracks.set(node, track);
          sample(track, at, wordsNow(node));
        } else if (old !== undefined && refused.has(old)) {
          refused.add(node);
          forget(at);
        } else {
          const words = wordsNow(node);

          if (words !== "" || old !== undefined)
            record(node, "content", at, words, () => (old === undefined ? null : wordsNow(old)));
        }
      }

      for (const node of left.slice(replaced)) {
        const words = wordsNow(node);
        const next = neighbour(mutation.nextSibling);
        // What moves up into a removed element's place in the flow shows where it was. Out of the
        // flow, or with nothing after it, its place is unknown, and it is not told.
        const near = next !== null && inFlow(node) && inFlow(next) ? next : null;

        if (words !== "" || tracks.has(node))
          record(node, "content", at, null, () => words, target, near);
      }
    }

    for (const owner of owners)
      if (owner.isConnected && owner !== document.body && watched(owner))
        record(owner, "content", at, wordsNow(owner), earlier(owner));
    for (const parent of parents)
      if (parent.childElementCount === 0) leaves.add(parent);
      else leaves.delete(parent);

    if (document.title !== title) {
      const before = title;

      title = document.title;
      record(document, "title", at, clean(title, 200), () => clean(before, 200));
    }
  });

  // Typing changes a field's value, not the page's text, so fields report their own values.
  const fieldOf = (event: Event): Element | undefined => {
    const target = event.composedPath()[0];

    return target instanceof Node && isElement(target) ? target : undefined;
  };

  const focusedValues = new WeakMap<Element, string>();

  const onFocus = (event: Event) => {
    const field = fieldOf(event);
    const value = field === undefined ? null : valueText(field);

    if (field !== undefined && value !== null) focusedValues.set(field, value);
  };

  const onValue = (event: Event) => {
    const field = fieldOf(event);
    const value = field === undefined ? null : valueText(field);

    if (field !== undefined && value !== null)
      record(field, "value", epoch(), value, () => focusedValues.get(field) ?? null);
  };

  const start = () => {
    observer.observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
      characterDataOldValue: true,
      attributeFilter: ["hidden", "open"],
      attributeOldValue: true,
    });
    document.addEventListener("focusin", onFocus, true);
    document.addEventListener("input", onValue, true);
    document.addEventListener("change", onValue, true);
    title = document.title;
    started = epoch();
  };

  const stop = () => {
    observer.disconnect();
    sight.disconnect();
    // A new record starts afresh: it owes nothing to what the last one could not keep.
    visible = new WeakMap();
    refused = new WeakSet();
    leaves = new WeakSet();
    lost.length = 0;
    losses = 0;
    document.removeEventListener("focusin", onFocus, true);
    document.removeEventListener("input", onValue, true);
    document.removeEventListener("change", onValue, true);
    tracks.clear();
    busy.clear();
    blind.clear();
    gone.clear();
    waiting.clear();
    started = undefined;
  };

  /** One element's changes after `since`, up to `until`, if it changed in view in between. */
  const fold = (
    track: Track,
    since: number,
    until: number,
    headers: Map<Element, Element | null>,
  ): ChangeRecord | undefined => {
    const changed = track.samples.filter((sample) => sample.at > since && sample.at <= until);
    const first = changed[0];
    const last = changed.at(-1);

    if (
      first === undefined ||
      last === undefined ||
      !changed.some((sample) => sample.seen === true)
    )
      return undefined;
    const prior = track.samples.findLast((sample) => sample.at <= since);

    // What it said at `since`; `undefined` when the record let that go.
    const start =
      prior === undefined ? (track.known <= since ? track.initial : undefined) : prior.state;

    const words = [start, ...changed.map((sample) => sample.state)].filter(
      (state): state is string => typeof state === "string",
    );

    const [kind, before, after]: [ChangeKind, string | null, string | null] =
      track.kind !== "content"
        ? [track.kind, start ?? null, last.state]
        : last.state !== null
          ? [start === null ? "appeared" : "text", start ?? null, last.state]
          : start === null
            ? ["brief", null, words.at(-1) ?? null]
            : ["disappeared", words.at(-1) ?? null, null];

    const [shownBefore, shownAfter] =
      before === null || after === null ? [before, after] : excerpt(before, after);

    const node = track.node;
    const element = isElement(node) ? node : null;
    const role = element === null ? null : roleOf(element);
    const where = element?.isConnected === true ? element : track.place;

    return {
      at: last.at,
      startedAt: first.at,
      kind,
      role,
      // An element's own words are what changed, not its name.
      name: element === null || role === null || role === "heading" ? "" : nameOf(element, role),
      tag: element === null ? "title" : element.tagName.toLowerCase(),
      context: kind === "value" || where === null ? noContext : contextOf(where, headers),
      before: shownBefore === null ? null : clean(shownBefore, 200),
      after: shownAfter === null ? null : clean(shownAfter, 200),
      count: changed.length,
      earlier: prior?.at ?? null,
    };
  };

  /** What changed after `since`, up to `until`, page epoch times, oldest first. */
  const changes = (since: number | null, until: number | null): ChangesResult => {
    const now = epoch();

    lastRead = now;
    if (started === undefined) {
      start();

      return { now, until: now, from: now, truncated: 0, records: [] };
    }
    for (const track of tracks.values())
      if ((track.samples.at(-1)?.at ?? now) < now - retention) drop(track);
    // A page that has not rendered since, such as a hidden tab, is judged as it stands.
    for (const [element, samples] of waiting) {
      const seen = inView(element);

      for (const pending of samples) settle(pending, seen);
    }
    waiting.clear();

    const after = since ?? Number.NEGATIVE_INFINITY;
    // A window cannot end later than now: what changes after it belongs to the next read.
    const upTo = Math.min(until ?? now, now);
    const headers = new Map<Element, Element | null>();
    const records: Array<ChangeRecord> = [];

    for (const track of tracks.values()) {
      const folded = fold(track, after, upTo, headers);

      if (folded !== undefined) records.push(folded);
    }

    return {
      now,
      until: upTo,
      from: Math.max(started, now - retention),
      truncated: lost.filter((at) => at > after && at <= upTo).length,
      records: records.toSorted((left, right) => left.startedAt - right.startedAt),
    };
  };

  const api: PageApi = {
    version: 7,
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
    changes,
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

const ChangeRecordSchema = Schema.Struct({
  at: Schema.Finite,
  startedAt: Schema.Finite,
  kind: Schema.Literals(["text", "appeared", "disappeared", "brief", "value", "title"]),
  role: Schema.NullOr(Schema.String),
  name: Schema.String,
  tag: Schema.String,
  context: Schema.Struct({
    row: Schema.NullOr(Schema.String),
    column: Schema.NullOr(Schema.String),
    beside: Schema.NullOr(Schema.String),
    heading: Schema.NullOr(Schema.String),
  }),
  before: Schema.NullOr(Schema.String),
  after: Schema.NullOr(Schema.String),
  count: Schema.Int.check(Schema.isGreaterThan(0)),
  earlier: Schema.NullOr(Schema.Finite),
});

export const ChangesResultSchema = Schema.Struct({
  now: Schema.Finite,
  until: Schema.Finite,
  from: Schema.Finite,
  truncated: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  records: Schema.Array(ChangeRecordSchema),
});

export const EditResultSchema = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), detail: Schema.String }),
  EditFailure,
]);
