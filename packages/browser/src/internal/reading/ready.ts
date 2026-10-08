/**
 * Waiting until a page is ready to be shown. The page's own evidence leads: one page-script call
 * that checks in the page until nothing is left to wait for, or the time is up. A caller that also
 * needs the screen still, such as after spinning a canvas game's reels, gives a quiet spell, and
 * the capture must then show no frame that long. A capture's silence cannot prove the last paint
 * arrived: a frame can be held on its way by a stalled connection, and Chromium sends frames only
 * while few acknowledgements are unanswered. So the spell counts only while every acknowledgement
 * is answered, and it ends with the page's evidence once more, whose answer comes behind every
 * frame sent before it: a frame that arrives first starts the spell again. Where the page's changes
 * are recorded, its evidence includes them: nothing in view may have changed for the spell, which a
 * DOM page's changes show better than its paint, and no stall on the way can hide.
 */
import { Duration, Effect, Schedule, Stream } from "effect";

import { Timeout } from "../../BrowserError.ts";
import type { ReadyOptions } from "../../Page.ts";
import { type Bridge, scriptCall } from "../page/bridge.ts";
import { decodeWith, failWith, type PageContext } from "../page/context.ts";
import type * as Capture from "../pictures/capture.ts";
import { ReadinessSchema } from "./ready.inpage.ts";

export const make =
  (page: PageContext, bridge: Bridge, capture: Capture.Controller) =>
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
        Effect.flatMap(decodeWith("ready", ReadinessSchema)),
        Effect.tap((waiting) => Effect.annotateCurrentSpan({ waiting: waiting.join(",") })),
        Effect.filterOrElse(
          (waiting) => waiting.length === 0,
          () => failWith("ready", new Timeout({ millis: Duration.toMillis(timeout) })),
        ),
      );

    // A capture the wait starts sends its first frame late, over half a second from a hosted
    // browser, so the spell counts from that frame (#202); Chrome sends one as a capture starts,
    // even of a still page.
    const quiet = (millis: number, until: number) =>
      Effect.gen(function* () {
        const running = yield* capture.active;
        let { received } = yield* capture.stats();
        let stirred = running ? page.now() : Number.POSITIVE_INFINITY;

        // How long the screen has been still: since a frame, or an unanswered acknowledgement.
        const look = Effect.map(capture.stats(), (stats) => {
          if (stats.received !== received || stats.ackBacklog > 0) {
            received = stats.received;
            stirred = page.now();
          }

          return page.now() - stirred;
        });

        const spell = Effect.repeat(look, {
          schedule: Schedule.spaced(Duration.millis(25)),
          until: (still) => still >= millis,
        });

        const capturing = running
          ? Effect.never
          : capture.stream().pipe(Stream.runDrain, Effect.andThen(Effect.never));

        const still = Effect.gen(function* () {
          for (;;) {
            yield* spell;
            const before = received;

            yield* settled(until);
            if ((yield* look) >= millis && received === before) return;
          }
        });

        return yield* Effect.raceFirst(capturing, still);
      });

    // The wait follows the action in flight, as a read does, but holds no later one back while it
    // watches the page settle, which can take its whole timeout.
    return page.lane
      .read("ready")(Effect.void)
      .pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const until = page.now() + Duration.toMillis(timeout);

            yield* settled(until);
            if (options.quietMillis !== undefined) yield* quiet(options.quietMillis, until);
          }).pipe(page.within("ready", timeout)),
        ),
        page.span("Page.ready"),
        page.owned,
      );
  };
