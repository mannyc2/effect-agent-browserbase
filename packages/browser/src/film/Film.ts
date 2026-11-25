/**
 * Filming a page as a function of time: a new screenshot at each time a caller asks for, of the
 * page as it is at that film time, with what the caller draws over it then. Film time comes from
 * a held page (`Page.hold`), which steps to each frame however long the last one took, so a
 * frame costs one call to step the page and one screenshot; from a page that seeks itself; or
 * from real time. The frames are pictures; encoding them is the caller's.
 *
 * @since 0.3.0
 */
import { Clock, Duration, Effect, Schema, Stream } from "effect";

import { Action } from "../Action.ts";
import { type BrowserError, refuse } from "../BrowserError.ts";
import { monotonicMillis } from "../Clock.ts";
import { Image } from "../Frame.ts";
import { Point } from "../Geometry.ts";
import type { Content, Overlay } from "../Overlay.ts";
import { type Page, ResolvedTarget, type ScreenshotOptions } from "../Page.ts";
import type { Held, Step } from "../PageTime.ts";

/** What a frame shows over the page, and, on held time, where the page is scrolled to then. */
export type At = Step;

/** Frames at `fps` from `from` (0 by default) until before `to`, or at these times, in ms. */
export type Times =
  | { readonly fps: number; readonly from?: number | undefined; readonly to: number }
  | ReadonlyArray<number>;

/**
 * Where film time comes from: a held page, stepped to each frame; a page's own seek, given each
 * frame's time; or real time from the film's start, each frame taken when its time comes.
 */
export type Time =
  | Held
  | { readonly seek: (t: number) => Effect.Effect<void, BrowserError> }
  | "real";

export interface Options<E = never> {
  readonly times: Times;
  readonly time: Time;
  /** What the page shows at a film time: each frame's, and each input's. */
  readonly at?: ((t: number) => Effect.Effect<At, E>) | undefined;
  /**
   * Inputs sent at their film times, in time order, each before the first frame at or after it:
   * the page is moved to its time, and on held time it answers as its time is stepped on. One that
   * fails fails the film.
   */
  readonly inputs?: ReadonlyArray<Contact> | undefined;
  /** The page's overlay, open, that `at`'s drawings go to. */
  readonly overlay?: Overlay | undefined;
  readonly image?: Pick<ScreenshotOptions, "format" | "quality" | "scale"> | undefined;
  /** How many times a frame's screenshot is taken again after it times out. Defaults to 2. */
  readonly retries?: number | undefined;
}

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Millis = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

/** An input to send at film time `t`, in ms, with the caller's name for it. */
export const Contact = Schema.Struct({
  t: Millis,
  action: Action,
  label: Schema.optional(Schema.String),
});

export type Contact = typeof Contact.Type;

/** An input as it was sent, at its film time. */
export class Sent extends Schema.Class<Sent>("effect-browser/Sent")({
  t: Millis,
  label: Schema.optional(Schema.String),
  action: Action,
  /** What a click resolved its target to, before its input. */
  target: Schema.optional(ResolvedTarget),
  /** The page's document after it. */
  document: Count,
}) {}

/** One frame: its picture at film time `t`, in ms, and what taking it cost in real time. */
export class Shot extends Schema.Class<Shot>("effect-browser/Shot")({
  index: Count,
  t: Millis,
  image: Image,
  /** The page's document and address after the picture, as `Page.state` gives them. */
  document: Count,
  url: Schema.String,
  /** Where the document was scrolled to, in CSS pixels, on held time. */
  scroll: Schema.optional(Point),
  /** The inputs sent since the frame before. */
  sent: Schema.Array(Sent),
  /** Screenshots that timed out before this one. */
  retries: Count,
  /** Real milliseconds from the frame's start to its picture. */
  took: Millis,
}) {}

/** What a film cost, from its shots. */
export class Summary extends Schema.Class<Summary>("effect-browser/FilmSummary")({
  frames: Count,
  retries: Count,
  /** Real milliseconds, all frames' and the slowest one's. */
  took: Millis,
  slowest: Millis,
  /** Every input sent, in order. */
  sent: Schema.Array(Sent),
}) {}

const operation = "Film.frames";

function* rated(fps: number, from: number, to: number) {
  const count = Math.round(((to - from) * fps) / 1000);

  for (let index = 0; index < count; index++) yield from + (index * 1000) / fps;
}

const timesOf = (times: Times): Effect.Effect<Iterable<number>, BrowserError> => {
  if ("fps" in times) {
    const { fps, from = 0, to } = times;

    return [fps, from, to].every(Number.isFinite) && fps > 0 && from >= 0 && to >= from
      ? Effect.succeed(rated(fps, from, to))
      : refuse(
          operation,
          "a film's rate is positive and runs from a nonnegative time to a later one",
        );
  }

  return times.every(
    (t, index) => Number.isFinite(t) && t >= 0 && (index === 0 || t >= (times[index - 1] ?? t)),
  )
    ? Effect.succeed(times)
    : refuse(operation, "a film's times are finite, nonnegative and in order");
};

// The page moved to film time `t`, showing `at` there; `drawn` says whether to draw its overlay.
// On held time, it says where the document is scrolled to.
type Move = (t: number, at: At, drawn: boolean) => Effect.Effect<Point | undefined, BrowserError>;

const mover = (page: Page, time: Time, overlay: Overlay | undefined): Move => {
  if (typeof time === "object" && "advance" in time) {
    let now = 0;

    return (t, { scroll, overlay: content }, drawn) =>
      time.advance(Duration.millis(t - now), { scroll, overlay: drawn ? content : undefined }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            now = t;
          }),
        ),
      );
  }
  let start: number | undefined;

  const arrive =
    time === "real"
      ? (t: number) =>
          Effect.suspend(() => {
            const now = monotonicMillis(page.clock);

            start ??= now;

            return Effect.sleep(Duration.millis(Math.max(0, start + t - now))).pipe(
              Effect.provideService(Clock.Clock, page.clock),
            );
          })
      : time.seek;

  return (t, at, drawn) =>
    at.scroll === undefined
      ? arrive(t).pipe(
          Effect.andThen(
            drawn && at.overlay !== undefined && overlay !== undefined
              ? overlay.draw(at.overlay)
              : Effect.void,
          ),
          Effect.as(undefined),
        )
      : refuse(operation, "a film scrolls the page only on held time");
};

const keyOf = (content: Content | undefined) =>
  content === undefined ? undefined : content._tag === "Svg" ? `svg:${content.markup}` : "empty";

/**
 * Frames of `page` at `times`, one at a time: each moves the page to its film time, draws what
 * `at` gives there when it changed, and takes a new screenshot, again after one that times out.
 */
export const frames = <E = never>(
  page: Page,
  options: Options<E>,
): Stream.Stream<Shot, BrowserError | E> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const times = yield* timesOf(options.times);
      const retries = options.retries ?? 2;

      if (!Number.isSafeInteger(retries) || retries < 0)
        return yield* refuse(operation, "retries must be a nonnegative safe integer");
      const inputs = (options.inputs ?? []).toSorted((one, other) => one.t - other.t);

      if (!inputs.every(({ t }) => Number.isFinite(t) && t >= 0))
        return yield* refuse(operation, "an input's time is finite and nonnegative");
      let next = 0;
      const move = mover(page, options.time, options.overlay);
      const at = options.at ?? ((): Effect.Effect<At, E> => Effect.succeed({}));
      const now = () => monotonicMillis(page.clock);
      let shown: string | undefined;

      const send = ({ t, action, label }: Contact) =>
        Effect.gen(function* () {
          yield* move(t, yield* at(t), false);
          const done = yield* page.perform(action);
          const { document } = yield* page.state;
          const target = Schema.is(ResolvedTarget)(done) ? done : undefined;

          return new Sent({ t, label, action, target, document });
        });

      const shoot = (t: number, index: number) =>
        Effect.gen(function* () {
          const started = now();
          const sent: Array<Sent> = [];

          for (
            let input = inputs[next];
            input !== undefined && input.t <= t;
            input = inputs[++next]
          )
            sent.push(yield* send(input));
          const showing = yield* at(t);
          const key = keyOf(showing.overlay);

          if (key !== undefined && options.overlay === undefined)
            return yield* refuse(operation, "drawing needs the page's overlay, open, in `overlay`");
          const scroll = yield* move(t, showing, key !== undefined && key !== shown);

          shown = key ?? shown;
          let timedOut = 0;

          const image = yield* page.screenshot({ ...options.image, maxAge: 0 }).pipe(
            Effect.tapError((error) =>
              Effect.sync(() => (timedOut += error.reason._tag === "Timeout" ? 1 : 0)),
            ),
            Effect.retry({ times: retries, while: (error) => error.reason._tag === "Timeout" }),
          );

          const { document, url } = yield* page.state;

          return new Shot({
            index,
            t,
            image,
            document,
            url,
            scroll,
            sent,
            retries: timedOut,
            took: now() - started,
          });
        });

      return Stream.fromIterable(times).pipe(
        Stream.zipWithIndex,
        Stream.mapEffect(([t, index]) => shoot(t, index)),
      );
    }),
  );

/** Run a film's shots, which a caller has usually written out on the way, to what they cost. */
export const summary = <E, R>(shots: Stream.Stream<Shot, E, R>): Effect.Effect<Summary, E, R> =>
  Stream.runFold(
    shots,
    () => new Summary({ frames: 0, retries: 0, took: 0, slowest: 0, sent: [] }),
    (sum, shot) =>
      new Summary({
        frames: sum.frames + 1,
        retries: sum.retries + shot.retries,
        took: sum.took + shot.took,
        slowest: Math.max(sum.slowest, shot.took),
        sent: [...sum.sent, ...shot.sent],
      }),
  );
