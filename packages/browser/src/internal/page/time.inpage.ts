/**
 * In the page: one step of what a held page shows, in one call. The document is scrolled first,
 * then the page clock in the main world is told what to do, so the page's own handlers see the
 * scroll as its time moves, then elements are posed and the overlay is drawn. A pose naming an
 * element the document no longer has is found before any of it, and the step does nothing. The
 * clock hears an event only it and the
 * library know the name of (see `clock.inpage.ts`), and acknowledges it. See `names.inpage.ts` for
 * what a page-side part may use.
 */
import type { Overlay } from "./overlay.inpage.ts";
import type { PoseRequest, Posing } from "./pose.inpage.ts";

export interface StepRequest {
  /** The page clock's event name. */
  readonly clock: string;
  readonly op: "hold" | "advance" | "release";
  readonly by: number;
  /** Where to scroll the document to, in CSS pixels down it, or null to leave it. */
  readonly scroll: number | null;
  /** What the overlay shows, null for nothing; left out, the overlay is left alone. */
  readonly markup?: string | null | undefined;
  /** The elements to pose, and no others; left out, poses are left alone. */
  readonly poses?: ReadonlyArray<PoseRequest> | undefined;
}

export const time = (overlaid: Overlay, posing: Posing) => {
  const step = (request: StepRequest) => {
    const posed = request.poses === undefined ? undefined : posing.prepare(request.poses);

    if (posed !== undefined && !("apply" in posed))
      return { told: false, drawn: null, scroll: { x: scrollX, y: scrollY }, ...posed };
    if (request.scroll !== null)
      scrollTo({ left: scrollX, top: request.scroll, behavior: "instant" });
    const detail = { op: request.op, by: request.by };

    const told = !document.dispatchEvent(
      new CustomEvent(request.clock, { detail, cancelable: true }),
    );

    posed?.apply();
    const drawn = request.markup === undefined ? null : overlaid.draw(request.markup);

    return { told, drawn, scroll: { x: scrollX, y: scrollY } };
  };

  return { step };
};

export type Time = ReturnType<typeof time>;
