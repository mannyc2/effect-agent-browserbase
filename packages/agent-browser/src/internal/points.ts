/**
 * Where the pointer tools act: a model's point or ref as a target, points and regions read from a
 * picture of another scale on the viewport, and the crops that placement by crop shows.
 */
import { Option } from "effect";
import * as Page from "effect-browser/Page";

// A point is the more specific of the two, such as a spot on a canvas a ref names.
export const target = (place: {
  readonly ref?: string | undefined;
  readonly x?: number | undefined;
  readonly y?: number | undefined;
}): Option.Option<Page.Target> =>
  place.x !== undefined && place.y !== undefined
    ? Option.some({ x: place.x, y: place.y })
    : place.ref === undefined
      ? Option.none()
      : Option.some(place.ref);

// A target the model read from a picture of `scale` pixels to a CSS pixel, on the viewport.
export const viewportTarget = (to: Page.Target, scale: number): Page.Target =>
  typeof to === "string" ? to : { x: to.x / scale, y: to.y / scale };

// A region read from such a picture, in the whole CSS pixels that hold it within the viewport.
export const viewportRegion = (region: Page.Region, scale: number) => {
  const x = Math.floor(region.x / scale);
  const y = Math.floor(region.y / scale);

  return new Page.Region({
    x,
    y,
    width: Math.max(1, Math.floor((region.x + region.width) / scale) - x),
    height: Math.max(1, Math.floor((region.y + region.height) / scale) - y),
  });
};

export const named = (to: Page.Target) => (typeof to === "string" ? to : `(${to.x}, ${to.y})`);

// The 200x120 region around a point, within a viewport at least that size.
export const around = (
  point: Page.Point,
  viewport: { readonly width: number; readonly height: number },
) =>
  new Page.Region({
    x: Math.round(Math.min(Math.max(point.x - 100, 0), Math.max(viewport.width - 200, 0))),
    y: Math.round(Math.min(Math.max(point.y - 60, 0), Math.max(viewport.height - 120, 0))),
    width: 200,
    height: 120,
  });

export const holds = ({ region }: Page.Zoom, point: Page.Point) =>
  point.x >= region.x &&
  point.y >= region.y &&
  point.x <= region.x + region.width &&
  point.y <= region.y + region.height;
