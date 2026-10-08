/**
 * A page's window over its three tracks on the browser's host clock: the events and frames it
 * keeps, at no call, and one read of its changes, the first starting its record. A read that fails
 * is missing, with why, and the window is still made.
 */
import { Duration, Effect, Option, Result, Schema } from "effect";

import { type BrowserError, InvalidRequest } from "../../BrowserError.ts";
import { type BrowserEvent, TrackEvent } from "../../BrowserEvent.ts";
import type { Changes } from "../../Change.ts";
import { Frame } from "../../Frame.ts";
import { Window } from "../../Moment.ts";
import type { ChangesOptions, WindowOptions } from "../../Page.ts";
import { failWith, type PageContext } from "../page/context.ts";

const isWindow = Schema.is(Window);
const isFrame = Schema.is(Frame);
const isTrackEvent = Schema.is(TrackEvent);

/**
 * Where a window asked at `now` starts and ends: never after now, nor starting after it ends.
 * Nothing for a bound that is not finite, or a negative reach back.
 */
export const boundsOf = ({ since, until }: Pick<WindowOptions, "since" | "until">, now: number) => {
  const end = until === undefined ? now : isFrame(until) ? until.hostTime : Math.min(until, now);

  const start = isWindow(since)
    ? since.until
    : isFrame(since)
      ? since.hostTime
      : !Duration.isDuration(since)
        ? since
        : Duration.isNegative(since)
          ? Number.NaN
          : end - Duration.toMillis(since);

  return Number.isFinite(start) && Number.isFinite(end)
    ? Option.some({ since: Math.min(start, end), until: end })
    : Option.none();
};

/**
 * A window's share of the kept tracks: events after its start, frames painted from it, both up to
 * its end, so consecutive windows hold each event once and the next begins with the frame the last
 * ended on. Pointer, key and wheel input is the presentation track, not an event here.
 */
export const within = (
  { since, until }: { readonly since: number; readonly until: number },
  events: ReadonlyArray<BrowserEvent>,
  frames: ReadonlyArray<Frame>,
) => ({
  events: events.filter((event) => event.at > since && event.at <= until && !isTrackEvent(event)),
  frames: frames.filter((frame) => frame.hostTime >= since && frame.hostTime <= until),
});

export const make =
  (
    page: PageContext,
    read: (options: ChangesOptions) => Effect.Effect<Changes, BrowserError>,
    frames: Effect.Effect<ReadonlyArray<Frame>>,
  ) =>
  ({ since, until, unmask }: WindowOptions) =>
    Effect.gen(function* () {
      const asked = boundsOf({ since, until }, page.now());

      if (Option.isNone(asked))
        return yield* failWith(
          "window",
          new InvalidRequest({
            detail: "a window's bounds must be finite, its reach not negative",
          }),
        );
      const bounds = asked.value;

      // A previous window's changes go on exactly where they ended, on the page's own clock, and a
      // frame bounds them at its paint, so that they hold nothing it does not show.
      const changes = yield* Effect.result(
        read({
          since: isWindow(since)
            ? (since.changes ?? bounds.since)
            : isFrame(since)
              ? since
              : bounds.since,
          until: isFrame(until) ? until : bounds.until,
          unmask,
        }),
      );

      return new Window({
        page: page.id,
        ...bounds,
        ...within(bounds, yield* page.recentEvents, yield* frames),
        changes: Result.getOrUndefined(changes),
        missing: Option.toArray(Result.getFailure(changes)),
      });
    }).pipe(page.span("Page.window"), page.owned);
