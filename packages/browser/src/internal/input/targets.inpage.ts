/**
 * In the page: where input lands. It resolves a ref or a point to the control under it, in
 * top-document viewport pixels, with the subject's context, and plans a wheel scroll that brings a
 * ref into view. See `reading/names.inpage.ts` for what a page-side part may use.
 */
import { Schema } from "effect";

import { Box, SubjectContext } from "../../BrowserEvent.ts";
import type { ContextReader } from "../reading/context.inpage.ts";
import type { Names } from "../reading/names.inpage.ts";
import type { Walk } from "../reading/walk.inpage.ts";

export type ResolvedPoint = typeof ResolvedPointSchema.Type;
export type PointResult = typeof PointResultSchema.Type;

export const targets = (names: Names, walked: Walk, placing: ContextReader) => {
  const { describe, isDisabled, lookup, nameOf, parentOf, roleOf } = names;
  const { boxOf, controlOf, hitAt } = walked;
  const { contextOf } = placing;

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

  const details = (
    element: Element,
    hit: Element,
    x: number,
    y: number,
  ): Omit<ResolvedPoint, "context"> => {
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

      if (hit === null) return { error: "offscreen", detail: `nothing is painted at (${x}, ${y})` };
      const control = controlOf(hit);

      return { ...details(control, hit, x, y), context: contextOf(control), box: boxOf(control) };
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

    return {
      ...details(element, hit ?? element, Math.round(x), Math.round(y)),
      context: contextOf(element),
    };
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

  return { controlOf, details, hitAt, hrefAttribute, linkOf, point, receives, scrollPlan, within };
};

export type Targets = ReturnType<typeof targets>;

const ResolvedPointSchema = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
  element: Schema.String,
  tag: Schema.String,
  role: Schema.NullOr(Schema.String),
  name: Schema.String,
  context: SubjectContext,
  box: Schema.optional(Box),
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

export const ScrollPlanSchema = Schema.NullOr(
  Schema.Struct({
    x: Schema.Finite,
    y: Schema.Finite,
    dx: Schema.Finite,
    dy: Schema.Finite,
  }),
);
