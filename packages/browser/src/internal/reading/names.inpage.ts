/**
 * In the page: the foundation the other parts build on. It gives elements refs and reads the
 * roles, names and states that the outline and the input checks report.
 *
 * Every `*.inpage.ts` part runs inside the page. The page receives it as source text, so it must
 * stay self-contained: it uses only its parameters, the DOM and what it defines itself.
 */

export const names = () => {
  const byElement = new WeakMap<Element, string>();
  const byRef = new Map<string, WeakRef<Element>>();
  const refs = { next: 1 };

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

  // Elements of a same-origin frame come from another realm, so tag names decide, not instanceof.
  const isInput = (element: Element): element is HTMLInputElement => element.tagName === "INPUT";

  const isTextArea = (element: Element): element is HTMLTextAreaElement =>
    element.tagName === "TEXTAREA";

  const isSelect = (element: Element): element is HTMLSelectElement => element.tagName === "SELECT";
  const isFrame = (element: Element): element is HTMLIFrameElement => element.tagName === "IFRAME";
  const isHtml = (element: Element): element is HTMLElement => "innerText" in element;

  const isButton = (element: Element): element is HTMLButtonElement => element.tagName === "BUTTON";

  const isLabel = (element: Element): element is HTMLLabelElement => element.tagName === "LABEL";

  const textOf = (element: Element): string =>
    isHtml(element) ? element.innerText : (element.textContent ?? "");

  const isElement = (node: Node): node is Element => node.nodeType === Node.ELEMENT_NODE;
  const isDocument = (node: Node): node is Document => node.nodeType === Node.DOCUMENT_NODE;

  // Controls whose text is a value or a choice, not words of a label around them.
  const valueRoles = new Set([
    "combobox",
    "listbox",
    "option",
    "textbox",
    "searchbox",
    "spinbutton",
    "slider",
  ]);

  /**
   * A label's own words, without the options or values of the controls inside it, native or
   * scripted, such as the custom select Browserbase puts in place of a native one.
   */
  const labelText = (label: Element): string => {
    let text = "";

    const collect = (node: Node): void => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === Node.TEXT_NODE) text += child.textContent ?? "";
        else if (
          isElement(child) &&
          !["SELECT", "TEXTAREA", "INPUT", "SCRIPT", "STYLE"].includes(child.tagName) &&
          !valueRoles.has(roleOf(child) ?? "")
        )
          collect(child);
      }
    };

    collect(label);

    return text;
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
        .map((id) => {
          const labelling = element.ownerDocument.getElementById(id);

          return labelling === null ? "" : labelText(labelling);
        })
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

  const isDisabled = (element: Element): boolean =>
    ("disabled" in element && element.disabled === true) ||
    element.getAttribute("aria-disabled") === "true";

  const refFor = (element: Element): string => {
    const known = byElement.get(element);

    if (known !== undefined && byRef.get(known)?.deref() === element) return known;
    const ref = `e${refs.next++}`;

    byElement.set(element, ref);
    byRef.set(ref, new WeakRef(element));

    return ref;
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

  return {
    activeElement,
    clean,
    containers,
    describe,
    inCurrentDocument,
    interactiveRoles,
    isButton,
    isDisabled,
    isDocument,
    isElement,
    isFrame,
    isHtml,
    isInput,
    isLabel,
    isRoot,
    isSecret,
    isSelect,
    isTextArea,
    lookup,
    nameOf,
    parentOf,
    refFor,
    refs,
    roleOf,
    textOf,
  };
};

export type Names = ReturnType<typeof names>;
