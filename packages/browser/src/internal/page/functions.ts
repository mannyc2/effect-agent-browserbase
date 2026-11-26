/**
 * What a page does behind the functions of its types' modules, such as `Snapshot.read`. `Page`
 * gains a member only for identity, order, time or input; everything else a page does is one of
 * these, which each page carries under `key`, and the modules' functions reach it there. `Page`'s
 * type names nothing callable there, so the functions are the only way in.
 */
import { type Effect, type Option, Predicate, type Scope } from "effect";

import type { BrowserError } from "../../BrowserError.ts";
import type { Box } from "../../BrowserEvent.ts";
import type { Changes, ChangesOptions } from "../../Change.ts";
import type {
  Capture,
  Frame,
  FrameOptions,
  Paint,
  Region,
  ScreencastOptions,
  Zoom,
} from "../../Frame.ts";
import type { Layout, Picks } from "../../Layout.ts";
import type { Overlay } from "../../Overlay.ts";
import type { Page } from "../../Page.ts";
import type { Held } from "../../PageTime.ts";
import type { Poses } from "../../Pose.ts";
import type {
  FindQuery,
  Found,
  Snapshot,
  SnapshotOptions,
  UntilResult,
  UntilWant,
} from "../../Snapshot.ts";
import type { Text, TextOptions } from "../../Text.ts";
import type { Window, WindowOptions } from "../../Window.ts";

export const key = "~effect-browser/Page";

export interface Functions {
  readonly snapshot: (options?: SnapshotOptions) => Effect.Effect<Snapshot, BrowserError>;
  readonly find: (query?: FindQuery) => Effect.Effect<ReadonlyArray<Found>, BrowserError>;
  readonly until: (
    query: FindQuery,
    want: UntilWant,
    millis: number,
  ) => Effect.Effect<UntilResult, BrowserError>;
  readonly text: (options?: TextOptions) => Effect.Effect<Text, BrowserError>;
  readonly layout: (picks: Picks) => Effect.Effect<Layout, BrowserError>;
  readonly changes: (options?: ChangesOptions) => Effect.Effect<Changes, BrowserError>;
  readonly window: (options: WindowOptions) => Effect.Effect<Window, BrowserError>;
  readonly overlay: Effect.Effect<Overlay, BrowserError, Scope.Scope>;
  readonly drawn: Effect.Effect<Option.Option<ReadonlyArray<Box>>>;
  readonly poses: Effect.Effect<Poses, BrowserError, Scope.Scope>;
  readonly hold: Effect.Effect<Held, BrowserError, Scope.Scope>;
  readonly frame: (options?: FrameOptions) => Effect.Effect<Frame, BrowserError>;
  readonly zoom: (
    region: Region,
    options?: Pick<FrameOptions, "quality" | "format" | "scale">,
  ) => Effect.Effect<Zoom, BrowserError>;
  readonly capture: (
    options?: ScreencastOptions,
  ) => Effect.Effect<Capture, BrowserError, Scope.Scope>;
  readonly recentFrames: Effect.Effect<ReadonlyArray<Frame>>;
  readonly paint: (options: Paint) => Effect.Effect<void, BrowserError, Scope.Scope>;
}

/** What a page carries under `key`: its functions, out of reach of any type outside this class. */
export class Implementation {
  readonly #functions: Functions;

  constructor(functions: Functions) {
    this.#functions = functions;
  }

  static functionsOf(page: Page): Functions {
    return page[key].#functions;
  }
}

/** What `page` does behind its types' modules' functions. */
export const functionsOf = (page: Page): Functions => Implementation.functionsOf(page);

/** A page, as the library made it: what `dual` tells from a function's other arguments. */
export const isPage = (value: unknown): value is Page => Predicate.hasProperty(value, key);
