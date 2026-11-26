/**
 * Seed a deterministic page without executing page code or inferring browser effects, or give a
 * page pictures of a test's own.
 */
import type { Effect, Scope } from "effect";

import type { BrowserError } from "../BrowserError.ts";
import type * as Frame from "../Frame.ts";
import { functionsOf, Implementation, key } from "../internal/page/functions.ts";
import type { Page } from "../Page.ts";
import type { Seed } from "./internal/model.ts";
import { makeIn } from "./internal/page.ts";

export type { Seed, Element, ChangeTrack } from "./internal/model.ts";

export const make = (
  seed: Seed = {},
  options: { readonly id?: string; readonly session?: string; readonly connection?: string } = {},
) => makeIn(seed, options);

/** What a page's `Frame` functions read, each under its function's name. */
export interface Pictures {
  readonly read: (options?: Frame.FrameOptions) => Effect.Effect<Frame.Frame, BrowserError>;
  readonly zoom: (
    region: Frame.Region,
    options?: Pick<Frame.FrameOptions, "quality" | "format" | "scale">,
  ) => Effect.Effect<Frame.Zoom, BrowserError>;
  readonly capture: (
    options?: Frame.ScreencastOptions,
  ) => Effect.Effect<Frame.Capture, BrowserError, Scope.Scope>;
  readonly recent: Effect.Effect<ReadonlyArray<Frame.Frame>>;
  readonly paint: (options: Frame.Paint) => Effect.Effect<void, BrowserError, Scope.Scope>;
}

/**
 * A copy of `page` whose `Frame` functions read what `pictures` makes of its own, so a test can
 * watch what a reader took or give it pictures of its own making. The page's members are its own.
 */
export const withPictures = <P extends Page>(page: P, pictures: (own: Pictures) => Pictures): P => {
  const functions = functionsOf(page);

  const { read, zoom, capture, recent, paint } = pictures({
    read: functions.frame,
    zoom: functions.zoom,
    capture: functions.capture,
    recent: functions.recentFrames,
    paint: functions.paint,
  });

  return {
    ...page,
    [key]: new Implementation({
      ...functions,
      frame: read,
      zoom,
      capture,
      recentFrames: recent,
      paint,
    }),
  };
};
