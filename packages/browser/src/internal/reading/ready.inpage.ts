/**
 * In the page: whether it is ready to be shown, checked until it is or until a deadline. Its
 * document is parsed and has painted since, nothing that ends is animating in view, its fonts and
 * the images in view have loaded, nothing in view is marked busy (`aria-busy`), and the viewport
 * shows something: text, a canvas drawn on, a picture or drawing larger than an icon, a video or a
 * frame. So a canvas mounted blank, or a spinner alone, is still loading. A screen that only says
 * "Loading…" in words reads as ready, and a WebGL canvas drawn once, without keeping its drawing,
 * reads as blank. See `names.inpage.ts` for what a page-side part may use.
 */
import { Schema } from "effect";

import type { Texts } from "./text.inpage.ts";
import type { Walk } from "./walk.inpage.ts";

/** What the page is still waiting for; none when it is ready. */
export const ReadinessSchema = Schema.Array(
  Schema.Literals(["load", "paint", "animations", "images", "fonts", "busy", "content"]),
);

export type Readiness = typeof ReadinessSchema.Type;

export const ready = (walked: Walk, texts: Texts) => {
  const { inView, visible } = walked;
  // A canvas is read through a small copy: reading it directly would give it a context of ours.
  let copy: OffscreenCanvasRenderingContext2D | null | undefined;

  const boxed = (element: Element): boolean => {
    const rect = element.getBoundingClientRect();

    return rect.width * rect.height > 0 && inView(rect);
  };

  const showing = <E extends Element>(elements: Iterable<E>): Array<E> =>
    Array.from(elements).filter((element) => boxed(element) && visible(element));

  // A canvas mounted blank is transparent all over.
  const drawn = (canvas: HTMLCanvasElement): boolean => {
    copy ??= new OffscreenCanvas(32, 32).getContext("2d", { willReadFrequently: true });
    if (copy === null) return true;
    try {
      copy.clearRect(0, 0, 32, 32);
      copy.imageSmoothingQuality = "high";
      copy.drawImage(canvas, 0, 0, 32, 32);

      return new Uint32Array(copy.getImageData(0, 0, 32, 32).data.buffer).some(
        (pixel) => pixel !== 0,
      );
    } catch {
      // Another site's pictures in it keep it from being read, and it has drawn them.
      return true;
    }
  };

  // A picture the size of an icon, such as a spinner, says nothing has come yet. Text costs a
  // walk of the viewport, and a canvas a copy of it, so each is read only if needed.
  const content = (): boolean =>
    showing(document.querySelectorAll("video, iframe, embed, object")).length > 0 ||
    showing(document.querySelectorAll("img, svg")).some((picture) => {
      const { width, height } = picture.getBoundingClientRect();

      return width > 64 && height > 64;
    }) ||
    (texts.read({ ref: null, maxChars: 1, unmask: false })?.text ?? "") !== "" ||
    showing(document.querySelectorAll("canvas")).some(drawn);

  // A hidden document paints no frames, so it is not ready to be shown.
  const painted = (): Promise<boolean> => {
    const { promise, resolve } = Promise.withResolvers<boolean>();

    if (document.visibilityState === "hidden") resolve(false);
    else requestAnimationFrame(() => resolve(true));

    return promise;
  };

  // In a frame, before it is drawn: a canvas drawn every frame still holds its drawing then.
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
            boxed(effect.target)
          );
        })
      )
        waiting.push("animations");
      if (Array.from(document.images).some((image) => !image.complete && boxed(image)))
        waiting.push("images");
      if (document.fonts.status !== "loaded") waiting.push("fonts");
      if (showing(document.querySelectorAll("[aria-busy=true]")).length > 0) waiting.push("busy");
      if (!content()) waiting.push("content");

      return waiting;
    });

  /** Check until the page is ready, or for `millis`, and say what it is still waiting for. */
  const wait = async (millis: number): Promise<Readiness> => {
    const until = performance.now() + millis;

    for (;;) {
      const waiting = await check();

      if (waiting.length === 0 || performance.now() >= until) return waiting;
      const { promise, resolve } = Promise.withResolvers<void>();

      setTimeout(resolve, Math.min(50, until - performance.now()));
      await promise;
    }
  };

  return { wait };
};
