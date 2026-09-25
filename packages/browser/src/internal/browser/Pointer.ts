import { Schema } from "effect";
import type { ElementHandle, Page } from "playwright-core";

import type { ObservedElement } from "../../BrowserData.ts";
import { Reasons } from "../../Errors.ts";
import type { makeActions } from "./Actions.ts";
import type { DriverTarget } from "./Driver.ts";
import { failure, safeDecode, sanitize } from "./NativeCalls.ts";
import type { AdmissionPolicy } from "./Observation.ts";
import type { Ticket } from "./Owner.ts";
import type { Targets } from "./Targets.ts";

export interface NativePoint {
  readonly x: number;
  readonly y: number;
}

/** What one native pointer command did. The session adds target identity and the host clock. */
export interface NativeInput {
  /** The last point this driver commanded on the page, or null if it never placed the pointer. */
  readonly position: NativePoint | null;
}

const Reach = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
  reachable: Schema.Boolean,
});

/** Runs in each document on the path to the exact node, including cross-origin frames. */
const hitPoint = (
  node: Node,
  input: NativePoint & { readonly child: boolean },
): { readonly x: number; readonly y: number; readonly reachable: boolean } => {
  const refused = { x: input.x, y: input.y, reachable: false };

  if (
    !(node instanceof Element) ||
    !node.isConnected ||
    input.x < 0 ||
    input.y < 0 ||
    input.x >= innerWidth ||
    input.y >= innerHeight
  )
    return refused;

  let hit = node.ownerDocument.elementFromPoint(input.x, input.y);

  for (let depth = 0; hit?.shadowRoot; depth++) {
    if (depth >= 32) return refused;
    const inner = hit.shadowRoot.elementFromPoint(input.x, input.y);

    if (inner === null || inner === hit) break;
    hit = inner;
  }
  if (hit === null || (hit !== node && !node.contains(hit))) return refused;
  if (!input.child) return { x: input.x, y: input.y, reachable: true };
  if (!(node instanceof HTMLElement)) return refused;

  // Mapping a bounding rectangle through rotation/perspective would guess a point. Admit
  // positive axis-aligned scaling/translation; reject unsupported transforms before input.
  let ancestor: Element | null = node;

  for (let depth = 0; ancestor !== null; depth++) {
    if (depth >= 128) return refused;
    const style = getComputedStyle(ancestor);
    const rotation = style.getPropertyValue("rotate");
    const scale = style.getPropertyValue("scale");

    if (
      (rotation !== "" && rotation !== "none" && rotation !== "0deg") ||
      (scale !== "" &&
        scale !== "none" &&
        scale.split(/\s+/).some((axis) => !(Number.parseFloat(axis) > 0))) ||
      style.perspective !== "none" ||
      (style.offsetPath !== "" && style.offsetPath !== "none")
    )
      return refused;
    if (style.transform !== "none") {
      const matrix = new DOMMatrixReadOnly(style.transform);

      if (!matrix.is2D || matrix.b !== 0 || matrix.c !== 0 || matrix.a <= 0 || matrix.d <= 0)
        return refused;
    }
    const root = ancestor.getRootNode();

    ancestor = ancestor.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
  }

  const rect = node.getBoundingClientRect();
  const scaleX = rect.width / node.offsetWidth;
  const scaleY = rect.height / node.offsetHeight;

  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0)
    return refused;
  const style = getComputedStyle(node);
  const left = Number.parseFloat(style.paddingLeft);
  const top = Number.parseFloat(style.paddingTop);
  const right = Number.parseFloat(style.paddingRight);
  const bottom = Number.parseFloat(style.paddingBottom);
  const x = (input.x - rect.left) / scaleX - node.clientLeft - left;
  const y = (input.y - rect.top) / scaleY - node.clientTop - top;

  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < 0 ||
    y < 0 ||
    x >= node.clientWidth - left - right ||
    y >= node.clientHeight - top - bottom
  )
    return refused;

  return { x, y, reachable: true };
};

/**
 * Real pointer input to the selected page. Every command is one the browser would receive from
 * a person, so handlers see trusted events and the browser decides what is under the pointer.
 * Nothing here scrolls, eases or retries: a caller that wants a trajectory sends its points.
 */
export const makePointer = (targets: Targets, actions: ReturnType<typeof makeActions>) => {
  const { current } = targets;
  // Chromium keeps a pointer position per page; this is only the last one this driver set.
  const positions = new WeakMap<Page, NativePoint | null>();

  const moveTo = async (page: Page, point: NativePoint): Promise<void> => {
    await page.mouse.move(point.x, point.y);
    positions.set(page, point);
  };

  const receipt = (page: Page): NativeInput => ({ position: positions.get(page) ?? null });

  const invalidate = (page: Page): void => {
    positions.set(page, null);
  };

  const pointerMove = (point: NativePoint, ticket: Ticket, target?: DriverTarget) =>
    sanitize(async () => {
      const { page } = current(target).entry;

      ticket.dispatch();
      await moveTo(page, point);
      ticket.check();

      return receipt(page);
    });

  /**
   * The centre of the element's box, in main-frame viewport pixels, and only if the pointer can
   * really be placed there: the box has area, the point is inside the viewport, and the element
   * is what the browser finds at that point. An open shadow root is followed to the node a
   * person would actually be over.
   */
  const reachablePoint = async (
    page: Page,
    element: ElementHandle<Element>,
  ): Promise<NativePoint> => {
    const box = await element.boundingBox();

    if (box === null || box.width <= 0 || box.height <= 0)
      throw failure(Reasons.NotVisible.make({}), "undispatched");
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

    const ancestors: Array<ElementHandle<Node>> = [];

    try {
      let frame = await element.ownerFrame();

      if (frame === null || frame.page() !== page)
        throw failure(Reasons.Stale.make({}), "undispatched");
      while (frame !== page.mainFrame()) {
        if (ancestors.length >= 32)
          throw failure(
            Reasons.Limit.make({
              dimension: "frame-depth",
              maximum: 32,
              observed: ancestors.length,
            }),
            "undispatched",
          );
        ancestors.push(await frame.frameElement());
        frame = frame.parentFrame();
        if (frame === null) throw failure(Reasons.Stale.make({}), "undispatched");
      }

      let localPoint = point;

      // A visible node in a child can still sit behind an overlay in any ancestor. Check the
      // actual commanded point from the main viewport down, then hit-test the exact node.
      for (const ancestor of ancestors.reverse()) {
        const reached = safeDecode(
          Reach,
          await ancestor.evaluate(hitPoint, { ...localPoint, child: true }),
        );

        if (!reached.reachable) throw failure(Reasons.NotVisible.make({}), "undispatched");
        localPoint = { x: reached.x, y: reached.y };
      }

      const reached = safeDecode(
        Reach,
        await element.evaluate(hitPoint, { ...localPoint, child: false }),
      );

      if (!reached.reachable) throw failure(Reasons.NotVisible.make({}), "undispatched");
    } finally {
      await Promise.all(ancestors.map((ancestor) => ancestor.dispose()));
    }

    return point;
  };

  const hover = (
    target: string | ObservedElement,
    ticket: Ticket,
    policy?: AdmissionPolicy,
    browserTarget?: DriverTarget,
  ) =>
    sanitize(async () => {
      const { page } = current(browserTarget).entry;

      await actions.withAdmittedElement(
        target,
        ticket,
        (element) => reachablePoint(page, element),
        (_element, point) => moveTo(page, point),
        policy,
        browserTarget,
      );
      ticket.check();

      return receipt(page);
    });

  const wheel = (
    deltaX: number,
    deltaY: number,
    at: NativePoint | undefined,
    ticket: Ticket,
    target?: DriverTarget,
  ) =>
    sanitize(async () => {
      const { page } = current(target).entry;

      ticket.dispatch();
      if (at !== undefined) await moveTo(page, at);
      // Dispatched, not awaited: Chromium scrolls afterwards, on its own schedule.
      await page.mouse.wheel(deltaX, deltaY);
      ticket.check();

      return receipt(page);
    });

  return { pointerMove, hover, wheel, receipt, invalidate };
};
