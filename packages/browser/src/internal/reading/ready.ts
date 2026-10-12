/**
 * Waiting until a page is ready to be shown. The page's own evidence leads: one page-script call
 * that checks in the page until nothing is left to wait for, or the time is up. A caller that also
 * needs the screen still, such as after spinning a canvas game's reels, gives a quiet spell, and
 * the capture must then show no frame that long. A capture's silence cannot prove the last paint
 * arrived: a frame can be held on its way by a stalled connection, and Chromium sends frames only
 * while few acknowledgements are unanswered. So the spell counts only while every acknowledgement
 * is answered, and it ends with the page's evidence once more and, where the capture runs on a
 * connection of its own, a round trip there: each answer comes behind every frame sent before it on
 * its connection, and a frame that arrives first starts the spell again. Where the page's changes
 * are recorded, its evidence includes them: nothing in view may have changed for the spell, which a
 * DOM page's changes show better than its paint, and no stall on the way can hide. Content
 * stillness starts that record itself and ignores capture silence. Foreground stillness lets
 * frames keep coming but compares them, so that only motion outside what was moving before the
 * page's latest input counts; it still waits out unanswered acknowledgements while no frame
 * comes, and its last look follows the round trip too. Each new document starts a
 * new observation, while retries of destroyed script contexts share the caller's deadline.
 */
import { Duration, Effect, Option, Schedule, Stream } from "effect";

import { Failed, Timeout } from "../../BrowserError.ts";
import type { Frame } from "../../Frame.ts";
import type { ReadyOptions } from "../../Page.ts";
import { type Bridge, scriptCall } from "../page/bridge.ts";
import {
  contextGone,
  decodeWith,
  failWith,
  type PageContext,
  undispatched,
} from "../page/context.ts";
import type * as Capture from "../pictures/capture.ts";
import * as Motion from "../pictures/motion.ts";
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
            options.still === "content",
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

    // A capture the wait starts sends its first frame late, over half a second from a hosted
    // browser, so the spell counts from that frame (#202); Chrome sends one as a capture starts,
    // even of a still page.
    const quiet = (millis: number, until: number) =>
      Effect.gen(function* () {
        const running = yield* capture.active;
        const foreground = options.still === "foreground";
        let counts = yield* capture.stats();
        let stirred = running ? page.now() : Number.POSITIVE_INFINITY;
        let reference: Motion.Picture | undefined;

        const decoded = (frame: Frame) =>
          Effect.try({
            try: () => Motion.picture(frame),
            catch: (error) =>
              undispatched("ready", new Failed({ detail: `no picture: ${String(error)}` })),
          });

        // The background: what moved in up to eight frames of the document's 1.5 s before its
        // latest input, as far back as the capture keeps them.
        const { inputAt } = page.activity;
        const document = Option.getOrUndefined(yield* capture.latest)?.document;

        const before = (foreground ? yield* capture.recent : []).filter(
          (frame) =>
            frame.hostTime < inputAt &&
            frame.hostTime >= inputAt - 1500 &&
            frame.document === document,
        );

        const sampled = before.filter((_, index) => index % Math.ceil(before.length / 8) === 0);
        const mask = Motion.background(yield* Effect.forEach(sampled, decoded));

        // How long the screen has been still: since a frame, or an unanswered acknowledgement. In
        // the foreground, since a frame moved outside the background, or acknowledgements went
        // unanswered with no frame coming.
        const look = Effect.gen(function* () {
          const stats = yield* capture.stats();
          const latest = Option.getOrUndefined(yield* capture.latest);
          const arrived = stats.received !== counts.received;
          const unseen = stats.accepted - counts.accepted;

          counts = stats;
          if (latest === undefined || !capture.current(latest)) stirred = page.now();
          else if (!foreground ? arrived || stats.ackBacklog > 0 : !arrived && stats.ackBacklog > 0)
            stirred = page.now();
          else if (foreground && (unseen > 0 || reference === undefined)) {
            // A move and its return between looks both count. Bound decoding; any frames lost
            // from history, or beyond this batch, deny a quiet spell rather than hiding motion.
            const frames = (yield* capture.recent).slice(-Math.max(1, Math.min(8, unseen)));

            if (unseen > frames.length) stirred = page.now();
            for (const frame of frames) {
              const seen = yield* decoded(frame);

              if (reference === undefined || Motion.stirs(reference, seen, mask)) {
                reference = seen;
                stirred = page.now();
              }
            }
          }

          return page.now() - stirred;
        });

        // Decode at a fixed cadence: adding a delay after a full batch lets its backlog grow.
        const spell = Effect.repeat(look, {
          schedule: Schedule.fixed(Duration.millis(foreground ? 100 : 25)),
          until: (still) => still >= millis,
        });

        const capturing = running
          ? Effect.never
          : capture.stream().pipe(Stream.runDrain, Effect.andThen(Effect.never));

        const still = Effect.gen(function* () {
          for (;;) {
            yield* spell;
            const before = counts.received;

            yield* Effect.all([settled(until), capture.sync], { concurrency: 2, discard: true });
            if ((yield* look) >= millis && (foreground || counts.received === before)) return;
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

            if (options.still === "content") yield* bridge.registerRecorder("ready");
            yield* settled(until);
            if (options.quietMillis !== undefined && options.still !== "content")
              yield* quiet(options.quietMillis, until);
          }).pipe(page.within("ready", timeout)),
        ),
        page.span("Page.ready"),
        page.owned,
      );
  };
