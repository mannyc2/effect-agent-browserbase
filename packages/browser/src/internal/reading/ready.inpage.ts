/**
 * In the page: whether it is ready to be shown. Its document is parsed and has painted since,
 * nothing that ends is animating in view, its fonts and the images in view have loaded, and the
 * viewport shows something: text, or a picture, canvas, video, drawing or frame. See
 * `names.inpage.ts` for what a page-side part may use.
 */
import { Schema } from "effect";

import type { Walk } from "./walk.inpage.ts";

/** What the page is still waiting for; none when it is ready. */
export const ReadinessSchema = Schema.Array(
  Schema.Literals(["load", "paint", "animations", "images", "fonts", "content"]),
);

export type Readiness = typeof ReadinessSchema.Type;

export const ready = (walked: Walk) => {
  const inView = (element: Element): boolean => {
    const rect = element.getBoundingClientRect();

    return (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.right > 0 &&
      rect.bottom > 0 &&
      rect.left < window.innerWidth &&
      rect.top < window.innerHeight
    );
  };

  // A hidden document paints no frames, so it is not ready to be shown.
  const painted = (): Promise<boolean> => {
    const { promise, resolve } = Promise.withResolvers<boolean>();

    if (document.visibilityState === "hidden") resolve(false);
    else requestAnimationFrame(() => resolve(true));

    return promise;
  };

  const check = (): Promise<Readiness> =>
    painted().then((paints) => {
      const waiting: Array<Readiness[number]> = [];

      if (document.readyState === "loading") waiting.push("load");
      if (!paints) waiting.push("paint");
      // An endless animation, such as a pulsing dot, never ends, so only those that end count.
      if (
        document.getAnimations().some((animation) => {
          const effect = animation.effect;

          return (
            animation.playState === "running" &&
            effect !== null &&
            Number.isFinite(effect.getComputedTiming().endTime) &&
            "target" in effect &&
            effect.target instanceof Element &&
            inView(effect.target)
          );
        })
      )
        waiting.push("animations");
      if (Array.from(document.images).some((image) => !image.complete && inView(image)))
        waiting.push("images");
      if (document.fonts.status !== "loaded") waiting.push("fonts");

      let shown = Array.from(
        document.querySelectorAll("img, canvas, video, svg, iframe, embed, object"),
      ).some(
        (element) =>
          inView(element) &&
          element.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
      );

      if (!shown)
        walked.visit(null, true, true, {
          enter: () => (shown ? undefined : true),
          text: (node) => {
            shown ||= (node.textContent ?? "").trim() !== "";
          },
        });
      if (!shown) waiting.push("content");

      return waiting;
    });

  return { check };
};
