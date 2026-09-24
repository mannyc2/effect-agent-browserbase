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
  /**
   * Sampled points that something taking no pointer events lies over, which only the browser's
   * own hit test can settle. They were counted as uncertain in this reading.
   */
  pending: Schema.optionalKey(
    Schema.Struct({
      points: Schema.Array(Schema.Tuple([Schema.Int, Schema.Int])).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(256),
      ),
      scrollX: Schema.Finite,
      scrollY: Schema.Finite,
    }),
  ),
});

export type PageReadResult = typeof PageReadResult.Type;

/**
 * What the browser found on top at one sampled point once pointer events are ignored: the
 * pointer's own target or something inside it (`self`), a box that paints there (`covered`), or
 * boxes that paint nothing there (`clear`).
 */
export const PointVerdict = Schema.Literals(["self", "covered", "clear"]);

export type PointVerdict = typeof PointVerdict.Type;

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
  /** The browser's answers for the points an earlier reading of this page left pending. */
  readonly verdicts?: Readonly<Record<string, PointVerdict>>;
  /**
   * Classify these points against `top`, the box the browser found above each with pointer
   * events ignored, instead of reading anything.
   */
  readonly classify?: ReadonlyArray<readonly [number, number]>;
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
 * point. Something that takes no pointer events is invisible to that hit test, so a point with
 * such a box over it is left pending and counted as uncertain. The host then asks the browser
 * which box is on top there with pointer events ignored, which also finds boxes inside closed
 * shadow roots, and reads again with the answers: a box that paints at the point covers it, and
 * a box that paints nothing there does not. Nothing is kept as visible without that answer.
 *
 * With `classify`, it instead judges each point against `top`, the box the browser returned for
 * it, and returns one verdict per point.
 */
export const readPage = (
  request: PageReadRequest,
  top?: unknown,
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

  type Box = Pick<DOMRect, "left" | "top" | "right" | "bottom" | "width" | "height">;

  const intersects = (rect: Box): boolean =>
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < height &&
    rect.left < width;

  const within = (rect: DOMRect): boolean =>
    rect.top >= 0 && rect.left >= 0 && rect.bottom <= height && rect.right <= width;

  const contains = (rect: Box, x: number, y: number): boolean =>
    x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;

  /** The flat-tree parent: a shadow root's host rather than the root itself. */
  const parentOf = (node: Node): Node | null => {
    const parent = node.parentNode;

    return parent instanceof ShadowRoot ? parent.host : parent;
  };

  /** Whether `inner` is `outer` or lies inside it, across shadow boundaries. */
  const holds = (outer: Node, inner: Node): boolean => {
    for (let node: Node | null = inner; node !== null; node = parentOf(node))
      if (node === outer) return true;

    return false;
  };

  const related = (left: Node, right: Node): boolean => holds(left, right) || holds(right, left);

  /** The alpha of a computed colour; an unparsed format counts as opaque. */
  const alphaOf = (color: string): number => {
    if (color === "transparent") return 0;
    const inside = /\(([^)]*)\)/.exec(color)?.[1];

    if (inside === undefined) return 1;
    const alpha = inside.includes("/") ? inside.split("/")[1] : inside.split(",")[3];

    if (alpha === undefined) return 1;
    const value = Number.parseFloat(alpha);

    if (Number.isNaN(value)) return 1;

    return alpha.trim().endsWith("%") ? value / 100 : value;
  };

  /** Whether a computed style draws anything of its own: a fill, a border, a shadow or an effect. */
  const draws = (style: CSSStyleDeclaration): boolean =>
    alphaOf(style.backgroundColor) > 0 ||
    style.backgroundImage !== "none" ||
    ["top", "right", "bottom", "left"].some(
      (side) =>
        Number.parseFloat(style.getPropertyValue(`border-${side}-width`)) > 0 &&
        !["none", "hidden"].includes(style.getPropertyValue(`border-${side}-style`)) &&
        alphaOf(style.getPropertyValue(`border-${side}-color`)) > 0,
    ) ||
    style.boxShadow !== "none" ||
    (style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0) ||
    style.filter !== "none" ||
    (style.getPropertyValue("backdrop-filter") || "none") !== "none" ||
    style.mixBlendMode !== "normal";

  // Elements whose own box shows content, whatever their style says.
  const replaced = new Set([
    "IMG",
    "VIDEO",
    "CANVAS",
    "IFRAME",
    "EMBED",
    "OBJECT",
    "INPUT",
    "SELECT",
    "TEXTAREA",
    "BUTTON",
    "METER",
    "PROGRESS",
  ]);

  const pseudoDraws = (element: Element, type: "::before" | "::after"): boolean => {
    const style = getComputedStyle(element, type);

    return (
      style.content !== "none" &&
      style.content !== "normal" &&
      style.display !== "none" &&
      (draws(style) || !/^(""|'')$/.test(style.content))
    );
  };

  /** Whether `element` has its own text on a line box over the point. */
  const textAt = (element: Element, x: number, y: number): boolean => {
    const lines = document.createRange();

    for (const child of element.childNodes) {
      if (!(child instanceof Text) || child.data.trim() === "") continue;
      lines.selectNodeContents(child);
      for (const rect of lines.getClientRects()) if (contains(rect, x, y)) return true;
    }

    return false;
  };

  /** Whether `element` itself, not a descendant, paints at the point. */
  const paintsAt = (element: Element, x: number, y: number): boolean =>
    element.checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) !== false &&
    (replaced.has(element.tagName) ||
      element instanceof SVGElement ||
      draws(getComputedStyle(element)) ||
      textAt(element, x, y));

  /** The element the pointer would reach at this point, inside open shadow roots. */
  const pointerAt = (x: number, y: number): Element | null => {
    let hit = document.elementFromPoint(x, y);

    while (hit?.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);

      if (inner === null || inner === hit) break;
      hit = inner;
    }

    return hit;
  };

  if (request.classify !== undefined) {
    // `top` is an Element, or a CSSPseudoElement that stands for a ::before or ::after box.
    const pseudo =
      top instanceof Node || typeof top !== "object" || top === null
        ? undefined
        : (top as { readonly element?: unknown; readonly type?: unknown });

    const origin =
      top instanceof Element
        ? top
        : pseudo?.element instanceof Element
          ? pseudo.element
          : undefined;

    const verdictAt = ([x, y]: readonly [number, number]): string => {
      const hit = pointerAt(x, y);

      if (hit === null || origin === undefined) return "unknown";
      if (pseudo === undefined) {
        if (related(origin, hit)) return "self";
      } else {
        // The pointer's own generated box, or one of something inside it.
        if (holds(hit, origin)) return "self";
        if (pseudoDraws(origin, pseudo.type === "::after" ? "::after" : "::before"))
          return "covered";
      }
      // Every box from the top down to the first one that also holds the pointer's target lies
      // above that target here. Any of them that paints at the point covers it.
      for (
        let node: Node | null = origin;
        node !== null && !holds(node, hit);
        node = parentOf(node)
      )
        if (
          node instanceof Element &&
          contains(node.getBoundingClientRect(), x, y) &&
          paintsAt(node, x, y)
        )
          return "covered";

      return "clear";
    };

    return { nodes: [], data: request.classify.map(verdictAt) };
  }

  // Boxes of elements that take no pointer events, in the light DOM and open shadow roots.
  // Hit-testing sees through them, so a point beneath one waits for the browser's own answer.
  // `painting` keeps those that draw something of their own, with painting pseudo-elements at an
  // approximated box. The scan has its own budget: an incomplete one leaves every point pending.
  const boxes: Array<{ readonly element: Element; readonly rect: Box }> = [];
  const painting: Array<{ readonly element: Element; readonly rect: Box }> = [];
  let scanned = 0;
  let scanComplete = true;

  if (only === undefined && scope === "viewport" && document.body !== null) {
    const roots: Array<ParentNode> = [document.body];

    for (let root = roots.pop(); root !== undefined && scanComplete; root = roots.pop()) {
      const all = root.querySelectorAll("*");

      for (let i = 0; i < all.length; i++) {
        const element = all[i];

        if (++scanned > nodeBudget || boxes.length >= 512 || painting.length >= 512) {
          scanComplete = false;
          break;
        }
        if (element === undefined) continue;
        if (element.shadowRoot !== null) roots.push(element.shadowRoot);
        const style = getComputedStyle(element);

        if (style.pointerEvents !== "none" || style.visibility === "hidden") continue;
        if (Number(style.opacity) <= 0) continue;
        const rect = element.getBoundingClientRect();

        if (intersects(rect)) {
          boxes.push({ element, rect });
          if (
            replaced.has(element.tagName) ||
            element instanceof SVGElement ||
            draws(style) ||
            [...element.childNodes].some(
              (child) => child instanceof Text && child.data.trim() !== "",
            )
          )
            painting.push({ element, rect });
        }
        for (const type of ["::before", "::after"] as const) {
          if (!pseudoDraws(element, type)) continue;
          const generated = getComputedStyle(element, type);
          let area: Box = rect;

          // A positioned pseudo-element is placed from its host's box; others fill it.
          if (
            (generated.position === "absolute" || generated.position === "fixed") &&
            style.position !== "static"
          ) {
            const left = rect.left + (Number.parseFloat(generated.left) || 0);
            const top = rect.top + (Number.parseFloat(generated.top) || 0);
            const across = Number.parseFloat(generated.width) || 0;
            const down = Number.parseFloat(generated.height) || 0;

            area = {
              left,
              top,
              right: left + across,
              bottom: top + down,
              width: across,
              height: down,
            };
          }
          if (intersects(area)) {
            boxes.push({ element, rect: area });
            painting.push({ element, rect: area });
          }
        }
      }
    }
    if (!scanComplete) evidence.exhausted = true;
  }

  const pending: Array<readonly [number, number]> = [];
  const pendingKeys = new Set<string>();
  let visited = 0;

  /** Whether the browser finds `owner` at this point, and how far that can be trusted. */
  const hitTest = (owner: Element, rect: DOMRect): "self" | "covered" | "uncertain" => {
    const x = Math.floor(Math.min(width - 1, Math.max(0, rect.left + rect.width / 2)));
    const y = Math.floor(Math.min(height - 1, Math.max(0, rect.top + rect.height / 2)));
    const hit = pointerAt(x, y);

    if (hit === null) return "uncertain";
    if (hit !== owner && !owner.contains(hit) && !hit.contains(owner)) return "covered";

    const over = (layers: ReadonlyArray<{ readonly element: Element; readonly rect: Box }>) =>
      layers.some((layer) => !related(layer.element, owner) && contains(layer.rect, x, y));

    if (scanComplete && !over(boxes)) return "self";
    const key = `${String(x)},${String(y)}`;
    const verdict = request.verdicts?.[key];

    if (verdict === "self") return "self";
    if (verdict === "covered") return "covered";
    // Nothing on top paints here; a painting box beneath the top one could still hide it.
    if (verdict === "clear") return over(painting) ? "uncertain" : "self";
    if (request.verdicts === undefined && !pendingKeys.has(key) && pending.length < 256) {
      pendingKeys.add(key);
      pending.push([x, y]);
    }

    return "uncertain";
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
      ...(pending.length === 0
        ? {}
        : { pending: { points: pending, scrollX: window.scrollX, scrollY: window.scrollY } }),
    },
  };
};
