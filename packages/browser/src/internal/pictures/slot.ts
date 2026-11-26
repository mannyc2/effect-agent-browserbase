/** The pictures a page keeps for `Frame`'s functions, which reach them through its slot. */
import type { Effect, Scope } from "effect";

import type { BrowserError } from "../../BrowserError.ts";
import type {
  Capture,
  Frame,
  FrameOptions,
  Paint,
  Region,
  ScreencastOptions,
  Zoom,
} from "../../Frame.ts";
import * as Slot from "../page/slot.ts";

export interface Pictures {
  readonly read: (options?: FrameOptions) => Effect.Effect<Frame, BrowserError>;
  readonly zoom: (
    region: Region,
    options?: Pick<FrameOptions, "quality" | "format" | "scale">,
  ) => Effect.Effect<Zoom, BrowserError>;
  readonly capture: (
    options?: ScreencastOptions,
  ) => Effect.Effect<Capture, BrowserError, Scope.Scope>;
  readonly recent: Effect.Effect<ReadonlyArray<Frame>>;
  readonly paint: (options: Paint) => Effect.Effect<void, BrowserError, Scope.Scope>;
}

export const Pictures = Slot.make<Pictures>("pictures");
