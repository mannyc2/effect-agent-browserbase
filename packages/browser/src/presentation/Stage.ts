/**
 * An output's capture ownership. Cue a page while preparing an event; commit when that event
 * happens. A prepared cue belongs to its caller's scope, and a committed one to the stage.
 * Commits serialize, drain old-page input and refuse stale first frames. `shown` distinguishes
 * confirmed silence, uncertain silence and loss without treating capture silence as evidence.
 * All pages of a stage must share one owning clock; timestamps from unrelated clocks cannot mix.
 * @since 0.3.0
 */
import {
  Cause,
  Clock,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Option,
  PubSub,
  Result,
  Schedule,
  Schema,
  Scope,
  Stream,
} from "effect";

import {
  type BrowserError,
  consequence,
  failWith,
  InvalidRequest,
  refuse,
  Timeout,
  undispatched,
} from "../BrowserError.ts";
import { monotonicMillis } from "../Clock.ts";
import type { CaptureStats, Frame, ScreencastOptions } from "../Frame.ts";
import type { Capture, Page } from "../Page.ts";
import * as Lifecycle from "./feed.ts";

export interface Options extends ScreencastOptions {
  /** Bound for each first-frame wait. Defaults to 5 seconds. */
  readonly firstFrame?: Duration.Input | undefined;
}

/** A switch that took effect, on the clock shared by browser events and frames. */
export class Presented extends Schema.Class<Presented>("effect-browser/Presented")({
  page: Schema.String,
  at: Schema.Finite,
  latency: Schema.Finite,
}) {}

export interface Cue {
  readonly page: Page;
  /** A frame of the current document, or the capture's failure or first-frame timeout. */
  readonly ready: Effect.Effect<void, BrowserError>;
  /** Commit on the event's host time, or now. Interruption before switching leaves the cue usable. */
  readonly commit: (options?: {
    readonly at?: number | undefined;
  }) => Effect.Effect<Presented, BrowserError>;
}

/** What the output establishes at nondecreasing host times; frames retain their capture times. */
export type Shown =
  | { readonly _tag: "Painted"; readonly frame: Frame; readonly at: number }
  | { readonly _tag: "Still"; readonly frame: Frame; readonly at: number }
  | { readonly _tag: "Stalled"; readonly frame: Frame; readonly at: number }
  | { readonly _tag: "Gone"; readonly page: string; readonly at: number };

export interface Stage {
  readonly present: (
    page: Page,
    options?: { readonly at?: number | undefined },
  ) => Effect.Effect<Presented, BrowserError>;
  readonly cue: (page: Page) => Effect.Effect<Cue, BrowserError, Scope.Scope>;
  /** Paint and, after every finite positive hold without paint, current evidence or loss. */
  readonly shown: (options: {
    readonly hold: Duration.Input;
  }) => Stream.Stream<Shown, BrowserError>;
  /** Capture-timed current-page paint; use `shown` for output time. Readers retain 16 frames. */
  readonly frames: Stream.Stream<Frame>;
  readonly current: Effect.Effect<Option.Option<Page>>;
  readonly stats: (options?: {
    readonly window?: Duration.Input | undefined;
  }) => Effect.Effect<Option.Option<CaptureStats>, BrowserError>;
}

interface Feed {
  readonly page: Page;
  capture: Capture | undefined;
  readonly scope: Scope.Closeable;
  readonly changed: PubSub.PubSub<Frame>;
  state: Lifecycle.State;
  fiber: Fiber.Fiber<void, BrowserError> | undefined;
}
interface Paint {
  readonly feed: Feed;
  readonly frame: Frame;
  readonly at: number;
}

interface Evidence {
  readonly feed: Feed;
  readonly frame: Frame;
  readonly value: Shown;
}

const unavailable = () =>
  undispatched("cue", new InvalidRequest({ detail: "the cue's capture is no longer available" }));

/** The sole writer of a cue's capture lifecycle; presentation ownership belongs to the stage. */
const update = (feed: Feed, input: Lifecycle.Input) => {
  feed.state = Lifecycle.step(feed.state, input);
};

const restartable = (error: BrowserError) => {
  const { lost, repeat } = consequence(error);

  return lost === "nothing" && repeat !== "pointless";
};

const stop = (feed: Feed) =>
  Effect.suspend(() => {
    update(feed, { _tag: "Stop" });

    return Scope.close(feed.scope, Exit.void);
  });

const frameOf = (feed: Feed) => {
  const frame = feed.state._tag === "Ready" ? feed.state.latest : undefined;

  return frame !== undefined && feed.capture?.isCurrent(frame) ? frame : undefined;
};

const ended = (feed: Feed): Effect.Effect<never, BrowserError> =>
  feed.fiber === undefined
    ? Effect.never
    : Fiber.await(feed.fiber).pipe(
        Effect.flatMap((exit) =>
          Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
            ? Effect.failCause(exit.cause)
            : Effect.fail(unavailable()),
        ),
      );

const firstOf = (feed: Feed, wait: Duration.Duration) =>
  Effect.suspend(() => {
    if (feed.state._tag === "Stopped") return Effect.fail(unavailable());
    if (frameOf(feed) !== undefined) return Effect.void;

    return Effect.raceFirst(
      Stream.fromPubSub(feed.changed).pipe(
        Stream.filter(() => frameOf(feed) !== undefined),
        Stream.runHead,
        Effect.asVoid,
      ),
      ended(feed),
    ).pipe(
      Effect.timeoutOrElse({
        duration: wait,
        orElse: () => failWith("cue", new Timeout({ millis: Duration.toMillis(wait) })),
      }),
    );
  });

// A timer can wake a fraction early; a commit never precedes its event.
const until = (at: number, now: () => number): Effect.Effect<void> =>
  Effect.suspend(() =>
    at > now()
      ? Effect.sleep(Duration.millis(Math.ceil(at - now()))).pipe(Effect.andThen(until(at, now)))
      : Effect.void,
  );

/** Reserve the next turn before waking it; a fresh caller cannot overtake a queued commit. */
const ordered = () => {
  const waiting: Array<Deferred.Deferred<void>> = [];

  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const turn = Deferred.makeUnsafe<void>();

        waiting.push(turn);
        if (waiting.length === 1) Deferred.doneUnsafe(turn, Exit.void);

        return turn;
      }),
      (turn) => Deferred.await(turn).pipe(Effect.andThen(effect)),
      (turn) =>
        Effect.sync(() => {
          const at = waiting.indexOf(turn);

          waiting.splice(at, 1);
          if (at === 0 && waiting[0] !== undefined) Deferred.doneUnsafe(waiting[0], Exit.void);
        }),
    );
};

/** A terminal capture can know the connection is gone before the page receives its close event. */
const confirm = (feed: Feed, frame: Frame) => {
  const exit = feed.fiber?.pollUnsafe();

  const failure =
    exit !== undefined && Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none();

  if (Option.isSome(failure) && consequence(failure.value).lost !== "nothing")
    return Effect.fail(failure.value);

  return feed.capture?.confirm(frame) ?? Effect.succeed(false);
};

/** Each subscriber confirms silence; a new frame or commit invalidates a probe. */
const evidence = (
  output: PubSub.PubSub<Paint>,
  current: () =>
    | { readonly feed: Feed; readonly frame: Frame; readonly changedAt: number }
    | undefined,
  now: () => number,
  hold: Duration.Duration,
): Stream.Stream<Shown, BrowserError> =>
  Stream.unwrap(
    Effect.sync(() => {
      const millis = Duration.toMillis(hold);
      let checkedAt = now();
      let shownAt = Number.NEGATIVE_INFINITY;
      let seen: Pick<Paint, "feed" | "frame"> | undefined = current();
      let gone: Feed | undefined;

      const probe = Effect.gen(function* () {
        yield* until(Math.max(checkedAt, current()?.changedAt ?? checkedAt) + millis, now);
        const before = current();
        const frame = before?.frame;

        // Paint during the wait moves the deadline; an early wake is not a silence check.
        if (before !== undefined && now() - before.changedAt < millis)
          return Option.none<Evidence>();
        checkedAt = now();
        if (before === undefined || frame === undefined || gone === before.feed)
          return Option.none<Evidence>();
        const { feed } = before;

        const confirmed = yield* Effect.result(confirm(feed, frame));

        if (current()?.feed !== feed || current()?.frame !== frame) return Option.none<Evidence>();
        const at = now();

        checkedAt = at;
        if (Result.isFailure(confirmed) && consequence(confirmed.failure).lost !== "nothing") {
          return Option.some<Evidence>({
            feed,
            frame,
            value: { _tag: "Gone", page: feed.page.id, at },
          });
        }

        return Option.some<Evidence>({
          feed,
          frame,
          value: {
            _tag: Result.isSuccess(confirmed) && confirmed.success ? "Still" : "Stalled",
            frame,
            at,
          },
        });
      });

      return Stream.merge(
        Stream.fromPubSub(output).pipe(
          Stream.map(({ feed, frame, at }): Evidence => ({
            feed,
            frame,
            value: { _tag: "Painted", frame, at },
          })),
        ),
        Stream.fromEffectRepeat(probe).pipe(
          Stream.filter(Option.isSome),
          Stream.map(({ value }) => value),
        ),
      ).pipe(
        // A probe can overtake queued paint while its reader is paused. It establishes nothing
        // about that reader's output until the matching frame has reached it.
        Stream.filter(({ feed, frame, value }) => {
          if (value._tag === "Painted" && gone !== feed) {
            seen = { feed, frame };

            return true;
          }
          // The subscription may have begun after its first publication.
          seen ??= { feed, frame };

          return value._tag !== "Painted" && seen?.feed === feed && seen.frame === frame;
        }),
        Stream.map(({ feed, value }) => {
          if (value._tag === "Gone") gone = feed;
          // A frame captured before a silence probe can arrive after the probe's evidence.
          shownAt = Math.max(shownAt, value.at);

          return value.at === shownAt ? value : { ...value, at: shownAt };
        }),
      );
    }),
  );

const openFeed = (
  page: Page,
  owner: Scope.Scope,
  settings: ScreencastOptions,
  current: () => Feed | undefined,
  publish: (feed: Feed, frame: Frame) => Effect.Effect<unknown>,
) =>
  Effect.gen(function* () {
    const scope = yield* Scope.fork(owner);
    const started = yield* Deferred.make<void>();

    const feed: Feed = {
      page,
      capture: undefined,
      scope,
      changed: yield* PubSub.sliding<Frame>({ capacity: 1, replay: 1 }),
      state: Lifecycle.initial,
      fiber: undefined,
    };

    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => {
        update(feed, { _tag: "Stop" });
      }),
    );
    yield* Effect.addFinalizer(() => (current() === feed ? Effect.void : stop(feed)));

    const accept = (frame: Frame) =>
      Effect.gen(function* () {
        const state = yield* page.state;

        if (
          feed.state._tag === "Stopped" ||
          state.page !== frame.page ||
          state.connection !== frame.connection ||
          state.document !== frame.document
        )
          return;
        update(feed, { _tag: "Paint", frame });
        if (current() === feed) yield* publish(feed, frame);
        yield* PubSub.publish(feed.changed, frame);
      });

    const capture = Effect.scoped(
      Effect.gen(function* () {
        update(feed, { _tag: "Reset" });

        const capture = yield* page.capture(settings);

        feed.capture = capture;
        const { stream, current: frame } = capture;

        if (frame !== undefined && capture.isCurrent(frame)) yield* accept(frame);
        yield* Deferred.succeed(started, undefined);
        yield* Stream.runForEach(stream, accept);
      }),
    ).pipe(
      Effect.ensuring(Effect.sync(() => update(feed, { _tag: "Reset" }))),
      Effect.retry({
        while: (error) => feed.state._tag === "Ready" && restartable(error),
        schedule: Schedule.spaced("500 millis"),
      }),
    );

    feed.fiber = yield* capture.pipe(
      Effect.provideService(Clock.Clock, feed.page.clock),
      Effect.forkIn(scope),
    );
    yield* Effect.raceFirst(Deferred.await(started), ended(feed)).pipe(
      Effect.onError(() => stop(feed)),
    );

    return feed;
  });

export const make = Effect.fn("Stage.make")(function* (
  options: Options = {},
): Effect.fn.Return<Stage, BrowserError, Scope.Scope> {
  const chosen = yield* Deferred.make<Clock.Clock>();
  let clock: Clock.Clock | undefined;

  const choose = (page: Page) =>
    Effect.suspend(() => {
      if (clock !== undefined && clock !== page.clock)
        return refuse("stage", "pages presented by one stage must share an owning clock");
      clock ??= page.clock;
      Deferred.doneUnsafe(chosen, Exit.succeed(clock));

      return Effect.void;
    });

  const owner = yield* Effect.scope;
  const now = () => (clock === undefined ? 0 : monotonicMillis(clock));
  const waited = Duration.fromInput(options.firstFrame ?? Duration.seconds(5));

  if (
    Option.isNone(waited) ||
    !Duration.isFinite(waited.value) ||
    !Duration.isPositive(waited.value)
  )
    return yield* refuse("stage", "firstFrame must be a finite positive duration");
  const firstFrame = waited.value;
  const settings = { quality: options.quality, size: options.size };
  const output = yield* PubSub.sliding<Paint>(16);
  const switching = ordered();

  let showing:
    | { readonly feed: Feed; readonly presented: Presented; frame: Frame; changedAt: number }
    | undefined;

  let painted = Number.NEGATIVE_INFINITY;

  yield* Effect.addFinalizer(() => PubSub.shutdown(output));

  const publish = (feed: Feed, frame: Frame, at = frame.hostTime) =>
    Effect.suspend(() => {
      painted = Math.max(painted, at);
      if (showing !== undefined) {
        showing.changedAt = now();
        showing.frame = frame;
      }

      return PubSub.publish(output, { feed, frame, at: painted });
    });

  // Both public entry points reserve a FIFO turn before reading the current feed.
  const commit = (feed: Feed, asked: number) =>
    Effect.gen(function* () {
      if (!Number.isFinite(asked))
        return yield* refuse("cue", "at must be finite host milliseconds");
      yield* firstOf(feed, firstFrame);
      const old = showing;

      if (old?.feed === feed) return old.presented;

      yield* Effect.raceFirst(until(asked, now), ended(feed));

      const switchTo = Effect.suspend(() => {
        const frame = frameOf(feed);

        if (frame === undefined) return Effect.fail(unavailable());
        const at = Math.max(now(), asked, frame.hostTime, painted);

        showing = {
          feed,
          frame,
          presented: new Presented({ page: feed.page.id, at, latency: at - asked }),
          changedAt: at,
        };

        return publish(feed, frame, at).pipe(Effect.as(showing.presented));
      }).pipe(Effect.uninterruptible);

      const readyToSwitch = firstOf(feed, firstFrame).pipe(Effect.andThen(switchTo));

      return yield* (
        old === undefined ? readyToSwitch : old.feed.page.afterInput(readyToSwitch)
      ).pipe(
        // The cut owns old-page input through publication. Capture cleanup has its own bound
        // and must finish even if the caller leaves, without turning a completed cut into Timeout.
        Effect.ensuring(
          Effect.suspend(() =>
            showing?.feed === feed && old !== undefined ? stop(old.feed) : Effect.void,
          ),
        ),
      );
    });

  const cue: Stage["cue"] = (page) =>
    choose(page).pipe(
      Effect.andThen(
        Effect.map(
          openFeed(page, owner, settings, () => showing?.feed, publish),
          (feed) => ({
            page,
            ready: firstOf(feed, firstFrame).pipe(
              Effect.provideService(Clock.Clock, feed.page.clock),
            ),
            commit: (options?: { readonly at?: number | undefined }) =>
              Effect.suspend(() => switching(commit(feed, options?.at ?? now()))).pipe(
                Effect.provideService(Clock.Clock, feed.page.clock),
              ),
          }),
        ),
      ),
    );

  return {
    cue,
    present: (page, options) =>
      choose(page).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            const asked = options?.at ?? now();

            return switching(
              Effect.suspend(() =>
                showing?.feed.page === page
                  ? commit(showing.feed, asked)
                  : Effect.scoped(
                      Effect.flatMap(
                        openFeed(page, owner, settings, () => showing?.feed, publish),
                        (feed) => commit(feed, asked),
                      ),
                    ),
              ),
            );
          }),
        ),
        Effect.provideService(Clock.Clock, page.clock),
      ),
    shown: ({ hold }) => {
      const parsed = Duration.fromInput(hold);

      if (
        Option.isNone(parsed) ||
        !Duration.isFinite(parsed.value) ||
        !Duration.isPositive(parsed.value)
      )
        return Stream.fromEffect(refuse("shown", "hold must be a finite positive duration"));

      return Stream.unwrap(
        Deferred.await(chosen).pipe(
          Effect.map((ownerClock) =>
            evidence(output, () => showing, now, parsed.value).pipe(
              Stream.provideService(Clock.Clock, ownerClock),
            ),
          ),
        ),
      );
    },
    frames: Stream.fromPubSub(output).pipe(Stream.map(({ frame }) => frame)),
    current: Effect.sync(() => Option.fromNullishOr(showing?.feed.page)),
    stats: (options = {}) =>
      showing === undefined
        ? Effect.succeedNone
        : Effect.asSome(showing.feed.page.captureStats({ window: options.window ?? "1 second" })),
  } satisfies Stage;
});
