/**
 * In the page: whether it is ready to be shown. Its document is parsed and has painted since,
 * nothing that ends is animating in view, its fonts and the images in view have loaded, and the
 * viewport shows something: text, or a picture, canvas, video, drawing or frame. See
 * `names.inpage.ts` for what a page-side part may use.
 */
import { Schema } from "effect";

import type { Texts } from "./text.inpage.ts";

/** What the page is still waiting for; none when it is ready. */
export const ReadinessSchema = Schema.Array(
  Schema.Literals(["load", "paint", "animations", "images", "fonts", "content"]),
);

export type Readiness = typeof ReadinessSchema.Type;

export const ready = (texts: Texts) => {
  const inView = (element: Element): boolean => {
    const { width, height, right, bottom, left, top } = element.getBoundingClientRect();

    return width * height > 0 && right > 0 && bottom > 0 && left < innerWidth && top < innerHeight;
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

      if (!shown) {
        const read = texts.read({ ref: null, maxChars: 1, unmask: false });

        shown = read !== null && read.text !== "";
      }
      if (!shown) waiting.push("content");

      return waiting;
    });

  return { check };
};
