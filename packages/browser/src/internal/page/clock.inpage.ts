/**
 * In the page's main world, before its own scripts: the page clock, which `PageTime.hold` holds and
 * steps. Until held it keeps real time. Held, the page's timers and intervals, its animation
 * frames, `performance.now`, `Date.now`, `new Date()` and `Date()`, and its CSS transitions, CSS
 * animations and Web Animations move only when stepped: due timers run in time order, each at its
 * own time, animations are moved to each of those times, and then one animation frame runs at the
 * step's end. A timer or frame asked for before the hold waits for page time, and what is left of
 * it goes back to real time on release, when page time carries on from where it was, never back.
 * Workers, media, `requestIdleCallback`, `MessageChannel` and events' `timeStamp` keep real time,
 * as does a frame's document, which keeps its own clock.
 *
 * It listens for one event name, which only the library knows, on the document: the library's
 * isolated world dispatches it with what to do, and the clock acknowledges by preventing its
 * default. Its parts use only their parameters, the DOM and what they define, and the page's
 * globals as they were before the page's scripts ran.
 */

/** The page's timing globals as they were before its scripts ran. */
export interface Real {
  readonly setTimeout: (run: () => void, millis: number) => number;
  readonly clearTimeout: (id: number) => void;
  readonly now: () => number;
}

/** The page's timers and intervals by the ids it holds, each due at a page time. */
export const timers = (
  real: Real,
  now: () => number,
  held: () => boolean,
  report: (error: unknown) => void,
) => {
  interface Timer {
    readonly run: () => void;
    readonly every: number;
    at: number;
    real?: number | undefined;
  }
  const all = new Map<number, Timer>();
  let next = 1;

  const arm = (id: number, timer: Timer) => {
    timer.real = real.setTimeout(
      () => {
        if (all.get(id) === timer && !held()) fire(id, timer);
      },
      Math.max(0, timer.at - now()),
    );
  };

  const fire = (id: number, timer: Timer) => {
    if (timer.every > 0) {
      timer.at = Math.max(timer.at + timer.every, now());
      if (!held()) arm(id, timer);
    } else all.delete(id);
    try {
      timer.run();
    } catch (error) {
      report(error);
    }
  };

  const schedule =
    (every: boolean) =>
    (handler: TimerHandler, delay?: unknown, ...args: Array<unknown>) => {
      const id = next++;
      const millis = Math.max(every ? 1 : 0, Number(delay) || 0);

      const run = () => {
        if (typeof handler === "function") Reflect.apply(handler, window, args);
        // oxlint-disable-next-line no-eval -- the page's own string handler, run globally as its native timer would
        else (0, eval)(handler);
      };

      const timer: Timer = { run, every: every ? millis : 0, at: now() + millis };

      all.set(id, timer);
      if (!held()) arm(id, timer);

      return id;
    };

  const clear = (id: unknown) => {
    const timer = all.get(Number(id));

    if (timer?.real !== undefined) real.clearTimeout(timer.real);
    all.delete(Number(id));
  };

  // Run the first timer due by `target`, once `reach` has taken the page to its time.
  const runDue = (target: number, reach: (at: number) => void) => {
    let due: [number, Timer] | undefined;

    for (const entry of all)
      if (entry[1].at <= target && (due === undefined || entry[1].at < due[1].at)) due = entry;
    if (due === undefined) return false;
    reach(due[1].at);
    fire(...due);

    return true;
  };

  return {
    setTimeout: schedule(false),
    setInterval: schedule(true),
    clear,
    runDue,
    pause: () => {
      for (const timer of all.values()) if (timer.real !== undefined) real.clearTimeout(timer.real);
    },
    resume: () => {
      for (const [id, timer] of all) arm(id, timer);
    },
  };
};

/** The page's animations the clock paused, which it moves and which play again on release. */
export const animations = () => {
  let ours = new WeakSet<Animation>();

  // Every animation the page runs is paused at page time: one the clock has not seen began now.
  const catchUp = () => {
    for (const animation of document.getAnimations())
      if (animation.playState === "running") {
        animation.pause();
        if (!ours.has(animation)) animation.currentTime = 0;
        ours.add(animation);
      }
  };

  const move = (by: number) => {
    if (by <= 0) return;
    for (const animation of document.getAnimations()) {
      if (!ours.has(animation) || animation.playState !== "paused") continue;
      const at = Number(animation.currentTime) + by * animation.playbackRate;
      const end = Number(animation.effect?.getComputedTiming().endTime ?? Infinity);

      if (animation.playbackRate >= 0 ? at >= end : at <= 0) {
        ours.delete(animation);
        animation.finish();
      } else animation.currentTime = at;
    }
  };

  const play = () => {
    for (const animation of document.getAnimations())
      if (ours.has(animation) && animation.playState === "paused") animation.play();
    ours = new WeakSet();
  };

  return { catchUp, move, play };
};

export interface ClockParts {
  readonly timers: typeof timers;
  readonly animations: typeof animations;
}

export const clock = (parts: ClockParts) => (name: string) => {
  if (window !== window.top) return;

  const real = {
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    now: performance.now.bind(performance),
    dateNow: Date.now,
    Date,
  };

  let held = false;
  // Page time while held; otherwise real time moved on by `shift`, so it never goes back. The
  // date is page time from the real date's distance from it when the clock was first held.
  let frozen = 0;
  let shift = 0;
  let dated: number | undefined;
  let nextFrame = 1;
  const pageNow = () => (held ? frozen : real.now() + shift);
  const dateNow = () => (dated === undefined ? real.dateNow() : Math.floor(pageNow() + dated));

  const report = (error: unknown) => {
    real.setTimeout(() => {
      throw error;
    });
  };

  const timed = parts.timers(real, pageNow, () => held, report);
  const animated = parts.animations();

  // Animation frames by the ids the page holds, with their real frame while not held.
  const frames = new Map<number, { readonly run: FrameRequestCallback; real?: number }>();

  const request = (id: number, frame: { readonly run: FrameRequestCallback; real?: number }) => {
    frame.real = real.requestAnimationFrame(() => {
      frames.delete(id);
      frame.run(pageNow());
    });
  };

  // Move the page's animations and time on to `at`.
  const reach = (at: number) => {
    animated.catchUp();
    animated.move(at - frozen);
    frozen = Math.max(frozen, at);
  };

  const hold = () => {
    if (held) return;
    dated ??= real.dateNow() - real.now();
    frozen = pageNow();
    held = true;
    timed.pause();
    for (const frame of frames.values())
      if (frame.real !== undefined) real.cancelAnimationFrame(frame.real);
    animated.catchUp();
  };

  const advance = (by: number) => {
    const target = frozen + by;

    for (let guard = 0; guard < 10_000 && timed.runDue(target, reach); guard++);
    reach(target);
    const callbacks = [...frames.values()];

    frames.clear();
    for (const frame of callbacks)
      try {
        frame.run(frozen);
      } catch (error) {
        report(error);
      }
    animated.catchUp();
  };

  const release = () => {
    if (!held) return;
    held = false;
    shift = Math.max(shift, frozen - real.now());
    timed.resume();
    for (const [id, frame] of frames) request(id, frame);
    animated.play();
  };

  const define = (target: object, key: string, value: unknown) =>
    Object.defineProperty(target, key, { value, writable: true, configurable: true });

  define(window, "setTimeout", timed.setTimeout);
  define(window, "setInterval", timed.setInterval);
  define(window, "clearTimeout", timed.clear);
  define(window, "clearInterval", timed.clear);
  define(window, "requestAnimationFrame", (run: FrameRequestCallback) => {
    const id = nextFrame++;
    const frame = { run };

    frames.set(id, frame);
    if (!held) request(id, frame);

    return id;
  });
  define(window, "cancelAnimationFrame", (id: number) => {
    const frame = frames.get(id);

    if (frame?.real !== undefined) real.cancelAnimationFrame(frame.real);
    frames.delete(id);
  });
  define(performance, "now", pageNow);

  // `Date` reads page time when it is given no time of its own.
  function PageDate(this: unknown, ...args: Array<unknown>) {
    if (new.target === undefined) return new real.Date(dateNow()).toString();

    const made: unknown = Reflect.construct(
      real.Date,
      args.length === 0 ? [dateNow()] : args,
      new.target,
    );

    return made;
  }
  Object.setPrototypeOf(PageDate, real.Date);
  PageDate.prototype = real.Date.prototype;
  define(PageDate, "now", dateNow);
  define(window, "Date", PageDate);

  document.addEventListener(
    name,
    (event) => {
      const detail: unknown = "detail" in event ? event.detail : undefined;
      const op = typeof detail === "object" && detail !== null && "op" in detail ? detail.op : "";

      const by =
        typeof detail === "object" && detail !== null && "by" in detail ? Number(detail.by) : 0;

      if (op === "holds") {
        if (held) event.preventDefault();

        return;
      }
      if (op === "hold" || op === "advance") hold();
      if (op === "advance" && Number.isFinite(by) && by >= 0) advance(by);
      if (op === "release") release();
      event.preventDefault();
    },
    true,
  );
};
