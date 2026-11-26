/**
 * Filming a page as a function of time: a new screenshot at each time a caller asks for, of the
 * page as it is at that film time, with what the caller draws over it then. Film time comes from
 * a held page (`PageTime.hold`), which steps to each frame however long the last one took, so a
 * frame costs one call to step the page and one screenshot; from a page that seeks itself; or
 * from real time. The frames are pictures; encoding them is the caller's.
 *
 * Loading takes real time, so a film holds its time while the page loads a new document: the
 * first frame that finds one waits for it to be ready, measures its layout, and says so as a
 * `Passage`, which `at` sees from then on. On real time the film's start moves on by the wait.
 *
 * @stability experimental
 * @since 0.3.0
 */
import { Clock, Duration, Effect, Function, Schema, Stream } from "effect";

import { Action } from "../Action.ts";
import { type BrowserError, refuse } from "../BrowserError.ts";
import * as Frame from "../Frame.ts";
import { monotonicMillis } from "../internal/clock.ts";
import { Point } from "../internal/geometry.ts";
import * as Layout from "../Layout.ts";
import type { Content, Overlay } from "../Overlay.ts";
import { type Page, ResolvedTarget } from "../Page.ts";
import type { Held, Step } from "../PageTime.ts";

/**
 * What a frame shows over the page, and, on held time, where the page is scrolled to then and how
 * its elements are posed, with the page's poses open.
 *
 * @stability experimental
 * @category models
 * @since 0.3.0
 */
export type At = Step;

/**
 * Frames at `fps` from `from` (0 by default) until before `to`, or at these times, in ms.
 *
 * @stability experimental
 * @category models
 * @since 0.3.0
 */
export type Times =
  | { readonly fps: number; readonly from?: number | undefined; readonly to: number }
  | ReadonlyArray<number>;

/**
 * Where film time comes from: a held page, stepped to each frame; a page's own seek, given each
 * frame's time; or real time from the film's start, each frame taken when its time comes.
 *
 * @stability experimental
 * @category models
 * @since 0.3.0
 */
export type Time =
  | Held
  | { readonly seek: (t: number) => Effect.Effect<void, BrowserError> }
  | "real";

/**
 * @stability experimental
 * @category options
 * @since 0.3.0
 */
export interface Options<E = never> {
  readonly times: Times;
  readonly time: Time;
  /** What the page shows at a film time, each frame's and each input's, from the passages so far. */
  readonly at?:
    | ((t: number, film: { readonly passages: ReadonlyArray<Passage> }) => Effect.Effect<At, E>)
    | undefined;
  /** What to measure in each new document the film arrives in. */
  readonly picks?: Layout.Picks | undefined;
  /**
   * Inputs sent at their film times, in time order, each before the first frame at or after it:
   * the page is moved to its time, and on held time it answers as its time is stepped on. One that
   * fails fails the film.
   */
  readonly inputs?: ReadonlyArray<Contact> | undefined;
  /** The page's overlay, open, that `at`'s drawings go to. */
  readonly overlay?: Overlay | undefined;
  /**
   * How each frame is taken. For frames with more pixels than the layout, paint the page first
   * (`Frame.paint`) and take them at `scale: "device"`.
   */
  readonly image?: Pick<Frame.FrameOptions, "format" | "quality" | "scale"> | undefined;
  /** How many times a frame's screenshot is taken again after it times out. Defaults to 2. */
  readonly retries?: number | undefined;
}

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Millis = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * An input to send at film time `t`, in ms, with the caller's name for it.
 *
 * @stability experimental
 * @category schemas
 * @since 0.3.0
 */
export const Contact = Schema.Struct({
  t: Millis,
  action: Action,
  label: Schema.optional(Schema.String),
});

/**
 * @stability experimental
 * @category models
 * @since 0.3.0
 */
export type Contact = typeof Contact.Type;

/**
 * An input as it was sent, at its film time.
 *
 * @stability experimental
 * @category schemas
 * @since 0.3.0
 */
export class Sent extends Schema.Class<Sent>("effect-browser/presentation/Film/Sent")({
  t: Millis,
  label: Schema.optional(Schema.String),
  action: Action,
  /** What a click resolved its target to, before its input. */
  target: Schema.optional(ResolvedTarget),
  /** The page's document after it. */
  document: Count,
}) {}

/**
 * The page's move to a new document, at the film time of the first frame that found it.
 *
 * @stability experimental
 * @category schemas
 * @since 0.3.0
 */
export class Passage extends Schema.Class<Passage>("effect-browser/presentation/Film/Passage")({
  t: Millis,
  /** The address of the document it left. */
  left: Schema.String,
  document: Count,
  url: Schema.String,
  /** Real milliseconds from the film's last step on the page before to the document's being ready. */
  loadedAfter: Millis,
  /** The new document's layout, ready, with the film's `picks`. */
  layout: Layout.Layout,
}) {}

/**
 * One frame: its picture at film time `t`, in ms, and what taking it cost in real time.
 *
 * @stability experimental
 * @category schemas
 * @since 0.3.0
 */
export class Shot extends Schema.Class<Shot>("effect-browser/presentation/Film/Shot")({
  index: Count,
  t: Millis,
  image: Frame.Image,
  /** The page's document and address after the picture, as `Page.state` gives them. */
  document: Count,
  url: Schema.String,
  /** Where the document was scrolled to, in CSS pixels, on held time. */
  scroll: Schema.optional(Point),
  /** The inputs sent since the frame before. */
  sent: Schema.Array(Sent),
  /** The new document this frame was the first to find. */
  passage: Schema.optional(Passage),
  /** Screenshots that timed out before this one. */
  retries: Count,
  /** Real milliseconds from the frame's start to its picture. */
  took: Millis,
  /**
   * When its picture was taken, in host monotonic milliseconds on the browser's clock, as a
   * `Change`'s times are. On held time, the first shot at or after a change's `at` is the first
   * that shows it; on real time, the page may change while it is pictured.
   */
  at: Schema.Finite,
}) {}

/**
 * What a film cost, from its shots.
 *
 * @stability experimental
 * @category schemas
 * @since 0.3.0
 */
export class Summary extends Schema.Class<Summary>("effect-browser/presentation/Film/Summary")({
  frames: Count,
  retries: Count,
  /** Real milliseconds, all frames' and the slowest one's. */
  took: Millis,
  slowest: Millis,
  /** Every input sent, and every passage, in order. */
  sent: Schema.Array(Sent),
  passages: Schema.Array(Passage),
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

// `move` takes the page to film time `t`, showing `at` there; `drawn` says whether to draw its
// overlay. On held time, it says where the document is scrolled to. `skip` leaves real time that
// film time does not count.
interface Mover {
  readonly move: (
    t: number,
    at: At,
    drawn: boolean,
  ) => Effect.Effect<Point | undefined, BrowserError>;
  readonly skip: (millis: number) => void;
}

const mover = (page: Page, time: Time, overlay: Overlay | undefined): Mover => {
  if (typeof time === "object" && "advance" in time) {
    let now = 0;

    const move: Mover["move"] = (t, { scroll, poses, overlay: content }, drawn) =>
      time
        .advance(Duration.millis(t - now), {
          scroll,
          poses,
          overlay: drawn ? content : undefined,
        })
        .pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              now = t;
            }),
          ),
        );

    return { move, skip: () => undefined };
  }
  let start: number | undefined;

  const arrive =
    time === "real"
      ? (t: number) =>
          Effect.suspend(() => {
            const now = monotonicMillis(page.hostClock);

            start ??= now;

            return Effect.sleep(Duration.millis(Math.max(0, start + t - now))).pipe(
              Effect.provideService(Clock.Clock, page.hostClock),
            );
          })
      : time.seek;

  const move: Mover["move"] = (t, at, drawn) =>
    at.scroll === undefined && at.poses === undefined
      ? arrive(t).pipe(
          Effect.andThen(
            drawn && at.overlay !== undefined && overlay !== undefined
              ? overlay.draw(at.overlay)
              : Effect.void,
          ),
          Effect.as(undefined),
        )
      : refuse(operation, "a film scrolls and poses the page only on held time");

  return {
    move,
    skip: (millis) => {
      if (start !== undefined) start += millis;
    },
  };
};

// A new screenshot, taken again after one that times out, with how many did.
const picture = (page: Page, image: Options["image"], retries: number) =>
  Effect.gen(function* () {
    let timedOut = 0;

    const taken = yield* Frame.read(page, { ...image, maxAge: 0 }).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => (timedOut += error.reason._tag === "Timeout" ? 1 : 0)),
      ),
      Effect.retry({ times: retries, while: (error) => error.reason._tag === "Timeout" }),
    );

    return { image: taken.image, retries: timedOut };
  });

const keyOf = (content: Content | undefined) =>
  content === undefined ? undefined : content._tag === "Svg" ? `svg:${content.markup}` : "empty";

const film = <E = never>(page: Page, options: Options<E>): Stream.Stream<Shot, BrowserError | E> =>
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
      const { move, skip } = mover(page, options.time, options.overlay);
      const now = () => monotonicMillis(page.hostClock);
      const passages: Array<Passage> = [];

      const at = (t: number) =>
        options.at === undefined ? Effect.succeed<At>({}) : options.at(t, { passages });

      let shown: string | undefined;
      let { document: seen, url: was } = yield* page.state;
      let stepped = now();

      // Take the page to film time `t`, and note when, as a passage's wait counts from it.
      const step = (t: number, showing: At, drawn: boolean) =>
        Effect.tap(move(t, showing, drawn), () => Effect.sync(() => (stepped = now())));

      // A document the page moved to since the last frame, once it is ready.
      const arrival = (t: number) =>
        Effect.gen(function* () {
          const { document, url } = yield* page.state;

          if (document === seen) return undefined;
          yield* page.ready();
          const layout = yield* Layout.measure(page, options.picks ?? {});
          const loadedAfter = now() - stepped;

          skip(loadedAfter);
          const passage = new Passage({ t, left: was, document, url, loadedAfter, layout });

          [seen, was] = [document, url];
          passages.push(passage);

          return passage;
        });

      const send = ({ t, action, label }: Contact) =>
        Effect.gen(function* () {
          yield* step(t, yield* at(t), false);
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
          const passage = yield* arrival(t);
          const showing = yield* at(t);
          const key = keyOf(showing.overlay);

          if (key !== undefined && options.overlay === undefined)
            return yield* refuse(operation, "drawing needs the page's overlay, open, in `overlay`");
          const scroll = yield* step(t, showing, key !== undefined && key !== shown);

          shown = key ?? shown;
          const taken = yield* picture(page, options.image, retries);
          const pictured = now();
          const { document, url } = yield* page.state;

          return new Shot({
            index,
            t,
            image: taken.image,
            document,
            url,
            scroll,
            sent,
            passage,
            retries: taken.retries,
            took: pictured - started,
            at: pictured,
          });
        });

      return Stream.fromIterable(times).pipe(
        Stream.zipWithIndex,
        Stream.mapEffect(([t, index]) => shoot(t, index)),
      );
    }),
  );

/**
 * Frames of `page` at `times`, one at a time: each moves the page to its film time, draws what
 * `at` gives there when it changed, and takes a new screenshot, again after one that times out.
 *
 * @stability experimental
 * @category constructors
 * @since 0.3.0
 */
export const frames: {
  <E = never>(options: Options<E>): (page: Page) => Stream.Stream<Shot, BrowserError | E>;
  <E = never>(page: Page, options: Options<E>): Stream.Stream<Shot, BrowserError | E>;
} = Function.dual(2, film);

/**
 * Run a film's shots, which a caller has usually written out on the way, to what they cost.
 *
 * @stability experimental
 * @category combinators
 * @since 0.3.0
 */
export const summary = <E, R>(shots: Stream.Stream<Shot, E, R>): Effect.Effect<Summary, E, R> =>
  Stream.runFold(
    shots,
    () => new Summary({ frames: 0, retries: 0, took: 0, slowest: 0, sent: [], passages: [] }),
    (sum, shot) =>
      new Summary({
        frames: sum.frames + 1,
        retries: sum.retries + shot.retries,
        took: sum.took + shot.took,
        slowest: Math.max(sum.slowest, shot.took),
        sent: [...sum.sent, ...shot.sent],
        passages: shot.passage === undefined ? sum.passages : [...sum.passages, shot.passage],
      }),
  );
