import { Schema } from "effect";

import { ControlFacts, ObservedControl } from "../../BrowserData.ts";

const ControlIndex = Schema.Natural.check(Schema.isLessThanOrEqualTo(63));

/**
 * What the page reader returns. It is decoded on the host, so a page that tampers with its own
 * prototypes can make a read fail but cannot make it return something unbounded or untyped.
 */
export const PageReadResult = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(131072)),
  textTruncated: Schema.Boolean,
  controlsTruncated: Schema.Boolean,
  controls: Schema.Array(ControlFacts).check(Schema.isMaxLength(64)),
  /** Private selection identity, separate from every public control-facts projection. */
  selects: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        index: ControlIndex,
        optionsTruncated: Schema.Boolean,
        options: Schema.Array(
          Schema.Struct({
            index: ControlIndex,
            value: Schema.String.check(Schema.isMaxLength(65536)),
          }),
        ).check(Schema.isMaxLength(64)),
      }),
    ).check(
      Schema.isMaxLength(64),
      Schema.makeFilter(
        (selects) => selects.reduce((size, select) => size + select.options.length, 0) <= 64,
      ),
    ),
  ),
  viewport: Schema.Struct({
    width: Schema.Finite,
    height: Schema.Finite,
    clippedText: Schema.Natural,
    coveredText: Schema.Natural,
    uncertainText: Schema.Natural,
    unreachableControls: Schema.Natural,
    exhausted: Schema.Boolean,
  }),
});

export type PageReadResult = typeof PageReadResult.Type;

export interface PageReadRequest {
  readonly scope: "document" | "viewport";
  readonly maximumBytes: number;
  readonly controlLimit: number;
  /** Bounds the traversal itself, not just what is returned from it. */
  readonly nodeBudget: number;
  /** When set, only this exact node's facts are read and nothing is traversed. */
  readonly only?: Element;
  /** Action observations issue a visible select's choices even while its dropdown is closed. */
  readonly choices?: boolean;
  /**
   * Case-insensitive text a reading keeps, applied before any limit: text lines and controls
   * whose label contains it. A select is kept through its own label or any option label, and an
   * option only beside the select it belongs to.
   */
  readonly match?: string;
  /** Fresh membership and identity checks for already retained options; values stay private. */
  readonly options?: ReadonlyArray<{ readonly node: Element; readonly value: string }>;
}

/** What makes a control the one that was inspected. Geometry is excluded: scrolling moves it. */
export const identityOf = (facts: ControlFacts): string =>
  JSON.stringify([
    facts.kind,
    facts.label,
    facts.disabled,
    facts.checked ?? null,
    facts.selected ?? null,
    facts.required ?? null,
    facts.multiple ?? null,
    facts.editable,
    facts.inputType ?? null,
    facts.autocomplete ?? null,
    facts.destination ?? null,
    facts.formMethod ?? null,
  ]);

/**
 * The same identity without enablement. A form may enable the control it is about to use, so a
 * form step compares this and separately requires the control to be enabled now. `editable`
 * follows `disabled`, so it is left out too; a form step checks it where text is written.
 */
export const stableIdentityOf = (facts: ControlFacts): string =>
  JSON.stringify([
    facts.kind,
    facts.label,
    facts.checked ?? null,
    facts.selected ?? null,
    facts.required ?? null,
    facts.multiple ?? null,
    facts.inputType ?? null,
    facts.autocomplete ?? null,
    facts.destination ?? null,
    facts.formMethod ?? null,
  ]);

/** The model-facing projection: no destination, form or geometry ever leaves through it. */
export const observedControl = (
  facts: ControlFacts,
  elementId: string,
  selection: { readonly selectElementId?: string; readonly optionsTruncated?: boolean } = {},
): ObservedControl =>
  ObservedControl.make({
    elementId,
    kind: facts.kind,
    label: facts.label,
    disabled: facts.disabled,
    ...(facts.checked === undefined ? {} : { checked: facts.checked }),
    ...(facts.selected === undefined ? {} : { selected: facts.selected }),
    ...(facts.inputType === undefined ? {} : { inputType: facts.inputType }),
    ...(facts.required === undefined ? {} : { required: facts.required }),
    ...(facts.multiple === undefined ? {} : { multiple: facts.multiple }),
    ...selection,
  });

/**
 * Runs inside the page, so it is one self-contained function: it may not reference anything in
 * this module. It reads; it never scrolls, focuses, mutates or dispatches.
 *
 * Visibility here is geometry and hit-testing, never a pixel comparison. Text is kept only when
 * its line boxes intersect the viewport and the browser finds its own element at a sampled
 * point. Text under something that takes no pointer events cannot be hit-tested at all, so it is
 * counted as uncertain and left out rather than promoted to visible evidence.
 */
export const readPage = (
  request: PageReadRequest,
): { readonly nodes: Array<Element>; readonly data: unknown } => {
  const { scope, maximumBytes, controlLimit, nodeBudget, only } = request;
  const width = window.innerWidth;
  const height = window.innerHeight;
  const needle = request.match?.toLowerCase();

  const matches = (value: string): boolean =>
    needle === undefined || value.toLowerCase().includes(needle);

  const evidence = {
    width,
    height,
    clippedText: 0,
    coveredText: 0,
    uncertainText: 0,
    unreachableControls: 0,
    exhausted: false,
  };

  const intersects = (rect: DOMRect): boolean =>
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < height &&
    rect.left < width;

  const within = (rect: DOMRect): boolean =>
    rect.top >= 0 && rect.left >= 0 && rect.bottom <= height && rect.right <= width;

  // Boxes of elements that take no pointer events. Hit-testing sees through them, so whatever
  // lies beneath one cannot be shown to be uncovered.
  const passThrough: Array<{ readonly element: Element; readonly rect: DOMRect }> = [];
  let visited = 0;

  if (only === undefined && scope === "viewport") {
    const all = document.body?.getElementsByTagName("*") ?? [];

    for (let i = 0; i < all.length; i++) {
      if (++visited > nodeBudget) {
        evidence.exhausted = true;
        break;
      }
      const element = all[i];

      if (element === undefined) continue;
      const style = getComputedStyle(element);

      if (style.pointerEvents !== "none" || style.visibility === "hidden") continue;
      if (passThrough.some((known) => known.element.contains(element))) continue;
      const rect = element.getBoundingClientRect();

      if (intersects(rect) && Number(style.opacity) > 0) passThrough.push({ element, rect });
    }
  }

  /** Whether the browser finds `owner` at this point, and how far that can be trusted. */
  const hitTest = (owner: Element, rect: DOMRect): "self" | "covered" | "uncertain" => {
    const x = Math.min(width - 1, Math.max(0, rect.left + rect.width / 2));
    const y = Math.min(height - 1, Math.max(0, rect.top + rect.height / 2));
    let hit = document.elementFromPoint(x, y);

    while (hit?.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);

      if (inner === null || inner === hit) break;
      hit = inner;
    }
    if (hit === null) return "uncertain";
    if (hit !== owner && !owner.contains(hit) && !hit.contains(owner)) return "covered";

    const beneath = passThrough.some(
      (layer) =>
        !layer.element.contains(owner) &&
        !owner.contains(layer.element) &&
        x >= layer.rect.left &&
        x < layer.rect.right &&
        y >= layer.rect.top &&
        y < layer.rect.bottom,
    );

    return beneath ? "uncertain" : "self";
  };

  const factsOf = (node: Element) => {
    const tag = node.tagName.toLowerCase();
    const role = node.getAttribute("role");

    const booleanAttribute = (name: string): boolean | undefined => {
      const value = node.getAttribute(name);

      return value === "true" ? true : value === "false" ? false : undefined;
    };

    const isNativeToggle =
      node instanceof HTMLInputElement && (node.type === "checkbox" || node.type === "radio");

    const checked = isNativeToggle
      ? node.type === "checkbox" && node.indeterminate
        ? undefined
        : node.checked
      : role !== null &&
          ["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"].includes(role)
        ? booleanAttribute("aria-checked")
        : undefined;

    const selected =
      node instanceof HTMLOptionElement
        ? node.selected
        : !(node instanceof HTMLSelectElement) &&
            role !== null &&
            ["option", "tab", "treeitem", "row", "gridcell"].includes(role)
          ? booleanAttribute("aria-selected")
          : undefined;

    const required =
      node instanceof HTMLSelectElement ||
      node instanceof HTMLTextAreaElement ||
      (node instanceof HTMLInputElement &&
        !["hidden", "button", "submit", "reset", "image", "range", "color"].includes(node.type))
        ? node.required
        : role !== null &&
            [
              "checkbox",
              "combobox",
              "gridcell",
              "listbox",
              "radiogroup",
              "spinbutton",
              "textbox",
              "tree",
            ].includes(role)
          ? booleanAttribute("aria-required")
          : undefined;

    const field =
      node instanceof HTMLInputElement ||
      node instanceof HTMLButtonElement ||
      node instanceof HTMLSelectElement ||
      node instanceof HTMLTextAreaElement
        ? node
        : undefined;

    const submits =
      (node instanceof HTMLButtonElement && node.type === "submit") ||
      (node instanceof HTMLInputElement && (node.type === "submit" || node.type === "image"));

    // The effective destination: a resolved link target, or where this control submits its
    // form, including a `formaction` override. The browser resolves both against the base URL.
    const form = submits ? field?.form : undefined;

    const target =
      node instanceof HTMLAnchorElement || node instanceof HTMLAreaElement
        ? node.href
        : form === undefined || form === null
          ? undefined
          : node.hasAttribute("formaction") && field !== undefined && "formAction" in field
            ? field.formAction
            : form.action;

    const method =
      form === undefined || form === null
        ? undefined
        : (node.hasAttribute("formmethod") && field !== undefined && "formMethod" in field
            ? field.formMethod
            : form.method
          ).toLowerCase();

    const disabled = node.matches(":disabled") || node.getAttribute("aria-disabled") === "true";
    const rect = node.getBoundingClientRect();
    const placement = !intersects(rect) ? "outside" : within(rect) ? "inside" : "partial";

    const autocomplete =
      node instanceof HTMLInputElement ||
      node instanceof HTMLSelectElement ||
      node instanceof HTMLTextAreaElement
        ? node.autocomplete
        : "";

    return {
      kind:
        tag === "a"
          ? "link"
          : ["button", "input", "select", "textarea"].includes(tag)
            ? tag
            : "other",
      label: (
        node.getAttribute("aria-label") ??
        node.getAttribute("placeholder") ??
        (node instanceof HTMLInputElement
          ? node.labels?.[0]?.textContent
          : node instanceof HTMLOptionElement
            ? node.label
            : node.textContent) ??
        ""
      ).slice(0, 256),
      disabled,
      ...(checked === undefined ? {} : { checked }),
      ...(selected === undefined ? {} : { selected }),
      ...(required === undefined ? {} : { required }),
      ...(node instanceof HTMLSelectElement ? { multiple: node.multiple } : {}),
      editable:
        !disabled &&
        (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement
          ? !node.readOnly
          : node instanceof HTMLSelectElement),
      ...(node instanceof HTMLInputElement || node instanceof HTMLButtonElement
        ? { inputType: node.type.slice(0, 32) }
        : {}),
      ...(autocomplete === "" ? {} : { autocomplete: autocomplete.slice(0, 128) }),
      // An over-long destination is left out, never cut: half a URL is a different URL.
      ...(target === undefined || target.length > 2048 ? {} : { destination: target }),
      ...(method === "get" || method === "post" || method === "dialog"
        ? { formMethod: method }
        : {}),
      box: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      placement,
      hitTest: placement === "outside" ? "unsampled" : hitTest(node, rect),
      mainFrame: window.top === window,
    };
  };

  if (only !== undefined)
    return {
      nodes: [only],
      data: {
        facts: factsOf(only),
        ...(request.options === undefined
          ? {}
          : {
              attached: only.isConnected && only.ownerDocument === document,
              options: request.options.map(({ node, value }) => ({
                facts: factsOf(node),
                member:
                  only instanceof HTMLSelectElement &&
                  node instanceof HTMLOptionElement &&
                  node.isConnected &&
                  node.ownerDocument === document &&
                  node.closest("select") === only &&
                  only.options.item(node.index) === node,
                valueMatches: node instanceof HTMLOptionElement && node.value === value,
              })),
            }),
      },
    };

  const nodes: Array<Element> = [];
  const controls: Array<ReturnType<typeof factsOf>> = [];
  const selectIndices = new Map<HTMLSelectElement, number>();

  const candidates = document.querySelectorAll(
    "a[href],button,input,select,textarea,option,[role=button],[role=checkbox],[role=radio],[role=switch],[role=menuitemcheckbox],[role=menuitemradio],[role=option],[role=tab],[role=treeitem],[role=row],[role=gridcell],[role=textbox],[role=combobox],[role=listbox],[role=radiogroup],[role=spinbutton],[role=tree]",
  );

  let controlsTruncated = false;

  for (let i = 0; i < candidates.length; i++) {
    if (++visited > nodeBudget) {
      evidence.exhausted = true;
      controlsTruncated = true;
      break;
    }
    const node = candidates[i];

    if (node === undefined) continue;
    const facts = factsOf(node);

    const parentSelect = node instanceof HTMLOptionElement ? node.closest("select") : null;

    const choice =
      request.choices === true && parentSelect !== null && selectIndices.has(parentSelect);

    // A select stays with its choices: it matches through its own label or any option label,
    // and an option is kept only beside the select it belongs to.
    if (needle !== undefined) {
      const kept =
        node instanceof HTMLOptionElement
          ? parentSelect !== null && selectIndices.has(parentSelect)
          : matches(facts.label) ||
            (node instanceof HTMLSelectElement &&
              Array.from(node.options).some((option) => matches(option.label)));

      if (!kept) continue;
    }

    // Choices of a visible native select are metadata, not evidence of visible dropdown rows.
    // Filter before applying the shared limit so offscreen controls cannot spend it first.
    if (scope === "viewport" && !choice && facts.hitTest !== "self") {
      if (facts.placement !== "outside") evidence.unreachableControls++;
      continue;
    }
    if (nodes.length >= controlLimit) {
      controlsTruncated = true;
      break;
    }
    nodes.push(node);
    controls.push(facts);
    if (node instanceof HTMLSelectElement) selectIndices.set(node, nodes.length - 1);
  }

  const selects =
    request.choices === true
      ? [...selectIndices].map(([select, index]) => {
          const options: Array<{ readonly index: number; readonly value: string }> = [];

          nodes.forEach((node, optionIndex) => {
            if (
              node instanceof HTMLOptionElement &&
              node.closest("select") === select &&
              select.options.item(node.index) === node
            ) {
              const value = node.value;

              if (value.length <= 65536) options.push({ index: optionIndex, value });
            }
          });

          return { index, options, optionsTruncated: options.length !== select.options.length };
        })
      : undefined;

  const encoder = new TextEncoder();
  let text = "";
  let textTruncated = false;

  if (scope === "document") {
    const whole = document.body?.innerText ?? "";

    const encoded = encoder.encode(
      needle === undefined
        ? whole
        : whole
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line !== "" && matches(line))
            .join("\n"),
    );

    let end = Math.min(encoded.length, maximumBytes);

    // Do not manufacture a replacement character by cutting a UTF-8 sequence.
    while (end > 0 && end < encoded.length && ((encoded[end] ?? 0) & 192) === 128) end--;
    text = new TextDecoder().decode(encoded.subarray(0, end));
    textTruncated = end < encoded.length;
  } else if (document.body !== null) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let bytes = 0;
    let lastBottom = Number.NEGATIVE_INFINITY;

    // The first laid-out character at or after `index`; collapsed whitespace has no box.
    const boxAt = (node: Text, index: number): DOMRect | undefined => {
      const length = node.data.length;

      for (let k = index; k < Math.min(length, index + 8); k++) {
        range.setStart(node, k);
        range.setEnd(node, k + 1);
        const rect = range.getClientRects()[0];

        if (rect !== undefined && rect.width + rect.height > 0) return rect;
      }

      return undefined;
    };

    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (++visited > nodeBudget) {
        evidence.exhausted = true;
        textTruncated = true;
        break;
      }
      const owner = node.parentElement;

      if (!(node instanceof Text) || owner === null || node.data.trim() === "") continue;
      if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(owner.tagName)) continue;
      if (owner.checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) === false)
        continue;
      range.selectNodeContents(node);
      const lines = [...range.getClientRects()].filter(intersects);
      const first = lines[0];

      // Laid out entirely off screen: not evidence of anything, and not counted as hidden.
      if (first === undefined) continue;
      const verdict = hitTest(owner, first);

      if (verdict !== "self") {
        if (verdict === "covered") evidence.coveredText++;
        else evidence.uncertainText++;
        continue;
      }
      range.selectNodeContents(node);
      let visible = node.data;

      if (![...range.getClientRects()].every(within)) {
        // Lines run top to bottom, so the visible run is found by bisecting on character boxes
        // rather than by copying a whole node of which one line is on screen.
        const length = node.data.length;
        let low = 0;
        let high = length;

        while (low < high) {
          const middle = (low + high) >> 1;
          const rect = boxAt(node, middle);

          if (rect === undefined || rect.bottom <= 0) low = middle + 1;
          else high = middle;
        }
        const start = low;

        high = length;
        while (low < high) {
          const middle = (low + high) >> 1;
          const rect = boxAt(node, middle);

          if (rect !== undefined && rect.top >= height) high = middle;
          else low = middle + 1;
        }
        visible = node.data.slice(start, low);
        evidence.clippedText++;
      }
      const fragment = visible.replace(/\s+/g, " ").trim();

      if (fragment === "" || !matches(fragment)) continue;
      const joined = (text === "" ? "" : first.top >= lastBottom - 1 ? "\n" : " ") + fragment;
      const size = encoder.encode(joined).length;

      if (bytes + size > maximumBytes) {
        textTruncated = true;
        break;
      }
      text += joined;
      bytes += size;
      lastBottom = Math.max(lastBottom, first.bottom);
    }
  }

  return {
    nodes,
    data: {
      text,
      textTruncated,
      controlsTruncated,
      controls,
      viewport: evidence,
      ...(selects === undefined ? {} : { selects }),
    },
  };
};
