/**
 * In the page: the walk every read shares, and what is painted at a point. The walk visits
 * visible elements in tree order, into shadow roots and same-origin frames. Reading the viewport,
 * it skips a subtree whose box lies outside the viewport before it styles anything in it, which
 * spares a long table all but its rows in view. A box says nothing of what is positioned out of
 * it, so a subtree is kept when its box is empty, such as a wrapper of a pinned dialog, or when it
 * holds what is painted at the viewport's edges, corners or middle, or in its top layer, such as
 * a bar pinned inside a header scrolled away. Something pinned elsewhere, inside a subtree out of
 * view, is missed. See `names.inpage.ts` for what a page-side part may use.
 */
import type { Names } from "./names.inpage.ts";

export interface Visitor<S> {
  /** The state for the element's children, or undefined to leave them out. */
  readonly enter: (
    element: Element,
    style: CSSStyleDeclaration,
    rect: DOMRect,
    state: S,
  ) => S | undefined;
  /** Whether to visit a child of an element entered with `state`; all by default. */
  readonly admit?: ((child: Element, state: S) => boolean) | undefined;
  /** Each text node of an entered element, in order among its children. */
  readonly text?: ((node: Node, state: S) => void) | undefined;
  /** After the children of an element `enter` went into, with the state it returned. */
  readonly leave?: ((element: Element, state: S) => void) | undefined;
  /** A subtree left out because its box lies outside the viewport, in top-document pixels. */
  readonly outside?: ((rect: DOMRect) => void) | undefined;
}

export const walk = (names: Names) => {
  const { interactiveRoles, isElement, isFrame, parentOf, roleOf } = names;

  const skipped = new Set("SCRIPT STYLE NOSCRIPT TEMPLATE HEAD META LINK SVG".split(" "));

  const isVisible = (element: Element, style: CSSStyleDeclaration, rect: DOMRect): boolean =>
    style.display !== "none" &&
    style.visibility === "visible" &&
    style.opacity !== "0" &&
    element.getAttribute("aria-hidden") !== "true" &&
    (rect.width > 0 || rect.height > 0 || style.display === "contents");

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

  /** The element painted at a point, inside shadow roots and same-origin frames. */
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

  /** Whether its role or a click handler makes an element a control. */
  const acts = (element: Element, role: string | null): boolean =>
    (role !== null && (interactiveRoles.has(role) || role === "canvas" || role === "iframe")) ||
    element.hasAttribute("onclick");

  // A painted child of a control still activates the control; keep its name without moving the point.
  const controlOf = (hit: Element): Element => {
    let element: Element | null = hit;

    while (element !== null) {
      if (acts(element, roleOf(element))) return element;
      element = parentOf(element);
    }

    return hit;
  };

  /** An element's box in top-document viewport pixels, through the frames around it. */
  const boxOf = (element: Element): { x: number; y: number; width: number; height: number } => {
    const { x, y, width, height } = element.getBoundingClientRect();
    const frame = element.ownerDocument.defaultView?.frameElement ?? null;

    if (frame === null) return { x, y, width, height };
    const outer = boxOf(frame);

    return { x: x + outer.x + frame.clientLeft, y: y + outer.y + frame.clientTop, width, height };
  };

  /** What is painted where pinned things sit, and every element holding it. */
  const painted = (width: number, height: number): Set<Element> => {
    const keep = new Set<Element>();

    const hold = (element: Element | null) => {
      for (
        let node = element;
        node !== null && !keep.has(node);
        node = parentOf(node) ?? node.ownerDocument.defaultView?.frameElement ?? null
      )
        keep.add(node);
    };

    for (const y of [8, 48, height / 2, height - 48, height - 8])
      for (const x of [8, 48, width / 4, width / 2, (width * 3) / 4, width - 48, width - 8])
        if (x >= 0 && y >= 0 && x < width && y < height) hold(hitAt(document, x, y));
    for (const element of Array.from(document.querySelectorAll(":modal, :popover-open")))
      hold(element);

    return keep;
  };

  /**
   * Visit `root` and what it holds, or the whole document when `root` is null. With `viewport`,
   * a subtree outside the viewport is skipped, as described above.
   */
  const visit = <S>(root: Element | null, viewport: boolean, state: S, visitor: Visitor<S>) => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    let keep: Set<Element> | undefined;

    const children = (parent: ParentNode, inner: S, dx: number, dy: number) => {
      // Text nodes are touched only for a visitor that reads them.
      const nodes = visitor.text === undefined ? parent.children : parent.childNodes;

      for (const node of Array.from<Node>(nodes)) {
        if (node.nodeType === Node.TEXT_NODE) visitor.text?.(node, inner);
        else if (isElement(node) && (visitor.admit === undefined || visitor.admit(node, inner)))
          one(node, inner, dx, dy);
      }
    };

    const one = (element: Element, outer: S, dx: number, dy: number): void => {
      if (skipped.has(element.tagName.toUpperCase())) return;
      const local = element.getBoundingClientRect();
      const rect = new DOMRect(local.x + dx, local.y + dy, local.width, local.height);

      if (
        viewport &&
        local.width > 0 &&
        local.height > 0 &&
        (rect.bottom <= 0 || rect.top >= height || rect.right <= 0 || rect.left >= width) &&
        !(keep ??= painted(width, height)).has(element)
      ) {
        visitor.outside?.(rect);

        return;
      }
      const style = getComputedStyle(element);

      if (!isVisible(element, style, local)) return;
      const inner = visitor.enter(element, style, rect, outer);

      if (inner === undefined) return;
      if (isFrame(element)) {
        const body = element.contentDocument?.body;

        if (body !== null && body !== undefined) children(body, inner, rect.x, rect.y);
      } else {
        if (element.shadowRoot !== null) children(element.shadowRoot, inner, dx, dy);
        children(element, inner, dx, dy);
      }
      visitor.leave?.(element, inner);
    };

    if (root === null) children(document, state, 0, 0);
    else one(root, state, 0, 0);
  };

  return { acts, boxOf, controlOf, hitAt, visit };
};

export type Walk = ReturnType<typeof walk>;
