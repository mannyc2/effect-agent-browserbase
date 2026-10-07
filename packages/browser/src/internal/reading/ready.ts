/**
 * Waiting until a page is ready to be shown. The page's own evidence leads: one page-script call,
 * repeated until the page has nothing left to wait for. A caller that also needs the screen still,
 * such as after spinning a canvas game's reels, gives a quiet spell, and frames must then stay
 * away that long. Once the change record runs (phase 2), nothing in view changing for the spell
 * joins the frames here, which a DOM page's changes show better than its paint.
 */
import { Duration, Effect, Schedule, Sink, Stream } from "effect";

import { Timeout } from "../../BrowserError.ts";
import type { Frame } from "../../Frame.ts";
import type { ReadyOptions } from "../../Page.ts";
import { type Bridge, scriptCall } from "../page/bridge.ts";
import { decodeWith, failWith, type PageContext } from "../page/context.ts";
import type * as Capture from "../pictures/capture.ts";
import { ReadinessSchema } from "./ready.inpage.ts";

export const make =
  (page: PageContext, bridge: Bridge, capture: Capture.Controller) =>
  (options: ReadyOptions = {}) => {
    const timeout = options.timeout ?? Duration.seconds(15);

    const evidence = bridge.evaluate("ready", scriptCall("ready")).pipe(
      Effect.flatMap(decodeWith("ready", ReadinessSchema)),
      Effect.tap((waiting) => Effect.annotateCurrentSpan({ waiting: waiting.join(",") })),
    );

    const still = <E>(frames: Stream.Stream<Frame, E>, quiet: number) =>
      frames.pipe(Stream.timeout(Duration.millis(quiet)), Stream.runDrain);

    // A running capture's silence means nothing was painted for the spell. A capture the wait
    // starts sends its first frame late, over half a second from a hosted browser, so the spell
    // counts from that frame (#202); Chrome sends one as a capture starts, even of a still page.
    const quiet = (millis: number) =>
      capture.active.pipe(
        Effect.flatMap((running) =>
          running
            ? still(capture.stream(), millis)
            : Stream.peel(capture.stream(), Sink.take(1)).pipe(
                Effect.flatMap(([, rest]) => still(rest, millis)),
                Effect.scoped,
              ),
        ),
      );

    return evidence.pipe(
      Effect.repeat({
        schedule: Schedule.spaced(Duration.millis(100)),
        until: (waiting) => waiting.length === 0,
      }),
      Effect.andThen(options.quietMillis === undefined ? Effect.void : quiet(options.quietMillis)),
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () => failWith("ready", new Timeout({ millis: Duration.toMillis(timeout) })),
      }),
      page.span("Page.ready"),
      page.owned,
    );
  };
