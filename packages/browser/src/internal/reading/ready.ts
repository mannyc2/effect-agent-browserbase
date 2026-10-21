/** Document readiness and content quiet, independent of screen-capture features. */
import { Duration, Effect, Schedule } from "effect";

import { Timeout, failWith } from "../../BrowserError.ts";
import type { ReadyOptions } from "../../Page.ts";
import { type Bridge, scriptCall } from "../page/bridge.ts";
import { contextGone, decodeWith, type PageContext } from "../page/context.ts";
import { ReadinessSchema } from "./ready.inpage.ts";

export const make =
  (page: PageContext, bridge: Bridge) =>
  (options: ReadyOptions = {}) => {
    const timeout = options.timeout ?? Duration.seconds(15);

    // The page's own evidence, checked in the page until nothing is left or `until` has come.
    const settled = (until: number) =>
      Effect.suspend(() =>
        bridge.evaluate(
          "ready",
          scriptCall(
            "ready",
            Math.max(0, Math.round(until - page.now())),
            options.quietMillis ?? 0,
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
