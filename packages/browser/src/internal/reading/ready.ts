/** Document readiness and content quiet, independent of screen-capture features. */
import { Duration, Effect, Schedule, Schema } from "effect";

import { Timeout, failWith, refuse } from "../../BrowserError.ts";
import type { ReadyOptions } from "../../Page.ts";
import { millisOf } from "../clock.ts";
import { type Bridge, scriptCall } from "../page/bridge.ts";
import { contextGone, decodeWith, type PageContext } from "../page/context.ts";

/** What the page is still waiting for; none when it is ready. */
const ReadinessSchema = Schema.Array(
  Schema.Literals([
    "load",
    "paint",
    "animations",
    "images",
    "fonts",
    "busy",
    "content",
    "changing",
  ]),
);

export type Readiness = typeof ReadinessSchema.Type;

export const make =
  (page: PageContext, bridge: Bridge) =>
  (options: ReadyOptions = {}) => {
    const quietMillis = millisOf(options.quiet ?? 0);

    if (!Number.isFinite(quietMillis) || quietMillis < 0)
      return refuse("ready", "quiet must be a finite nonnegative duration");
    const timeout = options.timeout ?? Duration.seconds(15);

    // The page's own evidence, checked in the page until nothing is left or `until` has come.
    const settled = (until: number) =>
      Effect.suspend(() =>
        bridge.evaluate(
          "ready",
          scriptCall(
            "ready",
            Math.max(0, Math.round(until - page.now())),
            quietMillis,
            page.settings.pageTime ?? null,
          ),
        ),
      ).pipe(
        Effect.retry({ while: contextGone, schedule: Schedule.spaced(Duration.millis(10)) }),
        Effect.flatMap(decodeWith("ready", ReadinessSchema)),
        Effect.tap((waiting) => Effect.annotateCurrentSpan({ waiting: waiting.join(",") })),
        Effect.filterOrElse(
          (waiting) => waiting.length === 0,
          () => failWith("ready", new Timeout({ millis: Duration.toMillis(timeout) })),
        ),
      );

    return page.lane
      .read("ready")(Effect.void)
      .pipe(
        Effect.andThen(
          Effect.suspend(() => settled(page.now() + Duration.toMillis(timeout))).pipe(
            page.within("ready", timeout),
          ),
        ),
        page.span("Page.ready"),
        page.owned,
      );
  };
