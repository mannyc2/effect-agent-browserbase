import { Schema } from "effect";
import type { ElementHandle, Page } from "playwright-core";

import type { ObservedElement } from "../../BrowserData.ts";
import type { makeActions } from "./Actions.ts";
import { failure, safeDecode, sanitize } from "./NativeCalls.ts";
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
  viewportWidth: Schema.Finite,
  viewportHeight: Schema.Finite,
  reachable: Schema.Boolean,
});

/**
 * Real pointer input to the selected page. Every command is one the browser would receive from
 * a person, so handlers see trusted events and the browser decides what is under the pointer.
 * Nothing here scrolls, eases or retries: a caller that wants a trajectory sends its points.
 */
export const makePointer = (targets: Targets, actions: ReturnType<typeof makeActions>) => {
  const { current } = targets;
  // Chromium keeps a pointer position per page; this is only the last one this driver set.
  const positions = new WeakMap<Page, NativePoint>();

  const moveTo = async (page: Page, point: NativePoint): Promise<void> => {
    await page.mouse.move(point.x, point.y);
    positions.set(page, point);
  };

  const receipt = (page: Page): NativeInput => ({ position: positions.get(page) ?? null });

  const pointerMove = (point: NativePoint, ticket: Ticket) =>
    sanitize(async () => {
      const { page } = current().entry;

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
      throw failure("not-visible", "undispatched");
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

    const reach = safeDecode(
      Reach,
      await element.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        let hit = node.ownerDocument.elementFromPoint(x, y);

        while (hit?.shadowRoot) {
          const inner = hit.shadowRoot.elementFromPoint(x, y);

          if (inner === null || inner === hit) break;
          hit = inner;
        }

        return {
          viewportWidth: window.top === window ? window.innerWidth : Number.POSITIVE_INFINITY,
          viewportHeight: window.top === window ? window.innerHeight : Number.POSITIVE_INFINITY,
          reachable: hit !== null && (hit === node || node.contains(hit)),
        };
      }),
    );

    // A child frame reports no main viewport, so the main frame bounds the point for it.
    const viewport = Number.isFinite(reach.viewportWidth)
      ? { width: reach.viewportWidth, height: reach.viewportHeight }
      : safeDecode(
          Schema.Struct({ width: Schema.Finite, height: Schema.Finite }),
          await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })),
        );

    if (
      !reach.reachable ||
      point.x < 0 ||
      point.y < 0 ||
      point.x >= viewport.width ||
      point.y >= viewport.height
    )
      throw failure("not-visible", "undispatched");

    return point;
  };

  const hover = (target: string | ObservedElement, ticket: Ticket) =>
    sanitize(async () => {
      const { page } = current().entry;

      await actions.withAdmittedElement(
        target,
        ticket,
        (element) => reachablePoint(page, element),
        (_element, point) => moveTo(page, point),
      );
      ticket.check();

      return receipt(page);
    });

  const wheel = (deltaX: number, deltaY: number, at: NativePoint | undefined, ticket: Ticket) =>
    sanitize(async () => {
      const { page } = current().entry;

      ticket.dispatch();
      if (at !== undefined) await moveTo(page, at);
      // Dispatched, not awaited: Chromium scrolls afterwards, on its own schedule.
      await page.mouse.wheel(deltaX, deltaY);
      ticket.check();

      return receipt(page);
    });

  return { pointerMove, hover, wheel };
};
